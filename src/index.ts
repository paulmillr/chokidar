/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
import { EventEmitter } from 'node:events';
import { realpathSync, type Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as sp from 'node:path';
import { readdirp, type ReaddirpOptions, ReaddirpStream } from 'readdirp';
import { selectBackend } from './backend.js';
import { EventPolicy } from './policy.js';
import { ObservationEngine } from './reconcile.js';
import {
  type ChokidarOptions,
  cloneOwnedMatcher,
  compileMatchers,
  type EmitArgs,
  EVENTS as EV,
  type EventName,
  type FSWInstanceOptions,
  isIBMi,
  isMatcherObject,
  isMissingError,
  isPermissionError,
  isSameOrInside,
  isStrictlyInside,
  isWindows,
  logicalPathKey,
  type Matcher,
  type MatchFunction,
  normalizeMatcher,
  normalizePath,
  type Path,
  type Scheduler,
  systemScheduler,
  type WatchBackend,
  type WatchHandlers,
  WatchHelper,
} from './runtime.js';
import { LifecycleScope, ReconciliationQueue, TreeState, type WatcherContext } from './tree.js';

export type {
  AWF,
  BackendStrategy,
  ChokidarOptions,
  EmitArgs,
  EmitArgsWithName,
  EmitErrorArgs,
  FSWInstanceOptions,
  Matcher,
  MatcherObject,
  MatchFunction,
  Scheduler,
  SchedulerTimer,
  Throttler,
  ThrottleType,
  WatchBackend
} from './runtime.js';

const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
const WATCH_BACKENDS = new Set<WatchBackend>(['auto', 'native', 'native-recursive', 'polling']);

function arrify<T>(item: T | T[]): T[] {
  return Array.isArray(item) ? item : [item];
}

function unifyPaths(paths_: Path | Path[]) {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === 'string')) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePath);
}

function getAbsolutePath(path: Path, cwd: Path) {
  if (sp.isAbsolute(path)) {
    return path;
  }
  return sp.join(cwd, path);
}

function validatePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite number greater than zero`);
  }
}

function validateNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function validateOptions(opts: FSWInstanceOptions): void {
  validatePositiveFinite('pollingInterval', opts.pollingInterval);
  validatePositiveFinite('pollingBinaryInterval', opts.pollingBinaryInterval);
  if (typeof opts.atomic === 'number') validateNonNegativeFinite('atomic', opts.atomic);
  else if (typeof opts.atomic !== 'boolean') {
    throw new TypeError('atomic must be a boolean or finite non-negative number');
  }
  if (opts.depth !== undefined && (!Number.isSafeInteger(opts.depth) || opts.depth < 0)) {
    throw new TypeError('depth must be a non-negative safe integer');
  }
  if (opts.awaitWriteFinish) {
    validatePositiveFinite('awaitWriteFinish.pollInterval', opts.awaitWriteFinish.pollInterval);
    validateNonNegativeFinite(
      'awaitWriteFinish.stabilityThreshold',
      opts.awaitWriteFinish.stabilityThreshold
    );
  }
}

export interface FSWatcherEventMap {
  [EV.READY]: [];
  [EV.RAW]: Parameters<WatchHandlers['rawEmitter']>;
  [EV.ERROR]: Parameters<WatchHandlers['errHandler']>;
  [EV.ALL]: [event: EventName, ...EmitArgs];
  [EV.ADD]: EmitArgs;
  [EV.CHANGE]: EmitArgs;
  [EV.ADD_DIR]: EmitArgs;
  [EV.UNLINK]: EmitArgs;
  [EV.UNLINK_DIR]: EmitArgs;
}

/**
 * Watches files & directories for changes. Emitted events:
 * `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
 *
 *     new FSWatcher()
 *       .add(directories)
 *       .on('add', path => log('File', path, 'was added'))
 */
export class FSWatcher extends EventEmitter<FSWatcherEventMap> {
  options: FSWInstanceOptions;
  private lifecycle: LifecycleScope;
  private tree: TreeState;
  private reconciliation: ReconciliationQueue;
  private events: EventPolicy;

  get closed(): boolean {
    return this.lifecycle !== undefined && this.lifecycle.state !== 'OPEN';
  }

  private ignoredPaths: Set<Matcher>;
  private streams: Set<ReaddirpStream>;

  private pendingAdds: Map<string, symbol>;
  private pathMutation: number;
  private pathBarriers: Map<string, number>;
  private closePromise?: Promise<void>;
  private userIgnored?: MatchFunction;
  private unwatchIgnored?: MatchFunction;
  private readyEmitted: boolean;
  private readyPending: boolean;
  private readyScheduled: boolean;
  private emitRaw: WatchHandlers['rawEmitter'];
  private handler: ObservationEngine;
  private scheduler: Scheduler;

  // Not indenting methods for history sake; for now.
  constructor(_opts: ChokidarOptions = {}, scheduler: Scheduler = systemScheduler) {
    super();

    if (_opts.backend !== undefined && !WATCH_BACKENDS.has(_opts.backend)) {
      throw new TypeError('backend must be auto, native, native-recursive, or polling');
    }

    this.ignoredPaths = new Set<Matcher>();
    this.streams = new Set();

    this.pendingAdds = new Map();
    this.pathMutation = 0;
    this.pathBarriers = new Map();
    this.readyEmitted = false;
    this.readyPending = false;
    this.readyScheduled = false;
    this.scheduler = scheduler;
    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2000, pollInterval: 100 };
    const opts: FSWInstanceOptions = {
      ..._opts,
      // Defaults
      persistent: _opts.persistent ?? true,
      ignoreInitial: _opts.ignoreInitial ?? false,
      ignorePermissionErrors: _opts.ignorePermissionErrors ?? false,
      pollingInterval: _opts.pollingInterval ?? _opts.interval ?? 100,
      pollingBinaryInterval: _opts.pollingBinaryInterval ?? _opts.binaryInterval ?? 300,
      interval: 100,
      binaryInterval: 300,
      followSymlinks: _opts.followSymlinks ?? true,
      backend: _opts.backend ?? 'auto',
      usePolling: _opts.usePolling ?? false,
      // `undefined` already means unlimited traversal. Preserve the common
      // `depth: Infinity` spelling without forcing the per-directory backend.
      depth: _opts.depth === Number.POSITIVE_INFINITY ? undefined : _opts.depth,
      backendStrategy: 'native-per-directory',
      backendCapabilities: undefined as never,
      // useAsync: false,
      atomic: _opts.atomic ?? true,
      // Change format
      ignored: Object.freeze(_opts.ignored ? arrify(_opts.ignored).map(cloneOwnedMatcher) : []),
      awaitWriteFinish:
        awf === true
          ? Object.freeze({ ...DEF_AWF })
          : typeof awf === 'object'
            ? Object.freeze({ ...DEF_AWF, ...awf })
            : false,
    };

    // Always default to polling on IBM i because fs.watch() is not available on IBM i.
    if (_opts.usePolling === true || isIBMi) opts.backend = 'polling';
    // Global override. Useful for developers, who need to force polling for all
    // instances of chokidar, regardless of usage / dependency depth
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== undefined) {
      const envLower = envPoll.toLowerCase();
      const envPolling =
        envLower === 'false' || envLower === '0'
          ? false
          : envLower === 'true' || envLower === '1'
            ? true
            : !!envLower;
      if (envPolling) opts.backend = 'polling';
      else if (opts.backend === 'polling') opts.backend = 'auto';
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval !== undefined) opts.pollingInterval = Number(envInterval);
    // Preserve resolved values for callers that still read the deprecated fields.
    opts.interval = opts.pollingInterval;
    opts.binaryInterval = opts.pollingBinaryInterval;
    opts.usePolling = opts.backend === 'polling';
    opts.backendCapabilities = selectBackend(opts);
    opts.backendStrategy = opts.backendCapabilities.kind;
    // Editor atomic write normalization is enabled by default only with fs.watch.
    // Inspect the raw option so the merged default cannot hide an implicit choice.
    if (_opts.atomic === undefined) opts.atomic = !opts.usePolling;
    validateOptions(opts);
    this.emitRaw = (...args) => {
      if (!this.closed) this.emit(EV.RAW, ...args);
    };

    this.options = opts;
    this.lifecycle = new LifecycleScope(
      () => {
        if (this.readyPending) this.queueReady();
      },
      (error) => {
        if (!this.closed)
          this.handleError(error instanceof Error ? error : new Error(String(error)));
      }
    );
    this.tree = new TreeState(() => !this.options.backendCapabilities.polling);
    this.reconciliation = new ReconciliationQueue(this.lifecycle);
    this.events = new EventPolicy({
      options: this.options,
      scheduler: this.scheduler,
      lifecycle: this.lifecycle,
      isClosed: () => this.closed,
      capturePathGeneration: () => this.capturePathGeneration(),
      isPathGenerationActive: (path, generation) => this.isPathGenerationActive(path, generation),
      isReady: () => this.readyEmitted,
      remove: (directory, item) => this.removePath(directory, item),
      handleError: (error) => this.handleError(error),
      publish: (event, args) => this.emitWithAll(event, args as EmitArgs),
    });
    void this.emitRaw;
    void this.createHelper;
    void this.addPathCloser;
    void this.createScanStream;
    this.handler = new ObservationEngine(this as unknown as WatcherContext);
    // You’re frozen when your heart’s not open.
    Object.freeze(opts);
  }

  private addIgnoredPath(matcher: Matcher): void {
    matcher = this.ignoredMatcher(matcher);
    if (isMatcherObject(matcher)) {
      // return early if we already have a deeply equal matcher object
      for (const ignored of this.ignoredPaths) {
        if (
          isMatcherObject(ignored) &&
          ignored.path === matcher.path &&
          ignored.recursive === matcher.recursive
        ) {
          return;
        }
      }
    }

    this.ignoredPaths.add(matcher);
    this.unwatchIgnored = undefined;
  }

  private removeIgnoredPath(matcher: Matcher): void {
    matcher = this.ignoredMatcher(matcher);
    this.ignoredPaths.delete(matcher);

    // now find any matcher objects with the matcher as path
    if (typeof matcher === 'string') {
      for (const ignored of this.ignoredPaths) {
        // TODO (43081j): make this more efficient.
        // probably just make a `this._ignoredDirectories` or some
        // such thing.
        if (isMatcherObject(ignored) && ignored.path === matcher) {
          this.ignoredPaths.delete(ignored);
        }
      }
    }
    this.unwatchIgnored = undefined;
  }

  private ignoredMatcher(matcher: Matcher): Matcher {
    if (typeof matcher === 'string') return logicalPathKey(matcher);
    if (isMatcherObject(matcher)) {
      return { path: logicalPathKey(matcher.path), recursive: matcher.recursive };
    }
    return matcher;
  }

  private capturePathGeneration(): number {
    return this.pathMutation;
  }

  private invalidatePath(path: Path): void {
    this.pathBarriers.set(logicalPathKey(path), ++this.pathMutation);
  }

  private isPathGenerationActive(path: Path, generation: number): boolean {
    if (this.lifecycle.state !== 'OPEN') return false;
    if (this.pathBarriers.size === 0) return true;
    const logicalKey = logicalPathKey(path);
    for (const [barrier, barrierGeneration] of this.pathBarriers) {
      if (barrierGeneration <= generation) continue;
      if (isSameOrInside(barrier, logicalKey)) return false;
    }
    return true;
  }

  private queueReady(): void {
    if (this.closed || this.readyEmitted) return;
    this.readyPending = true;
    if (this.lifecycle.tasks.size > 0 || this.readyScheduled) return;
    this.readyScheduled = true;
    process.nextTick(() => {
      this.readyScheduled = false;
      if (this.closed || this.readyEmitted || this.lifecycle.tasks.size > 0) return;
      this.readyPending = false;
      this.readyEmitted = true;
      this.emit(EV.READY);
    });
  }

  // Public methods

  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list
   */
  add(paths_: Path | Path[]): FSWatcher {
    if (this.closed) {
      throw new Error('Cannot add paths after FSWatcher.close() has been called');
    }
    const { cwd } = this.options;
    let paths = unifyPaths(paths_);
    if (cwd) {
      paths = paths.map((path) => {
        const absPath = getAbsolutePath(path, cwd);

        // Check `path` instead of `absPath` because the cwd portion can't be a glob
        return absPath;
      });
    }

    paths.forEach((path) => {
      this.removeIgnoredPath(path);
    });

    if (!this.readyEmitted) this.readyPending = true;
    const addTask = Promise.all(
      paths.map(async (path) => {
        const key = logicalPathKey(path);
        if (this.lifecycle.closers.has(key) || this.pendingAdds.has(key)) return;
        const pendingToken = Symbol(key);
        const pathGeneration = this.capturePathGeneration();
        this.pendingAdds.set(key, pendingToken);
        try {
          await this.handler.addRoot(path, true, pathGeneration);
        } finally {
          if (this.pendingAdds.get(key) === pendingToken) this.pendingAdds.delete(key);
        }
      })
    );
    this.lifecycle.track(addTask);
    if (!this.readyEmitted) this.queueReady();

    return this;
  }

  /**
   * Close watchers or start ignoring events from specified paths.
   */
  unwatch(paths_: Path | Path[]): FSWatcher {
    if (this.closed) return this;
    let paths = unifyPaths(paths_);
    const { cwd } = this.options;
    if (cwd) paths = paths.map((path) => getAbsolutePath(path, cwd));

    paths.forEach((path) => {
      const key = logicalPathKey(path);
      const isDirectory = this.tree.watched.has(key);

      this.invalidatePath(key);
      this.pendingAdds.delete(key);
      this.events.cancelPath(key);
      this.closePath(key, isDirectory);

      this.addIgnoredPath(key);
      if (isDirectory) {
        this.addIgnoredPath({
          path: key,
          recursive: true,
        });
      }

      this.unwatchIgnored = undefined;
    });

    return this;
  }

  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const closers = this.lifecycle.beginClose();

    // Memory management.
    this.removeAllListeners();
    this.events.close();
    this.pendingAdds.clear();
    this.streams.forEach((stream) => stream.destroy());
    this.userIgnored = undefined;
    this.unwatchIgnored = undefined;
    this.readyEmitted = false;
    this.tree.dispose();
    this.pathBarriers.clear();
    this.streams.clear();
    this.reconciliation.clear();

    this.closePromise = (async () => {
      const closerResults = await Promise.allSettled(closers);
      await this.lifecycle.drain();
      this.lifecycle.finishClose();
      const failed = closerResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failed) throw failed.reason;
    })();
    return this.closePromise;
  }

  /**
   * Expose list of watched paths
   * @returns for chaining
   */
  getWatched(): Record<string, string[]> {
    const watchList: Record<string, string[]> = {};
    this.tree.watched.forEach((entry) => {
      const dir = entry.path;
      const key = this.options.cwd ? sp.relative(this.options.cwd, dir) : dir;
      const index = key || '.';
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }

  private emitWithAll(event: EventName, args: EmitArgs): void {
    this.emit(event, ...args);
    if (event !== EV.ERROR) this.emit(EV.ALL, event, ...args);
  }

  // Common helpers
  // --------------

  /**
   * Normalize and emit events.
   * Calling emitEvent DOES NOT MEAN emit() would be called!
   * @param event Type of event
   * @param path File or directory path
   * @param stats arguments to be passed with event
   */
  private async emitEvent(event: EventName, path: Path, stats?: Stats): Promise<void> {
    if (this.closed) return;
    await this.events.emit(event, path, stats);
  }

  /** Common handler for backend and reconciliation failures. */
  private handleError(error: unknown): void {
    if (this.closed) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (
      !isMissingError(normalized) &&
      (!this.options.ignorePermissionErrors || !isPermissionError(normalized))
    ) {
      this.emit(EV.ERROR, normalized);
    }
  }

  /**
   * Determines whether user has asked to ignore this path.
   */
  private isIgnored(path: Path, stats?: Stats): boolean {
    if (this.options.atomic && DOT_RE.test(path)) return true;
    if (!this.userIgnored) {
      const { cwd } = this.options;
      const ign = this.options.ignored;

      const ignored = (ign || []).map((matcher) => normalizeMatcher(matcher, cwd));
      const direct = compileMatchers(ignored);
      const pathMatchers = ignored.filter(
        (matcher) => typeof matcher === 'string' || isMatcherObject(matcher)
      );
      const canonical = compileMatchers(pathMatchers);
      const pathAliases = new Map<string, string>();
      this.userIgnored = (candidate, candidateStats) => {
        if (direct(candidate, candidateStats)) return true;
        if (isWindows || pathMatchers.length === 0) return false;

        const absoluteCandidate = sp.resolve(candidate);
        for (const [alias, realPath] of pathAliases) {
          const relative = sp.relative(alias, absoluteCandidate);
          if (isSameOrInside(alias, absoluteCandidate)) {
            return canonical(sp.join(realPath, relative), candidateStats);
          }
        }
        try {
          // macOS commonly exposes /var through the /private/var symlink. Cache
          // the root projection so descendants avoid a realpath syscall each.
          const realPath = realpathSync.native(absoluteCandidate);
          pathAliases.set(absoluteCandidate, realPath);
          return realPath !== absoluteCandidate && canonical(realPath, candidateStats);
        } catch {
          return false;
        }
      };
    }
    if (this.userIgnored(path, stats)) return true;
    if (this.ignoredPaths.size === 0) return false;
    if (!this.unwatchIgnored) {
      this.unwatchIgnored = compileMatchers([...this.ignoredPaths]);
    }

    return this.unwatchIgnored(logicalPathKey(path), stats);
  }

  private isUnwatched(path: Path): boolean {
    if (this.ignoredPaths.size === 0) return false;
    if (!this.unwatchIgnored) {
      this.unwatchIgnored = compileMatchers([...this.ignoredPaths]);
    }
    return this.unwatchIgnored(logicalPathKey(path));
  }

  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   * @param path file or directory pattern being watched
   */
  private createHelper(path: Path): WatchHelper {
    return new WatchHelper(path, this.options.followSymlinks, {
      capturePathGeneration: () => this.capturePathGeneration(),
      isntIgnored: (candidate, stats) => !this.isIgnored(candidate, stats),
    });
  }

  private removeTreeItem(directory: string, item: string): void {
    const entry = this.tree.getDirectory(directory);
    if (!entry.remove(item)) return;
    const path = entry.path;
    const generation = this.lifecycle.generation;
    this.lifecycle.track(
      (async () => {
        try {
          await readdir(path);
        } catch {
          if (this.lifecycle.isActive(generation)) {
            this.removePath(sp.dirname(path), sp.basename(path));
          }
        }
      })()
    );
  }

  // File helpers
  // ------------

  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  private removePath(directory: string, item: string, isDirectory?: boolean): void {
    // if what is being deleted is a directory, get that directory's paths
    // for recursive deleting and cleaning of watched object
    // if it is not a directory, nestedDirectoryChildren will be empty array
    const path = sp.join(directory, item);
    const logicalKey = logicalPathKey(path);
    isDirectory = isDirectory != null ? isDirectory : this.tree.watched.has(logicalKey);

    // prevent duplicate handling in case of arriving here nearly simultaneously
    // via multiple paths (such as handleFile and handleDirectory)
    if (!this.events.throttle('remove', path, 100)) return;

    // if the only watched file is removed, watch for its return
    if (!isDirectory && this.tree.watched.size === 1) {
      this.lifecycle.track(
        this.handler.addRoot(directory, false, this.capturePathGeneration(), item)
      );
    }

    // This will create a new entry in the watched object in either case
    // so we got to do the directory check beforehand
    const wp = this.tree.getDirectory(path);
    const nestedDirectoryChildren = wp.getChildren();

    // Recursively remove children directories / files.
    nestedDirectoryChildren.forEach((nested) => this.removePath(path, nested));

    // Check if item was on the watched list and remove it
    const parent = this.tree.getDirectory(directory);
    const wasTracked = parent.has(item);
    this.removeTreeItem(directory, item);

    // Fixes issue #1042 -> Relative paths were detected and added as symlinks
    // (https://github.com/paulmillr/chokidar/blob/e1753ddbc9571bdc33b4a4af172d52cb6e611c10/lib/nodefs-handler.js#L612),
    // but never removed from the map in case the path was deleted.
    // This leads to an incorrect state if the path was recreated:
    // https://github.com/paulmillr/chokidar/blob/e1753ddbc9571bdc33b4a4af172d52cb6e611c10/lib/nodefs-handler.js#L553
    if (this.tree.symlinkPaths.has(logicalKey)) {
      this.tree.symlinkPaths.delete(logicalKey);
    }

    // If we wait for this file to be fully written, cancel the wait.
    const pendingWrite = this.events.pendingWrites.get(logicalKey);
    let suppressEvent = false;
    if (this.options.awaitWriteFinish && pendingWrite) {
      const event = pendingWrite.cancelWait();
      suppressEvent = event === EV.ADD;
    }

    // The Entry will either be a directory that just got removed
    // or a bogus entry to a file, in either case we have to remove it
    this.tree.watched.delete(logicalKey);
    this.tree.observed.delete(logicalKey);
    const eventName: EventName = isDirectory ? EV.UNLINK_DIR : EV.UNLINK;
    if (wasTracked && !suppressEvent && !this.isIgnored(path)) this.emitEvent(eventName, path);

    // Avoid conflicts if we later create another file with the same name
    this.closePath(path);
  }

  /**
   * Closes all watchers for a path
   */
  private closePath(path: Path, recursive = false): void {
    const logicalKey = logicalPathKey(path);
    const contains = (candidate: string): boolean => {
      if (candidate === logicalKey) return true;
      if (!recursive) return false;
      return isStrictlyInside(logicalKey, candidate);
    };

    [...this.lifecycle.closers.keys()].filter(contains).forEach((key) => this.closeFile(key));
    if (recursive) {
      [...this.tree.watched.entries()].forEach(([key, entry]) => {
        if (!contains(key)) return;
        entry.dispose();
        this.tree.watched.delete(key);
      });
      [...this.tree.observed.keys()]
        .filter(contains)
        .forEach((key) => this.tree.observed.delete(key));
      [...this.tree.symlinkPaths.keys()]
        .filter(contains)
        .forEach((key) => this.tree.symlinkPaths.delete(key));
      this.events.cancelWhere(contains);
      this.reconciliation.forgetPending(
        (scope, candidate) => contains(scope) || contains(candidate)
      );
      [...this.pendingAdds.keys()].filter(contains).forEach((key) => this.pendingAdds.delete(key));
    }
    const dir = sp.dirname(logicalKey);
    this.removeTreeItem(dir, sp.basename(logicalKey));
  }

  /**
   * Closes only file-specific watchers
   */
  private closeFile(path: Path): void {
    const key = logicalPathKey(path);
    const closers = this.lifecycle.takeClosers(key);
    if (closers.length === 0) return;
    closers.forEach((closer) => {
      try {
        const result = closer();
        if (result instanceof Promise) this.lifecycle.track(result);
      } catch (error) {
        this.lifecycle.track(Promise.reject(error));
      }
    });
  }

  private addPathCloser(path: Path, closer: () => void | Promise<void>): void {
    if (!closer) return;
    if (this.closed || this.isUnwatched(path)) {
      try {
        const result = closer();
        if (result instanceof Promise) this.lifecycle.track(result);
      } catch (error) {
        this.lifecycle.track(Promise.reject(error));
      }
      return;
    }
    const key = logicalPathKey(path);
    this.lifecycle.addCloser(key, closer);
  }

  private createScanStream(
    root: Path,
    opts?: Partial<ReaddirpOptions>
  ): ReaddirpStream | undefined {
    if (this.closed) return;
    const options = { type: EV.ALL, alwaysStat: true, lstat: true, depth: 0, ...opts };
    const stream = readdirp(root, options);
    this.streams.add(stream);
    const finalize = () => this.streams.delete(stream);
    stream.once('close', finalize);
    stream.once('end', finalize);
    stream.once(EV.ERROR, finalize);
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
