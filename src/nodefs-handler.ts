import fs from 'fs';
import sysPath from 'path';
import isBinaryPath from 'is-binary-path';
import {
  Path,
  isWindows,
  isLinux,
  isMacos,
  EMPTY_FN,
  EMPTY_STR,
  KEY_LISTENERS,
  KEY_ERR,
  KEY_RAW,
  HANDLER_KEYS,
  STR_DATA,
  STR_END,
  BRACE_START,
  STAR,
} from './constants.js';
import * as EV from './events.js';
import type { FSWatcher, WatchHelper, FSWInstanceOptions } from './index.js';
import { open, stat, lstat, realpath as fsrealpath } from 'node:fs/promises';

const THROTTLE_MODE_WATCH = 'watch';

const statMethods = { lstat, stat };

// TODO: emit errors properly. Example: EMFILE on Macos.
const foreach = (val, fn) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};

const addAndConvert = (main, prop, item) => {
  let container = main[prop];
  if (!(container instanceof Set)) main[prop] = container = new Set([container]);
  container.add(item);
};

const clearItem = (cont) => (key) => {
  const set = cont[key];
  if (set instanceof Set) set.clear();
  else delete cont[key];
};

const delFromSet = (main, prop, item) => {
  const container = main[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete main[prop];
  }
};

const isEmptySet = (val) => (val instanceof Set ? val.size === 0 : !val);

/**
 * @typedef {String} Path
 */

// fs_watch helpers

// object to hold per-process fs_watch instances
// (may be shared across chokidar FSWatcher instances)

/**
 * @typedef {Object} FsWatchContainer
 * @property {Set} listeners
 * @property {Set} errHandlers
 * @property {Set} rawEmitters
 * @property {fs.FSWatcher=} watcher
 * @property {Boolean=} watcherUnusable
 */

/**
 * @type {Map<String,FsWatchContainer>}
 */
const FsWatchInstances = new Map();

/**
 * Instantiates the fs_watch interface
 * @param {String} path to be watched
 * @param {Object} options to be passed to fs_watch
 * @param {Function} listener main event handler
 * @param {Function} errHandler emits info about errors
 * @param {Function} emitRaw emits raw event data
 * @returns {fs.FSWatcher} new fsevents instance
 */
function createFsWatchInstance(
  path: string,
  options: Partial<FSWInstanceOptions>,
  listener: WatchHandlers['listener'],
  errHandler: WatchHandlers['errHandler'],
  emitRaw: WatchHandlers['rawEmitter']
) {
  const handleEvent: fs.WatchListener<string> = (rawEvent, evPath) => {
    listener(path);
    emitRaw(rawEvent, evPath, { watchedPath: path });

    // emit based on events occurring for files from a directory's watcher in
    // case the file's watcher misses it (and rely on throttling to de-dupe)
    if (evPath && path !== evPath) {
      fsWatchBroadcast(sysPath.resolve(path, evPath), KEY_LISTENERS, sysPath.join(path, evPath));
    }
  };
  try {
    return fs.watch(
      path,
      {
        persistent: options.persistent,
      },
      handleEvent
    );
  } catch (error) {
    errHandler(error);
  }
}

/**
 * Helper for passing fs_watch event data to a collection of listeners
 * @param {Path} fullPath absolute path bound to fs_watch instance
 * @param {String} type listener type
 * @param {*=} val1 arguments to be passed to listeners
 * @param {*=} val2
 * @param {*=} val3
 */
const fsWatchBroadcast = (fullPath: Path, type: string, val1?: any, val2?: any, val3?: any) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont) return;
  foreach(cont[type], (listener) => {
    listener(val1, val2, val3);
  });
};

interface WatchHandlers {
  listener: (path: string) => void;
  errHandler: (err: unknown) => void;
  rawEmitter: (ev: fs.WatchEventType, path: string, opts: unknown) => void;
}

/**
 * Instantiates the fs_watch interface or binds listeners
 * to an existing one covering the same file system entry
 * @param {String} path
 * @param {String} fullPath absolute path
 * @param {Object} options to be passed to fs_watch
 * @param {Object} handlers container for event listener functions
 */
const setFsWatchListener = (
  path: string,
  fullPath: string,
  options: Partial<FSWInstanceOptions>,
  handlers: WatchHandlers
) => {
  const { listener, errHandler, rawEmitter } = handlers;
  let cont = FsWatchInstances.get(fullPath);

  /** @type {fs.FSWatcher=} */
  let watcher: fs.FSWatcher;
  if (!options.persistent) {
    watcher = createFsWatchInstance(path, options, listener, errHandler, rawEmitter);
    return watcher.close.bind(watcher);
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_ERR, errHandler);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    watcher = createFsWatchInstance(
      path,
      options,
      fsWatchBroadcast.bind(null, fullPath, KEY_LISTENERS),
      errHandler, // no need to use broadcast here
      fsWatchBroadcast.bind(null, fullPath, KEY_RAW)
    );
    if (!watcher) return;
    watcher.on(EV.ERROR, async (error) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      cont.watcherUnusable = true; // documented since Node 10.4.1
      // Workaround for https://github.com/joyent/node/issues/4337
      if (isWindows && error.code === 'EPERM') {
        try {
          const fd = await open(path, 'r');
          await fd.close();
          broadcastErr(error);
        } catch (err) {
          // do nothing
        }
      } else {
        broadcastErr(error);
      }
    });
    cont = {
      listeners: listener,
      errHandlers: errHandler,
      rawEmitters: rawEmitter,
      watcher,
    };
    FsWatchInstances.set(fullPath, cont);
  }
  // const index = cont.listeners.indexOf(listener);

  // removes this instance's listeners and closes the underlying fs_watch
  // instance if there are no more listeners left
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_ERR, errHandler);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      // Check to protect against issue gh-730.
      // if (cont.watcherUnusable) {
      cont.watcher.close();
      // }
      FsWatchInstances.delete(fullPath);
      HANDLER_KEYS.forEach(clearItem(cont));
      cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};

// fs_watchFile helpers

// object to hold per-process fs_watchFile instances
// (may be shared across chokidar FSWatcher instances)
const FsWatchFileInstances = new Map();

/**
 * Instantiates the fs_watchFile interface or binds listeners
 * to an existing one covering the same file system entry
 * @param {String} path to be watched
 * @param {String} fullPath absolute path
 * @param {Object} options options to be passed to fs_watchFile
 * @param {Object} handlers container for event listener functions
 * @returns {Function} closer
 */
const setFsWatchFileListener = (path, fullPath, options, handlers) => {
  const { listener, rawEmitter } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);

  // let listeners = new Set();
  // let rawEmitters = new Set();

  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent || copts.interval > options.interval)) {
    // "Upgrade" the watcher to persistence or a quicker interval.
    // This creates some unlikely edge case issues if the user mixes
    // settings in a very weird way, but solving for those cases
    // doesn't seem worthwhile for the added complexity.
    // listeners = cont.listeners;
    // rawEmitters = cont.rawEmitters;
    fs.unwatchFile(fullPath);
    cont = undefined;
  }

  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    // TODO
    // listeners.add(listener);
    // rawEmitters.add(rawEmitter);
    cont = {
      listeners: listener,
      rawEmitters: rawEmitter,
      options,
      watcher: fs.watchFile(fullPath, options, (curr, prev) => {
        foreach(cont.rawEmitters, (rawEmitter) => {
          rawEmitter(EV.CHANGE, fullPath, { curr, prev });
        });
        const currmtime = curr.mtimeMs;
        if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
          foreach(cont.listeners, (listener) => listener(path, curr));
        }
      }),
    };
    FsWatchFileInstances.set(fullPath, cont);
  }
  // const index = cont.listeners.indexOf(listener);

  // Removes this instance's listeners and closes the underlying fs_watchFile
  // instance if there are no more listeners left.
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      FsWatchFileInstances.delete(fullPath);
      fs.unwatchFile(fullPath);
      cont.options = cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};

/**
 * @mixin
 */
export default class NodeFsHandler {
  fsw: FSWatcher;
  _boundHandleError: any;
  /**
   * @param {import("../index").FSWatcher} fsW
   */
  constructor(fsW) {
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error);
  }

  /**
   * Watch file for changes with fs_watchFile or fs_watch.
   * @param {String} path to file or dir
   * @param {Function} listener on fs change
   * @returns {Function} closer for the watcher instance
   */
  _watchWithNodeFs(path, listener) {
    const opts = this.fsw.options;
    const directory = sysPath.dirname(path);
    const basename = sysPath.basename(path);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename);
    const absolutePath = sysPath.resolve(path);
    const options: Partial<FSWInstanceOptions> = {
      persistent: opts.persistent,
    };
    if (!listener) listener = EMPTY_FN;

    let closer;
    if (opts.usePolling) {
      options.interval =
        opts.enableBinaryInterval && isBinaryPath(basename) ? opts.binaryInterval : opts.interval;
      closer = setFsWatchFileListener(path, absolutePath, options, {
        listener,
        rawEmitter: this.fsw._emitRaw,
      });
    } else {
      closer = setFsWatchListener(path, absolutePath, options, {
        listener,
        errHandler: this._boundHandleError,
        rawEmitter: this.fsw._emitRaw,
      });
    }
    return closer;
  }

  /**
   * Watch a file and emit add event if warranted.
   * @param {Path} file Path
   * @param {fs.Stats} stats result of fs_stat
   * @param {Boolean} initialAdd was the file added at watch instantiation?
   * @returns {Function} closer for the watcher instance
   */
  _handleFile(file, stats, initialAdd) {
    if (this.fsw.closed) return;
    const dirname = sysPath.dirname(file);
    const basename = sysPath.basename(file);
    const parent = this.fsw._getWatchedDir(dirname);
    // stats is always present
    let prevStats = stats;

    // if the file is already being watched, do nothing
    if (parent.has(basename)) return;

    const listener = async (path, newStats) => {
      if (!this.fsw._throttle(THROTTLE_MODE_WATCH, file, 5)) return;
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats = await stat(file);
          if (this.fsw.closed) return;
          // Check that change event was not fired because of changed only accessTime.
          const at = newStats.atimeMs;
          const mt = newStats.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw._emit(EV.CHANGE, file, newStats);
          }
          if ((isMacos || isLinux) && prevStats.ino !== newStats.ino) {
            this.fsw._closeFile(path);
            prevStats = newStats;
            this.fsw._addPathCloser(path, this._watchWithNodeFs(file, listener));
          } else {
            prevStats = newStats;
          }
        } catch (error) {
          // Fix issues where mtime is null but file is still present
          this.fsw._remove(dirname, basename);
        }
        // add is about to be emitted if file not already tracked in parent
      } else if (parent.has(basename)) {
        // Check that change event was not fired because of changed only accessTime.
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw._emit(EV.CHANGE, file, newStats);
        }
        prevStats = newStats;
      }
    };
    // kick off the watcher
    const closer = this._watchWithNodeFs(file, listener);

    // emit an add event if we're supposed to
    if (!(initialAdd && this.fsw.options.ignoreInitial) && this.fsw._isntIgnored(file)) {
      if (!this.fsw._throttle(EV.ADD, file, 0)) return;
      this.fsw._emit(EV.ADD, file, stats);
    }

    return closer;
  }

  /**
   * Handle symlinks encountered while reading a dir.
   * @param {Object} entry returned by readdirp
   * @param {String} directory path of dir being read
   * @param {String} path of this item
   * @param {String} item basename of this item
   * @returns {Promise<Boolean>} true if no more processing is needed for this entry.
   */
  async _handleSymlink(entry, directory, path, item) {
    if (this.fsw.closed) {
      return;
    }
    const full = entry.fullPath;
    const dir = this.fsw._getWatchedDir(directory);

    if (!this.fsw.options.followSymlinks) {
      // watch symlink directly (don't follow) and detect changes
      this.fsw._incrReadyCount();

      let linkPath;
      try {
        linkPath = await fsrealpath(path);
      } catch (e) {
        this.fsw._emitReady();
        return true;
      }

      if (this.fsw.closed) return;
      if (dir.has(item)) {
        if (this.fsw._symlinkPaths.get(full) !== linkPath) {
          this.fsw._symlinkPaths.set(full, linkPath);
          this.fsw._emit(EV.CHANGE, path, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw._symlinkPaths.set(full, linkPath);
        this.fsw._emit(EV.ADD, path, entry.stats);
      }
      this.fsw._emitReady();
      return true;
    }

    // don't follow the same symlink more than once
    if (this.fsw._symlinkPaths.has(full)) {
      return true;
    }

    this.fsw._symlinkPaths.set(full, true);
  }

  _handleRead(directory, initialAdd, wh: WatchHelper, target, dir, depth, throttler) {
    // Normalize the directory name on Windows
    directory = sysPath.join(directory, EMPTY_STR);

    throttler = this.fsw._throttle('readdir', directory, 1000);
    if (!throttler) return;

    const previous = this.fsw._getWatchedDir(wh.path);
    const current = new Set();

    let stream = this.fsw
      ._readdirp(directory, {
        fileFilter: (entry) => wh.filterPath(entry),
        directoryFilter: (entry) => wh.filterDir(entry),
        depth: 0,
      })
      .on(STR_DATA, async (entry) => {
        if (this.fsw.closed) {
          stream = undefined;
          return;
        }
        const item = entry.path;
        let path = sysPath.join(directory, item);
        current.add(item);

        if (
          entry.stats.isSymbolicLink() &&
          (await this._handleSymlink(entry, directory, path, item))
        ) {
          return;
        }

        if (this.fsw.closed) {
          stream = undefined;
          return;
        }
        // Files that present in current directory snapshot
        // but absent in previous are added to watch list and
        // emit `add` event.
        if (item === target || (!target && !previous.has(item))) {
          this.fsw._incrReadyCount();

          // ensure relativeness of path is preserved in case of watcher reuse
          path = sysPath.join(dir, sysPath.relative(dir, path));

          this._addToNodeFs(path, initialAdd, wh, depth + 1);
        }
      })
      .on(EV.ERROR, this._boundHandleError);

    return new Promise((resolve) =>
      stream.once(STR_END, () => {
        if (this.fsw.closed) {
          stream = undefined;
          return;
        }
        const wasThrottled = throttler ? throttler.clear() : false;

        resolve(undefined);

        // Files that absent in current directory snapshot
        // but present in previous emit `remove` event
        // and are removed from @watched[directory].
        previous
          .getChildren()
          .filter((item) => {
            return item !== directory && !current.has(item);
          })
          .forEach((item) => {
            this.fsw._remove(directory, item);
          });

        stream = undefined;

        // one more time for any missed in case changes came in extremely quickly
        if (wasThrottled) this._handleRead(directory, false, wh, target, dir, depth, throttler);
      })
    );
  }

  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param {String} dir fs path
   * @param {fs.Stats} stats
   * @param {Boolean} initialAdd
   * @param {Number} depth relative to user-supplied path
   * @param {String} target child path targeted for watch
   * @param {Object} wh Common watch helpers for this path
   * @param {String} realpath
   * @returns {Promise<Function>} closer for the watcher instance.
   */
  async _handleDir(dir, stats, initialAdd, depth, target, wh: WatchHelper, realpath) {
    const parentDir = this.fsw._getWatchedDir(sysPath.dirname(dir));
    const tracked = parentDir.has(sysPath.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      console.log('addDir', dir, new Error().stack);
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }

    // ensure dir is tracked (harmless if redundant)
    parentDir.add(sysPath.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler;
    let closer;

    const oDepth = this.fsw.options.depth;
    if ((oDepth == null || depth <= oDepth) && !this.fsw._symlinkPaths.has(realpath)) {
      if (!target) {
        await this._handleRead(dir, initialAdd, wh, target, dir, depth, throttler);
        if (this.fsw.closed) return;
      }

      closer = this._watchWithNodeFs(dir, (dirPath, stats) => {
        // if current directory is removed, do nothing
        if (stats && stats.mtimeMs === 0) return;

        this._handleRead(dirPath, false, wh, target, dir, depth, throttler);
      });
    }
    return closer;
  }

  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to _handleFile / _handleDir after checks.
   * @param {String} path to file or ir
   * @param {Boolean} initialAdd was the file added at watch instantiation?
   * @param {Object} priorWh depth relative to user-supplied path
   * @param {Number} depth Child path actually targeted for watch
   * @param {String=} target Child path actually targeted for watch
   * @returns {Promise}
   */
  async _addToNodeFs(path, initialAdd, priorWh: WatchHelper | undefined, depth, target?: string) {
    const ready = this.fsw._emitReady;
    if (this.fsw._isIgnored(path) || this.fsw.closed) {
      ready();
      return false;
    }

    const wh = this.fsw._getWatchHelpers(path);
    if (priorWh) {
      wh.filterPath = (entry) => priorWh.filterPath(entry);
      wh.filterDir = (entry) => priorWh.filterDir(entry);
    }

    // evaluate what is at the path we're being asked to watch
    try {
      const stats = await statMethods[wh.statMethod](wh.watchPath);
      if (this.fsw.closed) return;
      if (this.fsw._isIgnored(wh.watchPath, stats)) {
        ready();
        return false;
      }

      const follow =
        this.fsw.options.followSymlinks && !path.includes(STAR) && !path.includes(BRACE_START);
      let closer;
      if (stats.isDirectory()) {
        const absPath = sysPath.resolve(path);
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed) return;
        closer = await this._handleDir(
          wh.watchPath,
          stats,
          initialAdd,
          depth,
          target,
          wh,
          targetPath
        );
        if (this.fsw.closed) return;
        // preserve this symlink's target path
        if (absPath !== targetPath && targetPath !== undefined) {
          this.fsw._symlinkPaths.set(absPath, targetPath);
        }
      } else if (stats.isSymbolicLink()) {
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed) return;
        const parent = sysPath.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
        if (this.fsw.closed) return;

        // preserve this symlink's target path
        if (targetPath !== undefined) {
          this.fsw._symlinkPaths.set(sysPath.resolve(path), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();

      this.fsw._addPathCloser(path, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error)) {
        ready();
        return path;
      }
    }
  }
}
