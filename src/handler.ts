import type { FSWatcher as NativeFsWatcher, Stats, WatchEventType, WatchListener } from 'node:fs';
import { watch as fs_watch, unwatchFile, watchFile } from 'node:fs';
import { realpath as fsrealpath, lstat, open, stat } from 'node:fs/promises';
import { type as osType } from 'node:os';
import * as sp from 'node:path';
import type { EntryInfo } from 'readdirp';
import type { FSWatcher, FSWInstanceOptions, Throttler, WatchHelper } from './index.js';

export type Path = string;

export const STR_DATA = 'data';
export const STR_END = 'end';
export const STR_CLOSE = 'close';
export const EMPTY_FN = (): void => {};
export const IDENTITY_FN = (val: unknown): unknown => val;

const pl = process.platform;
export const isWindows: boolean = pl === 'win32';
export const isMacos: boolean = pl === 'darwin';
export const isLinux: boolean = pl === 'linux';
export const isFreeBSD: boolean = pl === 'freebsd';
export const isIBMi: boolean = osType() === 'OS400';

export const EVENTS = {
  ALL: 'all',
  READY: 'ready',
  ADD: 'add',
  CHANGE: 'change',
  ADD_DIR: 'addDir',
  UNLINK: 'unlink',
  UNLINK_DIR: 'unlinkDir',
  RAW: 'raw',
  ERROR: 'error',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const EV = EVENTS;
const THROTTLE_MODE_WATCH = 'watch';

const statMethods = { lstat, stat };

const KEY_LISTENERS = 'listeners';
const KEY_ERR = 'errHandlers';
const KEY_RAW = 'rawEmitters';
const HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR, KEY_RAW];

// prettier-ignore
const binaryExtensions = new Set([
  '3dm', '3ds', '3g2', '3gp', '7z', 'a', 'aac', 'adp', 'afdesign', 'afphoto', 'afpub', 'ai',
  'aif', 'aiff', 'alz', 'ape', 'apk', 'appimage', 'ar', 'arj', 'asf', 'au', 'avi',
  'bak', 'baml', 'bh', 'bin', 'bk', 'bmp', 'btif', 'bz2', 'bzip2',
  'cab', 'caf', 'cgm', 'class', 'cmx', 'cpio', 'cr2', 'cur', 'dat', 'dcm', 'deb', 'dex', 'djvu',
  'dll', 'dmg', 'dng', 'doc', 'docm', 'docx', 'dot', 'dotm', 'dra', 'DS_Store', 'dsk', 'dts',
  'dtshd', 'dvb', 'dwg', 'dxf',
  'ecelp4800', 'ecelp7470', 'ecelp9600', 'egg', 'eol', 'eot', 'epub', 'exe',
  'f4v', 'fbs', 'fh', 'fla', 'flac', 'flatpak', 'fli', 'flv', 'fpx', 'fst', 'fvt',
  'g3', 'gh', 'gif', 'graffle', 'gz', 'gzip',
  'h261', 'h263', 'h264', 'icns', 'ico', 'ief', 'img', 'ipa', 'iso',
  'jar', 'jpeg', 'jpg', 'jpgv', 'jpm', 'jxr', 'key', 'ktx',
  'lha', 'lib', 'lvp', 'lz', 'lzh', 'lzma', 'lzo',
  'm3u', 'm4a', 'm4v', 'mar', 'mdi', 'mht', 'mid', 'midi', 'mj2', 'mka', 'mkv', 'mmr','mng',
  'mobi', 'mov', 'movie', 'mp3',
  'mp4', 'mp4a', 'mpeg', 'mpg', 'mpga', 'mxu',
  'nef', 'npx', 'numbers', 'nupkg',
  'o', 'odp', 'ods', 'odt', 'oga', 'ogg', 'ogv', 'otf', 'ott',
  'pages', 'pbm', 'pcx', 'pdb', 'pdf', 'pea', 'pgm', 'pic', 'png', 'pnm', 'pot', 'potm',
  'potx', 'ppa', 'ppam',
  'ppm', 'pps', 'ppsm', 'ppsx', 'ppt', 'pptm', 'pptx', 'psd', 'pya', 'pyc', 'pyo', 'pyv',
  'qt',
  'rar', 'ras', 'raw', 'resources', 'rgb', 'rip', 'rlc', 'rmf', 'rmvb', 'rpm', 'rtf', 'rz',
  's3m', 's7z', 'scpt', 'sgi', 'shar', 'snap', 'sil', 'sketch', 'slk', 'smv', 'snk', 'so',
  'stl', 'suo', 'sub', 'swf',
  'tar', 'tbz', 'tbz2', 'tga', 'tgz', 'thmx', 'tif', 'tiff', 'tlz', 'ttc', 'ttf', 'txz',
  'udf', 'uvh', 'uvi', 'uvm', 'uvp', 'uvs', 'uvu',
  'viv', 'vob',
  'war', 'wav', 'wax', 'wbmp', 'wdp', 'weba', 'webm', 'webp', 'whl', 'wim', 'wm', 'wma',
  'wmv', 'wmx', 'woff', 'woff2', 'wrm', 'wvx',
  'xbm', 'xif', 'xla', 'xlam', 'xls', 'xlsb', 'xlsm', 'xlsx', 'xlt', 'xltm', 'xltx', 'xm',
  'xmind', 'xpi', 'xpm', 'xwd', 'xz',
  'z', 'zip', 'zipx',
]);
const isBinaryPath = (filePath: string) =>
  binaryExtensions.has(sp.extname(filePath).slice(1).toLowerCase());

// TODO: emit errors properly. Example: EMFILE on Macos.
const foreach = <V extends unknown>(val: V, fn: (arg: V) => unknown) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};

const addAndConvert = (main: Record<string, unknown>, prop: string, item: unknown) => {
  let container = (main as Record<string, unknown>)[prop];
  if (!(container instanceof Set)) {
    (main as Record<string, unknown>)[prop] = container = new Set([container]);
  }
  (container as Set<unknown>).add(item);
};

const clearItem = (cont: Record<string, unknown>) => (key: string) => {
  const set = cont[key];
  if (set instanceof Set) {
    set.clear();
  } else {
    delete cont[key];
  }
};

const delFromSet = (main: Record<string, unknown> | Set<unknown>, prop: string, item: unknown) => {
  const container = (main as Record<string, unknown>)[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete (main as Record<string, unknown>)[prop];
  }
};

const isEmptySet = (val: unknown) => (val instanceof Set ? val.size === 0 : !val);

// fs_watch helpers

// object to hold per-process fs_watch instances
// (may be shared across chokidar FSWatcher instances)

export type FsWatchContainer = {
  listeners: (path: string) => void | Set<any>;
  errHandlers: (err: unknown) => void | Set<any>;
  rawEmitters: (ev: WatchEventType, path: string, opts: unknown) => void | Set<any>;
  watcher: NativeFsWatcher;
  watcherUnusable?: boolean;
};

const FsWatchInstances = new Map<string, FsWatchContainer>();

/**
 * Instantiates the fs_watch interface
 * @param path to be watched
 * @param options to be passed to fs_watch
 * @param listener main event handler
 * @param errHandler emits info about errors
 * @param emitRaw emits raw event data
 * @returns {NativeFsWatcher}
 */
function createFsWatchInstance(
  path: string,
  options: Partial<FSWInstanceOptions>,
  listener: WatchHandlers['listener'],
  errHandler: WatchHandlers['errHandler'],
  emitRaw: WatchHandlers['rawEmitter']
): NativeFsWatcher | undefined {
  const handleEvent: WatchListener<string> = (rawEvent, evPath: string | null) => {
    listener(path);
    emitRaw(rawEvent, evPath!, { watchedPath: path });

    // emit based on events occurring for files from a directory's watcher in
    // case the file's watcher misses it (and rely on throttling to de-dupe)
    if (evPath && path !== evPath) {
      fsWatchBroadcast(sp.resolve(path, evPath), KEY_LISTENERS, sp.join(path, evPath));
    }
  };
  try {
    return fs_watch(
      path,
      {
        persistent: options.persistent,
      },
      handleEvent
    );
  } catch (error) {
    errHandler(error);
    return undefined;
  }
}

/**
 * Helper for passing fs_watch event data to a collection of listeners
 * @param fullPath absolute path bound to fs_watch instance
 */
const fsWatchBroadcast = (
  fullPath: Path,
  listenerType: string,
  val1?: unknown,
  val2?: unknown,
  val3?: unknown
) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont) return;
  foreach(cont[listenerType as keyof typeof cont], (listener: any) => {
    listener(val1, val2, val3);
  });
};

export interface WatchHandlers {
  listener: (path: string) => void;
  errHandler: (err: unknown) => void;
  rawEmitter: (ev: WatchEventType, path: string, opts: unknown) => void;
}

/**
 * Instantiates the fs_watch interface or binds listeners
 * to an existing one covering the same file system entry
 * @param path
 * @param fullPath absolute path
 * @param options to be passed to fs_watch
 * @param handlers container for event listener functions
 */
const setFsWatchListener = (
  path: string,
  fullPath: string,
  options: Partial<FSWInstanceOptions>,
  handlers: WatchHandlers
) => {
  const { listener, errHandler, rawEmitter } = handlers;
  let cont = FsWatchInstances.get(fullPath);

  let watcher: NativeFsWatcher | undefined;
  if (!options.persistent) {
    watcher = createFsWatchInstance(path, options, listener, errHandler, rawEmitter);
    if (!watcher) return;
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
    watcher.on(EV.ERROR, async (error: Error & { code: string }) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      if (cont) cont.watcherUnusable = true; // documented since Node 10.4.1
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
      // @ts-ignore
      cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};

// fs_watchFile helpers

// object to hold per-process fs_watchFile instances
// (may be shared across chokidar FSWatcher instances)
const FsWatchFileInstances = new Map<string, any>();

/**
 * Instantiates the fs_watchFile interface or binds listeners
 * to an existing one covering the same file system entry
 * @param path to be watched
 * @param fullPath absolute path
 * @param options options to be passed to fs_watchFile
 * @param handlers container for event listener functions
 * @returns closer
 */
const setFsWatchFileListener = (
  path: Path,
  fullPath: Path,
  options: Partial<FSWInstanceOptions>,
  handlers: Pick<WatchHandlers, 'rawEmitter' | 'listener'>
): (() => void) => {
  const { listener, rawEmitter } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);

  // let listeners = new Set();
  // let rawEmitters = new Set();

  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent! || copts.interval > options.interval!)) {
    // "Upgrade" the watcher to persistence or a quicker interval.
    // This creates some unlikely edge case issues if the user mixes
    // settings in a very weird way, but solving for those cases
    // doesn't seem worthwhile for the added complexity.
    // listeners = cont.listeners;
    // rawEmitters = cont.rawEmitters;
    unwatchFile(fullPath);
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
      watcher: watchFile(fullPath, options, (curr, prev) => {
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
      unwatchFile(fullPath);
      cont.options = cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};

/**
 * @mixin
 */
export class NodeFsHandler {
  fsw: FSWatcher;
  _boundHandleError: (error: unknown) => void;
  constructor(fsW: FSWatcher) {
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error as Error);
  }

  /**
   * Watch file for changes with fs_watchFile or fs_watch.
   * @param path to file or dir
   * @param listener on fs change
   * @returns closer for the watcher instance
   */
  _watchWithNodeFs(
    path: string,
    listener: (path: string, newStats?: any) => void | Promise<void>
  ): (() => void) | undefined {
    const opts = this.fsw.options;
    const directory = sp.dirname(path);
    const basename = sp.basename(path);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename);
    const absolutePath = sp.resolve(path);
    const options: Partial<FSWInstanceOptions> = {
      persistent: opts.persistent,
    };
    if (!listener) listener = EMPTY_FN;

    let closer;
    if (opts.usePolling) {
      const enableBin = opts.interval !== opts.binaryInterval;
      options.interval = enableBin && isBinaryPath(basename) ? opts.binaryInterval : opts.interval;
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
   * @returns closer for the watcher instance
   */
  _handleFile(file: Path, stats: Stats, initialAdd: boolean): (() => void) | undefined {
    if (this.fsw.closed) {
      return;
    }
    const dirname = sp.dirname(file);
    const basename = sp.basename(file);
    const parent = this.fsw._getWatchedDir(dirname);
    // stats is always present
    let prevStats = stats;

    // if the file is already being watched, do nothing
    if (parent.has(basename)) return;

    const listener = async (path: Path, newStats: Stats) => {
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
          if ((isMacos || isLinux || isFreeBSD) && prevStats.ino !== newStats.ino) {
            this.fsw._closeFile(path);
            prevStats = newStats;
            const closer = this._watchWithNodeFs(file, listener);
            if (closer) this.fsw._addPathCloser(path, closer);
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
   * @param entry returned by readdirp
   * @param directory path of dir being read
   * @param path of this item
   * @param item basename of this item
   * @returns true if no more processing is needed for this entry.
   */
  async _handleSymlink(
    entry: EntryInfo,
    directory: string,
    path: Path,
    item: string
  ): Promise<boolean | undefined> {
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

  _handleRead(
    directory: string,
    initialAdd: boolean,
    wh: WatchHelper,
    target: Path,
    dir: Path,
    depth: number,
    throttler: Throttler
  ): Promise<unknown> | undefined {
    // Normalize the directory name on Windows
    directory = sp.join(directory, '');

    throttler = this.fsw._throttle('readdir', directory, 1000) as Throttler;
    if (!throttler) return;

    const previous = this.fsw._getWatchedDir(wh.path);
    const current = new Set();

    let stream = this.fsw._readdirp(directory, {
      fileFilter: (entry: EntryInfo) => wh.filterPath(entry),
      directoryFilter: (entry: EntryInfo) => wh.filterDir(entry),
    });
    if (!stream) return;
    stream
      .on(STR_DATA, async (entry) => {
        if (this.fsw.closed) {
          stream = undefined;
          return;
        }
        const item = entry.path;
        let path = sp.join(directory, item);
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
          path = sp.join(dir, sp.relative(dir, path));

          this._addToNodeFs(path, initialAdd, wh, depth + 1);
        }
      })
      .on(EV.ERROR, this._boundHandleError);

    return new Promise((resolve, reject) => {
      if (!stream) return reject();
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
      });
    });
  }

  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param dir fs path
   * @param stats
   * @param initialAdd
   * @param depth relative to user-supplied path
   * @param target child path targeted for watch
   * @param wh Common watch helpers for this path
   * @param realpath
   * @returns closer for the watcher instance.
   */
  async _handleDir(
    dir: string,
    stats: Stats,
    initialAdd: boolean,
    depth: number,
    target: string,
    wh: WatchHelper,
    realpath: string
  ): Promise<(() => void) | undefined> {
    const parentDir = this.fsw._getWatchedDir(sp.dirname(dir));
    const tracked = parentDir.has(sp.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }

    // ensure dir is tracked (harmless if redundant)
    parentDir.add(sp.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler!: Throttler;
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
   * @param path to file or ir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async _addToNodeFs(
    path: string,
    initialAdd: boolean,
    priorWh: WatchHelper | undefined,
    depth: number,
    target?: string
  ): Promise<string | false | undefined> {
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

      const follow = this.fsw.options.followSymlinks;
      let closer;
      if (stats.isDirectory()) {
        const absPath = sp.resolve(path);
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed) return;
        closer = await this._handleDir(
          wh.watchPath,
          stats,
          initialAdd,
          depth,
          target!,
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
        const parent = sp.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
        if (this.fsw.closed) return;

        // preserve this symlink's target path
        if (targetPath !== undefined) {
          this.fsw._symlinkPaths.set(sp.resolve(path), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();

      if (closer) this.fsw._addPathCloser(path, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error as any)) {
        ready();
        return path;
      }
    }
  }
}
