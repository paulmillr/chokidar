/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
import { stat as statcb, Stats } from 'fs';
import { stat, readdir } from 'fs/promises';
import { EventEmitter } from 'events';
import * as sysPath from 'path';
import { readdirp, ReaddirpStream, ReaddirpOptions, EntryInfo } from 'readdirp';
import {
  NodeFsHandler,
  EventName,
  Path,
  EVENTS as EV,
  isWindows,
  isIBMi,
  EMPTY_FN,
  STR_CLOSE,
  STR_END,
  WatchHandlers,
} from './handler.js';

type AWF = {
  stabilityThreshold: number;
  pollInterval: number;
};

type BasicOpts = {
  persistent: boolean;
  ignoreInitial: boolean;
  followSymlinks: boolean;
  cwd?: string;
  // Polling
  usePolling: boolean;
  interval: number;
  binaryInterval: number; // Used only for pooling and if different from interval

  alwaysStat?: boolean;
  depth?: number;
  ignorePermissionErrors: boolean;
  atomic: boolean | number; // or a custom 'atomicity delay', in milliseconds (default 100)
  // useAsync?: boolean; // Use async for stat/readlink methods

  // ioLimit?: number; // Limit parallel IO operations (CPU usage + OS limits)
};

export type Throttler = {
  timeoutObject: NodeJS.Timeout;
  clear: () => void;
  count: number;
};

export type ChokidarOptions = Partial<
  BasicOpts & {
    ignored: Matcher | Matcher[];
    awaitWriteFinish: boolean | Partial<AWF>;
  }
>;

export type FSWInstanceOptions = BasicOpts & {
  ignored: Matcher[]; // string | fn ->
  awaitWriteFinish: false | AWF;
};

export type ThrottleType = 'readdir' | 'watch' | 'add' | 'remove' | 'change';
export type EmitArgs = [path: Path, stats?: Stats];
export type EmitErrorArgs = [error: Error, stats?: Stats];
export type EmitArgsWithName = [event: EventName, ...EmitArgs];
export type MatchFunction = (val: string, stats?: Stats) => boolean;
export interface MatcherObject {
  path: string;
  recursive?: boolean;
}
export type Matcher = string | RegExp | MatchFunction | MatcherObject;

const SLASH = '/';
const SLASH_SLASH = '//';
const ONE_DOT = '.';
const TWO_DOTS = '..';
const STRING_TYPE = 'string';
const BACK_SLASH_RE = /\\/g;
const DOUBLE_SLASH_RE = /\/\//;
const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
const REPLACER_RE = /^\.[/\\]/;

function arrify<T>(item: T | T[]): T[] {
  return Array.isArray(item) ? item : [item];
}

const isMatcherObject = (matcher: Matcher): matcher is MatcherObject =>
  typeof matcher === 'object' && matcher !== null && !(matcher instanceof RegExp);

function createPattern(matcher: Matcher): MatchFunction {
  if (typeof matcher === 'function') return matcher;
  if (typeof matcher === 'string') return (string) => matcher === string;
  if (matcher instanceof RegExp) return (string) => matcher.test(string);
  if (typeof matcher === 'object' && matcher !== null) {
    return (string) => {
      if (matcher.path === string) return true;
      if (matcher.recursive) {
        const relative = sysPath.relative(matcher.path, string);
        if (!relative) {
          return false;
        }
        return !relative.startsWith('..') && !sysPath.isAbsolute(relative);
      }
      return false;
    };
  }
  return () => false;
}

function normalizePath(path: Path): Path {
  if (typeof path !== 'string') throw new Error('string expected');
  path = sysPath.normalize(path);
  path = path.replace(/\\/g, '/');
  let prepend = false;
  if (path.startsWith('//')) prepend = true;
  const DOUBLE_SLASH_RE = /\/\//;
  while (path.match(DOUBLE_SLASH_RE)) path = path.replace(DOUBLE_SLASH_RE, '/');
  if (prepend) path = '/' + path;
  return path;
}

function matchPatterns(patterns: MatchFunction[], testString: string, stats?: Stats): boolean {
  const path = normalizePath(testString);

  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path, stats)) {
      return true;
    }
  }

  return false;
}

function anymatch(matchers: Matcher[], testString: undefined): MatchFunction;
function anymatch(matchers: Matcher[], testString: string): boolean;
function anymatch(matchers: Matcher[], testString: string | undefined): boolean | MatchFunction {
  if (matchers == null) {
    throw new TypeError('anymatch: specify first argument');
  }

  // Early cache for matchers.
  const matchersArray = arrify(matchers);
  const patterns = matchersArray.map((matcher) => createPattern(matcher));

  if (testString == null) {
    return (testString: string, stats?: Stats): boolean => {
      return matchPatterns(patterns, testString, stats);
    };
  }

  return matchPatterns(patterns, testString);
}

const unifyPaths = (paths_: Path | Path[]) => {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};

// If SLASH_SLASH occurs at the beginning of path, it is not replaced
//     because "//StoragePC/DrivePool/Movies" is a valid network path
const toUnix = (string: string) => {
  let str = string.replace(BACK_SLASH_RE, SLASH);
  let prepend = false;
  if (str.startsWith(SLASH_SLASH)) {
    prepend = true;
  }
  while (str.match(DOUBLE_SLASH_RE)) {
    str = str.replace(DOUBLE_SLASH_RE, SLASH);
  }
  if (prepend) {
    str = SLASH + str;
  }
  return str;
};

// Our version of upath.normalize
// TODO: this is not equal to path-normalize module - investigate why
const normalizePathToUnix = (path: Path) => toUnix(sysPath.normalize(toUnix(path)));

// TODO: refactor
const normalizeIgnored =
  (cwd = '') =>
  (path: unknown): string => {
    if (typeof path === 'string') {
      return normalizePathToUnix(sysPath.isAbsolute(path) ? path : sysPath.join(cwd, path));
    } else {
      return path as string;
    }
  };

const getAbsolutePath = (path: Path, cwd: Path) => {
  if (sysPath.isAbsolute(path)) {
    return path;
  }
  return sysPath.join(cwd, path);
};

const EMPTY_SET = Object.freeze(new Set<string>());
/**
 * Directory entry.
 */
class DirEntry {
  path: Path;
  _removeWatcher: (dir: string, base: string) => void;
  items: Set<Path>;

  constructor(dir: Path, removeWatcher: (dir: string, base: string) => void) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    this.items = new Set<Path>();
  }

  add(item: string): void {
    const { items } = this;
    if (!items) return;
    if (item !== ONE_DOT && item !== TWO_DOTS) items.add(item);
  }

  async remove(item: string): Promise<void> {
    const { items } = this;
    if (!items) return;
    items.delete(item);
    if (items.size > 0) return;

    const dir = this.path;
    try {
      await readdir(dir);
    } catch (err) {
      if (this._removeWatcher) {
        this._removeWatcher(sysPath.dirname(dir), sysPath.basename(dir));
      }
    }
  }

  has(item: string): boolean | undefined {
    const { items } = this;
    if (!items) return;
    return items.has(item);
  }

  getChildren(): string[] {
    const { items } = this;
    if (!items) return [];
    return [...items.values()];
  }

  dispose(): void {
    this.items.clear();
    this.path = '';
    this._removeWatcher = EMPTY_FN;
    this.items = EMPTY_SET;
    Object.freeze(this);
  }
}

const STAT_METHOD_F = 'stat';
const STAT_METHOD_L = 'lstat';
export class WatchHelper {
  fsw: FSWatcher;
  path: string;
  watchPath: string;
  fullWatchPath: string;
  dirParts: string[][];
  followSymlinks: boolean;
  statMethod: 'stat' | 'lstat';

  constructor(path: string, follow: boolean, fsw: FSWatcher) {
    this.fsw = fsw;
    const watchPath = path;
    this.path = path = path.replace(REPLACER_RE, '');
    this.watchPath = watchPath;
    this.fullWatchPath = sysPath.resolve(watchPath);
    this.dirParts = [];
    this.dirParts.forEach((parts) => {
      if (parts.length > 1) parts.pop();
    });
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }

  entryPath(entry: EntryInfo): Path {
    return sysPath.join(this.watchPath, sysPath.relative(this.watchPath, entry.fullPath));
  }

  filterPath(entry: EntryInfo): boolean {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink()) return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    // TODO: what if stats is undefined? remove !
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats!);
  }

  filterDir(entry: EntryInfo): boolean {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
}

export interface FSWatcherKnownEventMap {
  [EV.READY]: [];
  [EV.RAW]: Parameters<WatchHandlers['rawEmitter']>;
  [EV.ERROR]: Parameters<WatchHandlers['errHandler']>;
  [EV.ALL]: [event: EventName, ...EmitArgs];
}

export type FSWatcherEventMap = FSWatcherKnownEventMap & {
  [k in Exclude<EventName, keyof FSWatcherKnownEventMap>]: EmitArgs;
};

/**
 * Watches files & directories for changes. Emitted events:
 * `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
 *
 *     new FSWatcher()
 *       .add(directories)
 *       .on('add', path => log('File', path, 'was added'))
 */
export class FSWatcher extends EventEmitter<FSWatcherEventMap> {
  closed: boolean;
  options: FSWInstanceOptions;

  _closers: Map<string, Array<any>>;
  _ignoredPaths: Set<Matcher>;
  _throttled: Map<ThrottleType, Map<any, any>>;
  _streams: Set<ReaddirpStream>;
  _symlinkPaths: Map<Path, string | boolean>;
  _watched: Map<string, DirEntry>;

  _pendingWrites: Map<string, any>;
  _pendingUnlinks: Map<string, EmitArgsWithName>;
  _readyCount: number;
  _emitReady: () => void;
  _closePromise?: Promise<void>;
  _userIgnored?: MatchFunction;
  _readyEmitted: boolean;
  _emitRaw: WatchHandlers['rawEmitter'];
  _boundRemove: (dir: string, item: string) => void;

  _nodeFsHandler: NodeFsHandler;

  // Not indenting methods for history sake; for now.
  constructor(_opts: ChokidarOptions = {}) {
    super();
    this.closed = false;

    this._closers = new Map();
    this._ignoredPaths = new Set<Matcher>();
    this._throttled = new Map();
    this._streams = new Set();
    this._symlinkPaths = new Map();
    this._watched = new Map();

    this._pendingWrites = new Map();
    this._pendingUnlinks = new Map();
    this._readyCount = 0;
    this._readyEmitted = false;

    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2000, pollInterval: 100 };
    const opts: FSWInstanceOptions = {
      // Defaults
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: false,
      interval: 100,
      binaryInterval: 300,
      followSymlinks: true,
      usePolling: false,
      // useAsync: false,
      atomic: true, // NOTE: overwritten later (depends on usePolling)
      ..._opts,
      // Change format
      ignored: _opts.ignored ? arrify(_opts.ignored) : arrify([]),
      awaitWriteFinish:
        awf === true ? DEF_AWF : typeof awf === 'object' ? { ...DEF_AWF, ...awf } : false,
    };

    // Always default to polling on IBM i because fs.watch() is not available on IBM i.
    if (isIBMi) opts.usePolling = true;
    // Editor atomic write normalization enabled by default with fs.watch
    if (opts.atomic === undefined) opts.atomic = !opts.usePolling;
    // opts.atomic = typeof _opts.atomic === 'number' ? _opts.atomic : 100;
    // Global override. Useful for developers, who need to force polling for all
    // instances of chokidar, regardless of usage / dependency depth
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== undefined) {
      const envLower = envPoll.toLowerCase();
      if (envLower === 'false' || envLower === '0') opts.usePolling = false;
      else if (envLower === 'true' || envLower === '1') opts.usePolling = true;
      else opts.usePolling = !!envLower;
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval) opts.interval = Number.parseInt(envInterval, 10);
    // This is done to emit ready only once, but each 'add' will increase that?
    let readyCalls = 0;
    this._emitReady = () => {
      readyCalls++;
      if (readyCalls >= this._readyCount) {
        this._emitReady = EMPTY_FN;
        this._readyEmitted = true;
        // use process.nextTick to allow time for listener to be bound
        process.nextTick(() => this.emit(EV.READY));
      }
    };
    this._emitRaw = (...args) => this.emit(EV.RAW, ...args);

    this._boundRemove = this._remove.bind(this);

    this.options = opts;
    this._nodeFsHandler = new NodeFsHandler(this);
    // You’re frozen when your heart’s not open.
    Object.freeze(opts);
  }

  _addIgnoredPath(matcher: Matcher): void {
    if (isMatcherObject(matcher)) {
      // return early if we already have a deeply equal matcher object
      for (const ignored of this._ignoredPaths) {
        if (
          isMatcherObject(ignored) &&
          ignored.path === matcher.path &&
          ignored.recursive === matcher.recursive
        ) {
          return;
        }
      }
    }

    this._ignoredPaths.add(matcher);
  }

  _removeIgnoredPath(matcher: Matcher): void {
    this._ignoredPaths.delete(matcher);

    // now find any matcher objects with the matcher as path
    if (typeof matcher === 'string') {
      for (const ignored of this._ignoredPaths) {
        // TODO (43081j): make this more efficient.
        // probably just make a `this._ignoredDirectories` or some
        // such thing.
        if (isMatcherObject(ignored) && ignored.path === matcher) {
          this._ignoredPaths.delete(ignored);
        }
      }
    }
  }

  // Public methods

  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list. Other arguments are unused
   */
  add(paths_: Path | Path[], _origAdd?: string, _internal?: boolean): FSWatcher {
    const { cwd } = this.options;
    this.closed = false;
    this._closePromise = undefined;
    let paths = unifyPaths(paths_);
    if (cwd) {
      paths = paths.map((path) => {
        const absPath = getAbsolutePath(path, cwd);

        // Check `path` instead of `absPath` because the cwd portion can't be a glob
        return absPath;
      });
    }

    paths.forEach((path) => {
      this._removeIgnoredPath(path);
    });

    this._userIgnored = undefined;

    if (!this._readyCount) this._readyCount = 0;
    this._readyCount += paths.length;
    Promise.all(
      paths.map(async (path) => {
        const res = await this._nodeFsHandler._addToNodeFs(
          path,
          !_internal,
          undefined,
          0,
          _origAdd
        );
        if (res) this._emitReady();
        return res;
      })
    ).then((results) => {
      if (this.closed) return;
      results.forEach((item) => {
        if (item) this.add(sysPath.dirname(item), sysPath.basename(_origAdd || item));
      });
    });

    return this;
  }

  /**
   * Close watchers or start ignoring events from specified paths.
   */
  unwatch(paths_: Path | Path[]): FSWatcher {
    if (this.closed) return this;
    const paths = unifyPaths(paths_);
    const { cwd } = this.options;

    paths.forEach((path) => {
      // convert to absolute path unless relative path already matches
      if (!sysPath.isAbsolute(path) && !this._closers.has(path)) {
        if (cwd) path = sysPath.join(cwd, path);
        path = sysPath.resolve(path);
      }

      this._closePath(path);

      this._addIgnoredPath(path);
      if (this._watched.has(path)) {
        this._addIgnoredPath({
          path,
          recursive: true,
        });
      }

      // reset the cached userIgnored anymatch fn
      // to make ignoredPaths changes effective
      this._userIgnored = undefined;
    });

    return this;
  }

  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }
    this.closed = true;

    // Memory management.
    this.removeAllListeners();
    const closers: Array<Promise<void>> = [];
    this._closers.forEach((closerList) =>
      closerList.forEach((closer) => {
        const promise = closer();
        if (promise instanceof Promise) closers.push(promise);
      })
    );
    this._streams.forEach((stream) => stream.destroy());
    this._userIgnored = undefined;
    this._readyCount = 0;
    this._readyEmitted = false;
    this._watched.forEach((dirent) => dirent.dispose());

    this._closers.clear();
    this._watched.clear();
    this._streams.clear();
    this._symlinkPaths.clear();
    this._throttled.clear();

    this._closePromise = closers.length
      ? Promise.all(closers).then(() => undefined)
      : Promise.resolve();
    return this._closePromise;
  }

  /**
   * Expose list of watched paths
   * @returns for chaining
   */
  getWatched(): Record<string, string[]> {
    const watchList: Record<string, string[]> = {};
    this._watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sysPath.relative(this.options.cwd, dir) : dir;
      const index = key || ONE_DOT;
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }

  emitWithAll(event: EventName, args: EmitArgs): void {
    this.emit(event, ...args);
    if (event !== EV.ERROR) this.emit(EV.ALL, event, ...args);
  }

  // Common helpers
  // --------------

  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @param event Type of event
   * @param path File or directory path
   * @param stats arguments to be passed with event
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  async _emit(event: EventName, path: Path, stats?: Stats): Promise<this | undefined> {
    if (this.closed) return;

    const opts = this.options;
    if (isWindows) path = sysPath.normalize(path);
    if (opts.cwd) path = sysPath.relative(opts.cwd, path);
    const args: EmitArgs | EmitErrorArgs = [path];
    if (stats != null) args.push(stats);

    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this._pendingWrites.get(path))) {
      pw.lastChange = new Date();
      return this;
    }

    if (opts.atomic) {
      if (event === EV.UNLINK) {
        this._pendingUnlinks.set(path, [event, ...args]);
        setTimeout(
          () => {
            this._pendingUnlinks.forEach((entry: EmitArgsWithName, path: Path) => {
              this.emit(...entry);
              this.emit(EV.ALL, ...entry);
              this._pendingUnlinks.delete(path);
            });
          },
          typeof opts.atomic === 'number' ? opts.atomic : 100
        );
        return this;
      }
      if (event === EV.ADD && this._pendingUnlinks.has(path)) {
        event = EV.CHANGE;
        this._pendingUnlinks.delete(path);
      }
    }

    if (awf && (event === EV.ADD || event === EV.CHANGE) && this._readyEmitted) {
      const awfEmit = (err?: Error, stats?: Stats) => {
        if (err) {
          event = EV.ERROR;
          (args as unknown as EmitErrorArgs)[0] = err;
          this.emitWithAll(event, args);
        } else if (stats) {
          // if stats doesn't exist the file must have been deleted
          if (args.length > 1) {
            args[1] = stats;
          } else {
            args.push(stats);
          }
          this.emitWithAll(event, args);
        }
      };

      this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
      return this;
    }

    if (event === EV.CHANGE) {
      const isThrottled = !this._throttle(EV.CHANGE, path, 50);
      if (isThrottled) return this;
    }

    if (
      opts.alwaysStat &&
      stats === undefined &&
      (event === EV.ADD || event === EV.ADD_DIR || event === EV.CHANGE)
    ) {
      const fullPath = opts.cwd ? sysPath.join(opts.cwd, path) : path;
      let stats;
      try {
        stats = await stat(fullPath);
      } catch (err) {
        // do nothing
      }
      // Suppress event when fs_stat fails, to avoid sending undefined 'stat'
      if (!stats || this.closed) return;
      args.push(stats);
    }
    this.emitWithAll(event, args);

    return this;
  }

  /**
   * Common handler for errors
   * @returns The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  _handleError(error: Error): Error | boolean {
    const code = error && (error as Error & { code: string }).code;
    if (
      error &&
      code !== 'ENOENT' &&
      code !== 'ENOTDIR' &&
      (!this.options.ignorePermissionErrors || (code !== 'EPERM' && code !== 'EACCES'))
    ) {
      this.emit(EV.ERROR, error);
    }
    return error || this.closed;
  }

  /**
   * Helper utility for throttling
   * @param actionType type being throttled
   * @param path being acted upon
   * @param timeout duration of time to suppress duplicate actions
   * @returns tracking object or false if action should be suppressed
   */
  _throttle(actionType: ThrottleType, path: Path, timeout: number): Throttler | false {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, new Map());
    }

    const action = this._throttled.get(actionType);
    if (!action) throw new Error('invalid throttle');
    const actionPath = action.get(path);

    if (actionPath) {
      actionPath.count++;
      return false;
    }

    // eslint-disable-next-line prefer-const
    let timeoutObject: NodeJS.Timeout;
    const clear = () => {
      const item = action.get(path);
      const count = item ? item.count : 0;
      action.delete(path);
      clearTimeout(timeoutObject);
      if (item) clearTimeout(item.timeoutObject);
      return count;
    };
    timeoutObject = setTimeout(clear, timeout);
    const thr = { timeoutObject, clear, count: 0 };
    action.set(path, thr);
    return thr;
  }

  _incrReadyCount(): number {
    return this._readyCount++;
  }

  /**
   * Awaits write operation to finish.
   * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
   * @param path being acted upon
   * @param threshold Time in milliseconds a file size must be fixed before acknowledging write OP is finished
   * @param event
   * @param awfEmit Callback to be called when ready for event to be emitted.
   */
  _awaitWriteFinish(
    path: Path,
    threshold: number,
    event: EventName,
    awfEmit: (err?: Error, stat?: Stats) => void
  ): void {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== 'object') return;
    const pollInterval = awf.pollInterval as unknown as number;
    let timeoutHandler: NodeJS.Timeout;

    let fullPath = path;
    if (this.options.cwd && !sysPath.isAbsolute(path)) {
      fullPath = sysPath.join(this.options.cwd, path);
    }

    const now = new Date();

    const writes = this._pendingWrites;
    function awaitWriteFinishFn(prevStat?: Stats): void {
      statcb(fullPath, (err, curStat) => {
        if (err || !writes.has(path)) {
          if (err && err.code !== 'ENOENT') awfEmit(err);
          return;
        }

        const now = Number(new Date());

        if (prevStat && curStat.size !== prevStat.size) {
          writes.get(path).lastChange = now;
        }
        const pw = writes.get(path);
        const df = now - pw.lastChange;

        if (df >= threshold) {
          writes.delete(path);
          awfEmit(undefined, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval, curStat);
        }
      });
    }

    if (!writes.has(path)) {
      writes.set(path, {
        lastChange: now,
        cancelWait: () => {
          writes.delete(path);
          clearTimeout(timeoutHandler);
          return event;
        },
      });
      timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval);
    }
  }

  /**
   * Determines whether user has asked to ignore this path.
   */
  _isIgnored(path: Path, stats?: Stats): boolean {
    if (this.options.atomic && DOT_RE.test(path)) return true;
    if (!this._userIgnored) {
      const { cwd } = this.options;
      const ign = this.options.ignored;

      const ignored = (ign || []).map(normalizeIgnored(cwd));
      const ignoredPaths = [...this._ignoredPaths];
      const list: Matcher[] = [...ignoredPaths.map(normalizeIgnored(cwd)), ...ignored];
      this._userIgnored = anymatch(list, undefined);
    }

    return this._userIgnored(path, stats);
  }

  _isntIgnored(path: Path, stat?: Stats): boolean {
    return !this._isIgnored(path, stat);
  }

  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   * @param path file or directory pattern being watched
   */
  _getWatchHelpers(path: Path): WatchHelper {
    return new WatchHelper(path, this.options.followSymlinks, this);
  }

  // Directory helpers
  // -----------------

  /**
   * Provides directory tracking objects
   * @param directory path of the directory
   */
  _getWatchedDir(directory: string): DirEntry {
    const dir = sysPath.resolve(directory);
    if (!this._watched.has(dir)) this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir)!;
  }

  // File helpers
  // ------------

  /**
   * Check for read permissions: https://stackoverflow.com/a/11781404/1358405
   */
  _hasReadPermissions(stats: Stats): boolean {
    if (this.options.ignorePermissionErrors) return true;
    return Boolean(Number(stats.mode) & 0o400);
  }

  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  _remove(directory: string, item: string, isDirectory?: boolean): void {
    // if what is being deleted is a directory, get that directory's paths
    // for recursive deleting and cleaning of watched object
    // if it is not a directory, nestedDirectoryChildren will be empty array
    const path = sysPath.join(directory, item);
    const fullPath = sysPath.resolve(path);
    isDirectory =
      isDirectory != null ? isDirectory : this._watched.has(path) || this._watched.has(fullPath);

    // prevent duplicate handling in case of arriving here nearly simultaneously
    // via multiple paths (such as _handleFile and _handleDir)
    if (!this._throttle('remove', path, 100)) return;

    // if the only watched file is removed, watch for its return
    if (!isDirectory && this._watched.size === 1) {
      this.add(directory, item, true);
    }

    // This will create a new entry in the watched object in either case
    // so we got to do the directory check beforehand
    const wp = this._getWatchedDir(path);
    const nestedDirectoryChildren = wp.getChildren();

    // Recursively remove children directories / files.
    nestedDirectoryChildren.forEach((nested) => this._remove(path, nested));

    // Check if item was on the watched list and remove it
    const parent = this._getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.remove(item);

    // Fixes issue #1042 -> Relative paths were detected and added as symlinks
    // (https://github.com/paulmillr/chokidar/blob/e1753ddbc9571bdc33b4a4af172d52cb6e611c10/lib/nodefs-handler.js#L612),
    // but never removed from the map in case the path was deleted.
    // This leads to an incorrect state if the path was recreated:
    // https://github.com/paulmillr/chokidar/blob/e1753ddbc9571bdc33b4a4af172d52cb6e611c10/lib/nodefs-handler.js#L553
    if (this._symlinkPaths.has(fullPath)) {
      this._symlinkPaths.delete(fullPath);
    }

    // If we wait for this file to be fully written, cancel the wait.
    let relPath = path;
    if (this.options.cwd) relPath = sysPath.relative(this.options.cwd, path);
    if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
      const event = this._pendingWrites.get(relPath).cancelWait();
      if (event === EV.ADD) return;
    }

    // The Entry will either be a directory that just got removed
    // or a bogus entry to a file, in either case we have to remove it
    this._watched.delete(path);
    this._watched.delete(fullPath);
    const eventName: EventName = isDirectory ? EV.UNLINK_DIR : EV.UNLINK;
    if (wasTracked && !this._isIgnored(path)) this._emit(eventName, path);

    // Avoid conflicts if we later create another file with the same name
    this._closePath(path);
  }

  /**
   * Closes all watchers for a path
   */
  _closePath(path: Path): void {
    this._closeFile(path);
    const dir = sysPath.dirname(path);
    this._getWatchedDir(dir).remove(sysPath.basename(path));
  }

  /**
   * Closes only file-specific watchers
   */
  _closeFile(path: Path): void {
    const closers = this._closers.get(path);
    if (!closers) return;
    closers.forEach((closer) => closer());
    this._closers.delete(path);
  }

  _addPathCloser(path: Path, closer: () => void): void {
    if (!closer) return;
    let list = this._closers.get(path);
    if (!list) {
      list = [];
      this._closers.set(path, list);
    }
    list.push(closer);
  }

  _readdirp(root: Path, opts?: Partial<ReaddirpOptions>): ReaddirpStream | undefined {
    if (this.closed) return;
    const options = { type: EV.ALL, alwaysStat: true, lstat: true, ...opts, depth: 0 };
    let stream: ReaddirpStream | undefined = readdirp(root, options);
    this._streams.add(stream);
    stream.once(STR_CLOSE, () => {
      stream = undefined;
    });
    stream.once(STR_END, () => {
      if (stream) {
        this._streams.delete(stream);
        stream = undefined;
      }
    });
    return stream;
  }
}

/**
 * Instantiates watcher with paths to be tracked.
 * @param paths file / directory paths
 * @param options opts, such as `atomic`, `awaitWriteFinish`, `ignored`, and others
 * @returns an instance of FSWatcher for chaining.
 * @example
 * const watcher = watch('.').on('all', (event, path) => { console.log(event, path); });
 * watch('.', { atomic: true, awaitWriteFinish: true, ignored: (f, stats) => stats?.isFile() && !f.endsWith('.js') })
 */
export function watch(paths: string | string[], options: ChokidarOptions = {}): FSWatcher {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}

export default { watch: watch as typeof watch, FSWatcher: FSWatcher as typeof FSWatcher };
