import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import sysPath from 'node:path';
import readdirp from 'readdirp';
import { stat, readdir } from 'node:fs/promises';

import NodeFsHandler from './nodefs-handler.js';
import { anymatch, MatchFunction, isMatcherObject, Matcher } from './anymatch.js';
import { Path, isWindows, isIBMi, EMPTY_FN, STR_CLOSE, STR_END } from './constants.js';
import * as EV from './events.js';
import { EventName } from './events.js';

type ThrottleType = 'readdir' | 'watch' | 'add' | 'remove' | 'change';
type EmitArgs = [EventName, Path, any?, any?, any?];

export const SLASH = '/';
export const SLASH_SLASH = '//';
export const ONE_DOT = '.';
export const TWO_DOTS = '..';
export const STRING_TYPE = 'string';

export const BACK_SLASH_RE = /\\/g;
export const DOUBLE_SLASH_RE = /\/\//;
export const SLASH_OR_BACK_SLASH_RE = /[/\\]/;
export const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
export const REPLACER_RE = /^\.[/\\]/;

const arrify = (value = []) => (Array.isArray(value) ? value : [value]);
const flatten = (list, result = []) => {
  list.forEach((item) => {
    if (Array.isArray(item)) {
      flatten(item, result);
    } else {
      result.push(item);
    }
  });
  return result;
};

const unifyPaths = (paths_) => {
  /**
   * @type {Array<String>}
   */
  const paths = flatten(arrify(paths_));
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};

// If SLASH_SLASH occurs at the beginning of path, it is not replaced
//     because "//StoragePC/DrivePool/Movies" is a valid network path
const toUnix = (string) => {
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
const normalizePathToUnix = (path) => toUnix(sysPath.normalize(toUnix(path)));

const normalizeIgnored =
  (cwd = '') =>
  (path) => {
    if (typeof path !== STRING_TYPE) return path;
    return normalizePathToUnix(sysPath.isAbsolute(path) ? path : sysPath.join(cwd, path));
  };

const getAbsolutePath = (path, cwd) => {
  if (sysPath.isAbsolute(path)) {
    return path;
  }
  return sysPath.join(cwd, path);
};

const undef = (opts, key) => opts[key] === undefined;

/**
 * Directory entry.
 */
class DirEntry {
  path: Path;
  _removeWatcher: any;
  items: Set<Path>;

  constructor(dir: Path, removeWatcher: any) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    /** @type {Set<Path>} */
    this.items = new Set();
  }

  add(item) {
    const { items } = this;
    if (!items) return;
    if (item !== ONE_DOT && item !== TWO_DOTS) items.add(item);
  }

  async remove(item) {
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

  has(item) {
    const { items } = this;
    if (!items) return;
    return items.has(item);
  }

  /**
   * @returns {Array<String>}
   */
  getChildren() {
    const { items } = this;
    if (!items) return;
    return [...items.values()];
  }

  dispose() {
    this.items.clear();
    delete this.path;
    delete this._removeWatcher;
    delete this.items;
    Object.freeze(this);
  }
}

const STAT_METHOD_F = 'stat';
const STAT_METHOD_L = 'lstat';
export class WatchHelper {
  fsw: any;
  path: string;
  watchPath: string;
  fullWatchPath: string;
  dirParts: string[][];
  followSymlinks: boolean;
  statMethod: 'stat' | 'lstat';

  constructor(path: string, follow: boolean, fsw: any) {
    this.fsw = fsw;
    const watchPath = path;
    this.path = path = path.replace(REPLACER_RE, '');
    this.watchPath = watchPath;
    this.fullWatchPath = sysPath.resolve(watchPath);
    /** @type {object|boolean} */
    this.dirParts = [];
    this.dirParts.forEach((parts) => {
      if (parts.length > 1) parts.pop();
    });
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }

  entryPath(entry) {
    return sysPath.join(this.watchPath, sysPath.relative(this.watchPath, entry.fullPath));
  }

  filterPath(entry) {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink()) return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats);
  }

  filterDir(entry) {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
}

export type ChokidarOptions = Partial<{
  persistent: boolean;

  ignored: string | ((path: string) => boolean);
  ignoreInitial: boolean;
  followSymlinks: boolean;
  cwd: string;

  usePolling: boolean;
  interval: number;
  binaryInterval: number;
  enableBinaryInterval: boolean;
  alwaysStat: boolean;
  depth: number;
  awaitWriteFinish:
    | boolean
    | Partial<{
        stabilityThreshold: number;
        pollInterval: number;
      }>;

  ignorePermissionErrors: boolean;
  atomic: boolean | number; // or a custom 'atomicity delay', in milliseconds (default 100)
}>;

export interface FSWInstanceOptions {
  persistent: boolean;

  ignored: Matcher[];
  ignoreInitial: boolean;
  followSymlinks: boolean;
  cwd: string;

  usePolling: boolean;
  interval: number;
  binaryInterval: number;
  enableBinaryInterval: boolean;
  alwaysStat: boolean;
  depth: number;
  awaitWriteFinish:
    | false
    | {
        stabilityThreshold: number;
        pollInterval: number;
      };

  ignorePermissionErrors: boolean;
  atomic: boolean | number; // or a custom 'atomicity delay', in milliseconds (default 100)
}

/**
 * Watches files & directories for changes. Emitted events:
 * `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
 *
 *     new FSWatcher()
 *       .add(directories)
 *       .on('add', path => log('File', path, 'was added'))
 */
export class FSWatcher extends EventEmitter {
  options: FSWInstanceOptions;
  _watched: Map<string, DirEntry>;
  _closers: Map<string, Array<any>>;
  _ignoredPaths: Set<Matcher>;
  _throttled: Map<ThrottleType, Map<any, any>>;
  _symlinkPaths: Map<Path, string | boolean>;
  _streams: Set<any>;
  closed: boolean;

  _pendingWrites: Map<any, any>;
  _pendingUnlinks: Map<any, any>;
  _readyCount: number;
  _emitReady: () => void;
  _closePromise: Promise<void>;
  _userIgnored?: MatchFunction;
  _readyEmitted: boolean;
  _emitRaw: () => void;
  _boundRemove: () => void;

  _nodeFsHandler?: NodeFsHandler;

  // Not indenting methods for history sake; for now.
  constructor(_opts) {
    super();

    const opts: Partial<FSWInstanceOptions> = {};
    if (_opts) Object.assign(opts, _opts); // for frozen objects
    this._watched = new Map();
    this._closers = new Map();
    this._ignoredPaths = new Set<Matcher>();
    this._throttled = new Map();
    this._symlinkPaths = new Map();
    this._streams = new Set();
    this.closed = false;

    // Set up default options.
    if (undef(opts, 'persistent')) opts.persistent = true;
    if (undef(opts, 'ignoreInitial')) opts.ignoreInitial = false;
    if (undef(opts, 'ignorePermissionErrors')) opts.ignorePermissionErrors = false;
    if (undef(opts, 'interval')) opts.interval = 100;
    if (undef(opts, 'binaryInterval')) opts.binaryInterval = 300;
    opts.enableBinaryInterval = opts.binaryInterval !== opts.interval;

    // Always default to polling on IBM i because fs.watch() is not available on IBM i.
    if (isIBMi) {
      opts.usePolling = true;
    }

    // Global override (useful for end-developers that need to force polling for all
    // instances of chokidar, regardless of usage/dependency depth)
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== undefined) {
      const envLower = envPoll.toLowerCase();

      if (envLower === 'false' || envLower === '0') {
        opts.usePolling = false;
      } else if (envLower === 'true' || envLower === '1') {
        opts.usePolling = true;
      } else {
        opts.usePolling = !!envLower;
      }
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval) {
      opts.interval = Number.parseInt(envInterval, 10);
    }

    // Editor atomic write normalization enabled by default with fs.watch
    if (undef(opts, 'atomic')) opts.atomic = !opts.usePolling;
    if (opts.atomic) this._pendingUnlinks = new Map();

    if (undef(opts, 'followSymlinks')) opts.followSymlinks = true;

    if (undef(opts, 'awaitWriteFinish')) opts.awaitWriteFinish = false;
    if ((opts.awaitWriteFinish as any) === true || typeof opts.awaitWriteFinish === 'object') {
      // opts.awaitWriteFinish = {};
      const awf = opts.awaitWriteFinish;
      if (awf) {
        this._pendingWrites = new Map();
        const st = typeof awf === 'object' && awf.stabilityThreshold;
        const pi = typeof awf === 'object' && awf.pollInterval;
        opts.awaitWriteFinish = {
          stabilityThreshold: st || 2000,
          pollInterval: pi || 100,
        };
      }
    }
    if (opts.ignored) opts.ignored = arrify(opts.ignored);

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
    this._readyEmitted = false;
    this.options = opts as FSWInstanceOptions;

    // Initialize with proper watcher.
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
   * Adds paths to be watched on an existing FSWatcher instance
   * @param {Path|Array<Path>} paths_
   * @param {String=} _origAdd private; for handling non-existent paths to be watched
   * @param {Boolean=} _internal private; indicates a non-user add
   * @returns {FSWatcher} for chaining
   */
  add(paths_: Path | Path[], _origAdd?: string, _internal?: boolean) {
    const { cwd } = this.options;
    this.closed = false;
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
      results
        .filter((item) => item)
        .forEach((item) => {
          this.add(sysPath.dirname(item), sysPath.basename(_origAdd || item));
        });
    });

    return this;
  }

  /**
   * Close watchers or start ignoring events from specified paths.
   * @param {Path|Array<Path>} paths_ - string or array of strings, file/directory paths
   * @returns {FSWatcher} for chaining
   */
  unwatch(paths_: Path | Path[]) {
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
   * @returns {Promise<void>}.
   */
  close() {
    if (this.closed) return this._closePromise;
    this.closed = true;

    // Memory management.
    this.removeAllListeners();
    const closers = [];
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
    ['closers', 'watched', 'streams', 'symlinkPaths', 'throttled'].forEach((key) => {
      this[`_${key}`].clear();
    });

    this._closePromise = closers.length
      ? Promise.all(closers).then(() => undefined)
      : Promise.resolve();
    return this._closePromise;
  }

  /**
   * Expose list of watched paths
   * @returns {Object} for chaining
   */
  getWatched() {
    const watchList = {};
    this._watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sysPath.relative(this.options.cwd, dir) : dir;
      watchList[key || ONE_DOT] = entry.getChildren().sort();
    });
    return watchList;
  }

  emitWithAll(event: EventName, args: EmitArgs) {
    this.emit(...args);
    if (event !== EV.ERROR) this.emit(EV.ALL, ...args);
  }

  // Common helpers
  // --------------

  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @param {EventName} event Type of event
   * @param {Path} path File or directory path
   * @param {*=} val1 arguments to be passed with event
   * @param {*=} val2
   * @param {*=} val3
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  async _emit(event: EventName, path: Path, val1?: any, val2?: any, val3?: any) {
    if (this.closed) return;

    const opts = this.options;
    if (isWindows) path = sysPath.normalize(path);
    if (opts.cwd) path = sysPath.relative(opts.cwd, path);
    /** @type Array<any> */
    const args: EmitArgs = [event, path];
    if (val3 !== undefined) args.push(val1, val2, val3);
    else if (val2 !== undefined) args.push(val1, val2);
    else if (val1 !== undefined) args.push(val1);

    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this._pendingWrites.get(path))) {
      pw.lastChange = new Date();
      return this;
    }

    if (opts.atomic) {
      if (event === EV.UNLINK) {
        this._pendingUnlinks.set(path, args);
        setTimeout(
          () => {
            this._pendingUnlinks.forEach((entry: EmitArgs, path: Path) => {
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
        event = args[0] = EV.CHANGE;
        this._pendingUnlinks.delete(path);
      }
    }

    if (awf && (event === EV.ADD || event === EV.CHANGE) && this._readyEmitted) {
      const awfEmit = (err, stats) => {
        if (err) {
          event = args[0] = EV.ERROR;
          args[1] = err;
          this.emitWithAll(event, args);
        } else if (stats) {
          // if stats doesn't exist the file must have been deleted
          if (args.length > 2) {
            args[2] = stats;
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
      val1 === undefined &&
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
   * @param {Error} error
   * @returns {Error|Boolean} The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  _handleError(error) {
    const code = error && error.code;
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
   * @param {ThrottleType} actionType type being throttled
   * @param {Path} path being acted upon
   * @param {Number} timeout duration of time to suppress duplicate actions
   * @returns {Object|false} tracking object or false if action should be suppressed
   */
  _throttle(actionType, path, timeout) {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, new Map());
    }

    /** @type {Map<Path, Object>} */
    const action = this._throttled.get(actionType);
    /** @type {Object} */
    const actionPath = action.get(path);

    if (actionPath) {
      actionPath.count++;
      return false;
    }

    // eslint-disable-next-line prefer-const
    let timeoutObject;
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

  _incrReadyCount() {
    return this._readyCount++;
  }

  /**
   * Awaits write operation to finish.
   * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
   * @param {Path} path being acted upon
   * @param {Number} threshold Time in milliseconds a file size must be fixed before acknowledging write OP is finished
   * @param {EventName} event
   * @param {Function} awfEmit Callback to be called when ready for event to be emitted.
   */
  _awaitWriteFinish(path: Path, threshold: number, event: EventName, awfEmit: any) {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== 'object') return;
    let timeoutHandler;

    let fullPath = path;
    if (this.options.cwd && !sysPath.isAbsolute(path)) {
      fullPath = sysPath.join(this.options.cwd, path);
    }

    const now = new Date();

    const awaitWriteFinish = (prevStat) => {
      fs.stat(fullPath, (err, curStat) => {
        if (err || !this._pendingWrites.has(path)) {
          if (err && err.code !== 'ENOENT') awfEmit(err);
          return;
        }

        const now = Number(new Date());

        if (prevStat && curStat.size !== prevStat.size) {
          this._pendingWrites.get(path).lastChange = now;
        }
        const pw = this._pendingWrites.get(path);
        const df = now - pw.lastChange;

        if (df >= threshold) {
          this._pendingWrites.delete(path);
          awfEmit(undefined, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinish, awf.pollInterval, curStat);
        }
      });
    };

    if (!this._pendingWrites.has(path)) {
      this._pendingWrites.set(path, {
        lastChange: now,
        cancelWait: () => {
          this._pendingWrites.delete(path);
          clearTimeout(timeoutHandler);
          return event;
        },
      });
      timeoutHandler = setTimeout(awaitWriteFinish, awf.pollInterval);
    }
  }

  /**
   * Determines whether user has asked to ignore this path.
   * @param {Path} path filepath or dir
   * @param {fs.Stats=} stats result of fs.stat
   * @returns {Boolean}
   */
  _isIgnored(path: Path, stats?: fs.Stats) {
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

  _isntIgnored(path, stat?: fs.Stats) {
    return !this._isIgnored(path, stat);
  }

  /**
   * Provides a set of common helpers and properties relating to symlink and glob handling.
   * @param {Path} path file, directory, or glob pattern being watched
   * @returns {WatchHelper} object containing helpers for this path
   */
  _getWatchHelpers(path: string): WatchHelper {
    return new WatchHelper(path, this.options.followSymlinks, this);
  }

  // Directory helpers
  // -----------------

  /**
   * Provides directory tracking objects
   * @param {String} directory path of the directory
   * @returns {DirEntry} the directory's tracking object
   */
  _getWatchedDir(directory: string) {
    if (!this._boundRemove) this._boundRemove = this._remove.bind(this);
    const dir = sysPath.resolve(directory);
    if (!this._watched.has(dir)) this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir);
  }

  // File helpers
  // ------------

  /**
   * Check for read permissions.
   * Based on this answer on SO: https://stackoverflow.com/a/11781404/1358405
   * @param stats - object, result of fs_stat
   * @returns indicates whether the file can be read
   */
  _hasReadPermissions(stats: fs.Stats): boolean {
    if (this.options.ignorePermissionErrors) return true;

    // stats.mode may be bigint
    const md = stats && Number.parseInt(stats.mode as any, 10);
    const st = md & 0o777;
    const it = Number.parseInt(st.toString(8)[0], 10);
    return Boolean(4 & it);
  }

  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param {String} directory within which the following item is located
   * @param {String} item      base path of item/directory
   * @returns {void}
   */
  _remove(directory: string, item: string, isDirectory?: boolean) {
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
   * @param {Path} path
   */
  _closePath(path) {
    this._closeFile(path);
    const dir = sysPath.dirname(path);
    this._getWatchedDir(dir).remove(sysPath.basename(path));
  }

  /**
   * Closes only file-specific watchers
   * @param {Path} path
   */
  _closeFile(path) {
    const closers = this._closers.get(path);
    if (!closers) return;
    closers.forEach((closer) => closer());
    this._closers.delete(path);
  }

  /**
   *
   * @param {Path} path
   * @param {Function} closer
   */
  _addPathCloser(path, closer) {
    if (!closer) return;
    let list = this._closers.get(path);
    if (!list) {
      list = [];
      this._closers.set(path, list);
    }
    list.push(closer);
  }

  _readdirp(root, opts) {
    if (this.closed) return;
    const options = { type: EV.ALL, alwaysStat: true, lstat: true, ...opts };
    let stream = readdirp(root, options);
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

// Export FSWatcher class
// exports.FSWatcher = FSWatcher;

/**
 * Instantiates watcher with paths to be tracked.
 * @param {String|Array<String>} paths file/directory paths and/or globs
 * @param {Object=} options chokidar opts
 * @returns an instance of FSWatcher for chaining.
 */
export const watch = (paths, options) => {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
};

export default { watch, FSWatcher };
