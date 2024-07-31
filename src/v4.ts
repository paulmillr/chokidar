import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import sysPath from 'node:path';
import { readdir, lstat, open, stat, realpath as fsrealpath } from 'node:fs/promises';
import { type as osType } from 'os';
import type { BigIntStats, Stats as NodeStats } from 'node:fs';
// readlink
// Platform information
const { platform } = process;
export const isWindows = platform === 'win32';
export const isMacos = platform === 'darwin';
export const isLinux = platform === 'linux';
export const isIBMi = osType() === 'OS400';
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
const isBinaryPath = (filePath) =>
  binaryExtensions.has(sysPath.extname(filePath).slice(1).toLowerCase());

// Small internal primitive to limit concurrency
// TODO: identify potential bugs. Research hpw other libraries do this
function limit(concurrencyLimit?: number) {
  if (concurrencyLimit === undefined) return <T>(fn: () => T): T => fn(); // Fast path for no limit
  let currentlyProcessing = 0;
  const queue: ((value?: unknown) => void)[] = [];
  const next = () => {
    if (!queue.length) return;
    if (currentlyProcessing >= concurrencyLimit) return;
    currentlyProcessing++;
    const first = queue.shift();
    if (!first) throw new Error('empty queue'); // should not happen
    first();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() =>
        Promise.resolve()
          .then(fn)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            currentlyProcessing--;
            next();
          })
      );
      next();
    });
}

// prettier-ignore
type EventName = 'all' | 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | 'raw' | 'error' | 'ready';
type Stats = NodeStats | BigIntStats;
type Path = string;
type ThrottleType = 'readdir' | 'watch' | 'add' | 'remove' | 'change';
type EmitArgs = [EventName, Path, any?, any?, any?];

const arrify = <T>(value: T | T[] = []): T[] => (Array.isArray(value) ? value : [value]);
const flatten = <T>(list: T[] | T[][], result = []): T[] => {
  list.forEach((item) => {
    if (Array.isArray(item)) flatten(item, result);
    else result.push(item);
  });
  return result;
};

/**
 * Check for read permissions.
 * @param stats - object, result of fs_stat
 * @returns indicates whether the file can be read
 */
function hasReadPermissions(stats: Stats) {
  return Boolean(Number(stats.mode) & 0o400);
}

const NORMAL_FLOW_ERRORS = new Set(['ENOENT', 'EPERM', 'EACCES', 'ELOOP']);

// Legacy list of user events
export const EV = {
  ALL: 'all',
  READY: 'ready',
  ADD: 'add',
  CHANGE: 'change',
  ADD_DIR: 'addDir',
  UNLINK: 'unlink',
  UNLINK_DIR: 'unlinkDir',
  RAW: 'raw',
  ERROR: 'error',
};

/*
Re-usable instances of fs.watch and fs.watchFile. Architecture rationale:
- FSWatcher can have multiple listeners here:
  - followSymlinks + two symlinks to the same file
  - directory + symlink inside
  - different paths (absolute + relative) without cwd
- Multiple FSWatcher-s can reuse the same watcher
- This means we cannot just add Set<FSWatcher> for err/raw (it will require reference counting)
  Should be very simple code to create watchers only, all logic and IO should be handled inside of FSWatcher
- Returns sync 'closer' function which should ensure that no events emitted after closing.
  This is needed for cases when the directory was moved.
*/
type WatchHandlers = {
  listener: (path: string, stats?: Stats) => void;
  errHandler: (err: Error, path?: Path, fullPath?: Path) => void;
  rawEmitter: (ev: fs.WatchEventType, path: string, opts: unknown) => void;
};

type WatchInstancePartial = {
  listeners: Set<WatchHandlers['listener']>;
  errHandlers: Set<WatchHandlers['errHandler']>;
  rawEmitters: Set<WatchHandlers['rawEmitter']>;
  options: Partial<FSWInstanceOptions>;
};

type WatchInstance<T> = WatchInstancePartial & { watcher?: T };

type WatchFn<T> = {
  upgrade?: boolean;
  create: (path: Path, fullPath: Path, instance: WatchInstancePartial) => T;
  close: (path: Path, fullPath: Path, watcher?: T) => void;
};

const watchWrapper = <T>(opts: WatchFn<T>) => {
  const instances: Map<string, WatchInstance<T>> = new Map();
  const { create, close, upgrade } = opts;
  return (
    path: Path,
    fullPath: Path,
    options: Partial<FSWInstanceOptions>,
    handlers: WatchHandlers
  ) => {
    let cont: WatchInstance<T> | undefined = instances.get(fullPath);
    const { listener, errHandler, rawEmitter } = handlers;
    const copts = cont && cont.options;
    // This seems like a rare case.
    // In theory, we can upgrade 'watch' too, but instead
    // fallback to creating non-global instance if different persistence
    let differentOptions =
      copts && (copts.persistent < options.persistent || copts.interval > options.interval);
    if (upgrade && differentOptions) {
      // "Upgrade" the watcher to persistence or a quicker interval.
      // This creates some unlikely edge case issues if the user mixes
      // settings in a very weird way, but solving for those cases
      // doesn't seem worthwhile for the added complexity.
      close(path, fullPath, cont.watcher);
      cont = undefined;
      differentOptions = false; // upgraded, now options are the same
    }
    if (!cont || differentOptions) {
      cont = { listeners: new Set(), errHandlers: new Set(), rawEmitters: new Set(), options };
      try {
        cont.watcher = create(path, fullPath, cont);
        // non-global instance if options still different
        if (!differentOptions) instances.set(fullPath, cont);
      } catch (error) {
        errHandler(error);
        return;
      }
    }
    cont.listeners.add(listener);
    cont.errHandlers.add(errHandler);
    cont.rawEmitters.add(rawEmitter);
    return () => {
      cont.listeners.delete(listener);
      cont.errHandlers.delete(errHandler);
      cont.rawEmitters.delete(rawEmitter);
      if (cont.listeners.size) return; // All listeners left, lets close
      if (!differentOptions) instances.delete(fullPath); // when same options: use global
      close(path, fullPath, cont.watcher);
      cont.listeners.clear();
      cont.errHandlers.clear();
      cont.rawEmitters.clear();
      cont.watcher = undefined;
      Object.freeze(cont);
    };
  };
};

const fsWatch = watchWrapper({
  create(path, fullPath, instance) {
    const { options, listeners, rawEmitters, errHandlers } = instance;
    // TODO: why it is using path instead full path?
    return fs
      .watch(path, { persistent: options.persistent }, (rawEvent, evPath) => {
        for (const fn of listeners) fn(path);
        for (const fn of rawEmitters) fn(rawEvent, evPath, { watchedPath: path });
        // NOTE: previously there was re-emitting event "for files from a
        // directory's watcher in case the file's watcher misses it"
        // However, this is incorrect and can cause race-conditions if current
        // watcher is already closed.
        // Please open issue if there is a reproducible case for this.
      })
      .on('error', (err) => {
        for (const fn of errHandlers) fn(err, path, fullPath);
      });
  },
  close(path, fullPath, watcher) {
    if (watcher) watcher.close();
  },
});

const fsWatchFile = watchWrapper({
  upgrade: true,
  create(path, fullPath, instance) {
    const { listeners, rawEmitters, options } = instance;
    return fs.watchFile(fullPath, options, (curr, prev) => {
      for (const rawEmitter of rawEmitters) rawEmitter('change', fullPath, { curr, prev });
      const currmtime = curr.mtimeMs;
      if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
        for (const listener of listeners) listener(path, curr);
      }
    });
  },
  // eslint-disable-next-line
  close(path, fullPath, _watcher) {
    fs.unwatchFile(fullPath);
  },
});

// Matcher
type MatchFunction = (path: string, stats?: Stats) => boolean;
interface MatcherObject {
  path: string;
  recursive?: boolean;
}
type Matcher = string | RegExp | MatchFunction | MatcherObject;
function isMatcherObject(matcher: Matcher): matcher is MatcherObject {
  return typeof matcher === 'object' && matcher !== null && !(matcher instanceof RegExp);
}
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
  binaryInterval: number; // Used only for pooling and if diferrent from interval

  alwaysStat?: boolean;
  depth?: number;
  ignorePermissionErrors: boolean;
  atomic: boolean | number; // or a custom 'atomicity delay', in milliseconds (default 100)
  useAsync?: boolean; // Use async for stat/readlink methods

  ioLimit?: number; // Limit parallel IO operations (CPU usage + OS limits)
};

export type ChokidarOptions = Partial<
  BasicOpts & {
    ignored: string | ((path: string) => boolean); // And what about regexps?
    awaitWriteFinish: boolean | Partial<AWF>;
  }
>;

export type FSWInstanceOptions = BasicOpts & {
  ignored: Matcher[]; // string | fn ->
  awaitWriteFinish: false | AWF;
};

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
  private watched: Map<string, Set<string>> = new Map();
  private closers: Map<string, Array<any>> = new Map();
  private ignoredPaths: Set<Matcher> = new Set<Matcher>();
  private throttled: Map<ThrottleType, Map<any, any>> = new Map();
  private symlinkPaths: Map<Path, string | boolean> = new Map();
  closed: boolean = false;
  private pendingWrites: Map<any, any> = new Map();
  private pendingUnlinks: Map<any, any> = new Map();
  private readyCount: number;
  private emitReady: () => void;
  private closePromise: Promise<void>;
  private userIgnored?: MatchFunction;
  private readyEmitted: boolean = false;
  // Performance debug related stuff. Not sure if worth exposing in API?
  public metrics: Record<string, number> = {};
  private ioLimit: ReturnType<typeof limit>;
  constructor(_opts: ChokidarOptions = {}) {
    super();
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
      useAsync: false,
      atomic: true, // NOTE: overwritten later (depends on usePolling)
      ..._opts,
      // Change format
      ignored: arrify(_opts.ignored),
      awaitWriteFinish:
        awf === true ? DEF_AWF : typeof awf === 'object' ? { ...DEF_AWF, ...awf } : false,
    };
    // Always default to polling on IBM i because fs.watch() is not available on IBM i.
    if (isIBMi) opts.usePolling = true;
    // Editor atomic write normalization enabled by default with fs.watch
    if (opts.atomic === undefined) opts.atomic = !opts.usePolling;
    opts.atomic = typeof _opts.atomic === 'number' ? _opts.atomic : 100;
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
    this.ioLimit = limit(opts.ioLimit);
    // TODO: simplify. Currently it will easily lose things
    // This seems done to emit ready only once, but each 'add' will increase that?
    let readyCalls = 0;
    this.emitReady = () => {
      readyCalls++;
      if (readyCalls >= this.readyCount) {
        this.emitReady = () => {};
        this.readyEmitted = true;
        // use process.nextTick to allow time for listener to be bound
        process.nextTick(() => this.emit('ready'));
      }
    };
    // You’re frozen when your heart’s not open.
    Object.freeze(opts);
    this.options = opts;
  }
  // IO
  private metric(name: string, inc = 1) {
    if (!this.metrics[name]) this.metrics[name] = 0;
    this.metrics[name] += inc;
  }
  private readdir(path: string) {
    // dirent is available in node v18 on macos + win + linux
    return this.ioLimit(async () => {
      try {
        return await readdir(path, { encoding: 'utf8', withFileTypes: true });
      } catch (err) {
        if (!NORMAL_FLOW_ERRORS.has(err.code)) this.handleError(err);
        return [];
      } finally {
        this.metric('readdir');
      }
    });
  }
  private lstat(path: string): Promise<Stats | undefined> {
    // Available in node v18: bigint allows access to 'mtimeNs' which has more precision than mtimeMs.
    // It's no longer a float, which can't be compared.
    // Also, there is no mtime/mode in DirEnt
    return this.ioLimit(async () => {
      try {
        if (!this.options.useAsync) return fs.lstatSync(path, { bigint: true });
        return await lstat(path, { bigint: true });
      } catch (err) {
        if (!NORMAL_FLOW_ERRORS.has(err.code)) this.handleError(err);
        return;
      } finally {
        this.metric('lstat');
      }
    });
  }
  private stat(path: string): Promise<Stats | undefined> {
    // Available in node v18: bigint allows access to 'mtimeNs' which has more precision than mtimeMs.
    // It's no longer a float, which can't be compared.
    // Also, there is no mtime/mode in DirEnt
    return this.ioLimit(async () => {
      try {
        if (!this.options.useAsync) return fs.statSync(path, {});
        return await stat(path, {});
      } catch (err) {
        if (!NORMAL_FLOW_ERRORS.has(err.code)) this.handleError(err);
        return;
      } finally {
        this.metric('stat');
      }
    });
  }
  // private readlink(path: string) {
  //   return this.ioLimit(async () => {
  //     try {
  //       if (!this.options.useAsync) return fs.readlinkSync(path, { encoding: 'utf8' });
  //       return await readlink(path, { encoding: 'utf8' });
  //     } catch (err) {
  //       if (!NORMAL_FLOW_ERRORS.has(err.code)) this.handleError(err);
  //       return;
  //     } finally {
  //       this.metric('readlink');
  //     }
  //   });
  // }
  private canOpen(path: string) {
    return this.ioLimit(async () => {
      try {
        if (!this.options.useAsync) {
          fs.closeSync(fs.openSync(path, 'r'));
        } else {
          await (await open(path, 'r')).close();
        }
      } catch (err) {
        return false;
      } finally {
        this.metric('canOpen');
      }
      return true;
    });
  }
  // This mostly happens after removing file. Checks if directory still exists.
  // TODO: either use real readdir (with updating information) or remove this
  private async canOpenDir(dir: Path) {
    dir = sysPath.resolve(dir);
    return this.ioLimit(async () => {
      const items = this.getWatchedDir(dir);
      if (items.size > 0) return;
      try {
        await readdir(dir);
      } catch (err) {
        this.remove(sysPath.dirname(dir), sysPath.basename(dir));
      }
    });
  }
  // /IO
  // Utils
  /**
   * Provides directory tracking objects
   */
  private getWatchedDir(directory: string): Set<string> {
    const dir = sysPath.resolve(directory);
    if (!this.watched.has(dir)) this.watched.set(dir, new Set());
    return this.watched.get(dir);
  }
  private normalizePath(path: Path) {
    const { cwd } = this.options;
    path = sysPath.normalize(path);
    // TODO: do we really need that? only thing it does is using '//' instead of '\\' for network shares
    // in windows. Path normalize already strips '//' in windows.
    // > If SLASH_SLASH occurs at the beginning of path, it is not replaced
    // >    because "//StoragePC/DrivePool/Movies" is a valid network path
    path = path.replace(/\\/g, '/');
    let prepend = false;
    if (path.startsWith('//')) prepend = true;
    const DOUBLE_SLASH_RE = /\/\//;
    while (path.match(DOUBLE_SLASH_RE)) path = path.replace(DOUBLE_SLASH_RE, '/');
    if (prepend) path = '/' + path;
    // NOTE: join will undo all normalization
    if (cwd) path = sysPath.isAbsolute(path) ? path : sysPath.join(cwd, path);
    return path;
  }
  private normalizePaths(paths: Path | Path[]) {
    // TODO: do we really need flatten here?
    paths = flatten(arrify(paths));
    if (!paths.every((p) => typeof p === 'string'))
      throw new TypeError(`Non-string provided as watch path: ${paths}`);
    return paths.map((i) => this.normalizePath(i));
  }
  /**
   * Helper utility for throttling
   * @param actionType type being throttled
   * @param path being acted upon
   * @param ms duration to suppress duplicate actions
   * @returns tracking object or false if action should be suppressed
   */
  private throttle(actionType: ThrottleType, path: Path, ms: number) {
    // NOTE: this is only used correctly in readdir for now.
    // How it should work:
    // - we process some event
    // - same event happens in parallel multiple times
    // - when we processed first event, we look at last throttled event
    // - start processing it
    // How it works now (except readdir):
    // - we process first event (first change)
    // - there is multiple parallel changes which we throw away
    // - all changes which happened when we processed first event is lost
    if (!this.throttled.has(actionType)) this.throttled.set(actionType, new Map());
    const action = this.throttled.get(actionType);
    const actionPath = action.get(path);
    if (actionPath) {
      actionPath.count++;
      return false;
    }
    const thr = {
      ms,
      timeout: undefined,
      count: 0,
      clear: () => {
        const item = action.get(path);
        const count = item ? item.count : 0;
        action.delete(path);
        if (item) {
          if (item.timeout !== undefined) clearTimeout(item.timeout);
          item.timeout = undefined;
        }
        if (thr.timeout !== undefined) clearTimeout(thr.timeout);
        thr.timeout = undefined;
        return count;
      },
    };
    thr.timeout = setTimeout(thr.clear, ms);
    action.set(path, thr);
    return thr;
  }
  // /Utils
  // Watcher
  //
  private addWatcher(closerPath: Path, path: Path, listener: WatchHandlers['listener']) {
    const opts = this.options;
    const directory = sysPath.dirname(path);
    const basename = sysPath.basename(path);
    this.getWatchedDir(directory).add(basename);
    const absolutePath = sysPath.resolve(path);
    const options: Partial<FSWInstanceOptions> = {
      persistent: opts.persistent,
      interval:
        opts.binaryInterval !== opts.interval && isBinaryPath(basename)
          ? opts.binaryInterval
          : opts.interval,
    };
    const fn = opts.usePolling ? fsWatchFile : fsWatch;
    return this.ioLimit(async () => {
      const closer = fn(path, absolutePath, options, {
        listener: listener as any,
        errHandler: (error: Error, path?: Path) => this.handleError(error, path),
        rawEmitter: (...args) => this.emit('raw', ...args),
      });
      if (closer) {
        //  closerPath = sysPath.resolve(closerPath);
        const list = this.closers.get(closerPath);
        if (!list) this.closers.set(closerPath, [closer]);
        else list.push(closer);
      }
    });
  }
  private closeWatcher(path: Path) {
    //path = sysPath.resolve(path);
    const closers = this.closers.get(path);
    if (closers) {
      for (const closer of closers) closer();
      this.closers.delete(path);
    }
    const dirname = sysPath.dirname(path);
    const dir = this.getWatchedDir(dirname);
    dir.delete(sysPath.basename(path));
    this.canOpenDir(dirname);
  }
  // /Watcher

  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to handleFile / _handleDir after checks.
   * @param {String} path to file or ir
   * @param {Boolean} initialAdd was the file added at watch instantiation?
   * @param {Object} priorWh depth relative to user-supplied path
   * @param {Number} depth Child path actually targeted for watch
   * @param {String=} target Child path actually targeted for watch
   * @returns {Promise}
   */
  private async addToNodeFs(
    path: Path,
    initialAdd: boolean,
    priorWh: string | undefined,
    depth: number,
    target?: string
  ) {
    // TODO: this is completely messed up
    // - we need to use dirent from readdir on recursive call to itself
    // - instead of handling symlinks/stats in single place it does
    //   it multiple times (in readdir, then same thing happens inside recursive addToNodeFs)
    //   - what makes this even worse, some edge cases handled in 'file', others in 'readdir'
    //     this means add('dir/file') has different behavior than add('dir') (and then looking at 'file')
    // - symlinks handling is broken abomination which is also intervened with broken normalization and path handling
    // - emitReady should be Promise.all on 'addWait' which returns when everything added
    //   instead of randomly placed 'readyCount'
    // - these 200 lines should be collapsed to 30-50
    if (this.isIgnored(path) || this.closed) {
      this.emitReady();
      return false;
    }
    const watchPath = priorWh ? priorWh : path;
    const entryPath = (fullPath) => sysPath.join(watchPath, sysPath.relative(watchPath, fullPath));
    // evaluate what is at the path we're being asked to watch
    try {
      const follow = this.options.followSymlinks;
      const stats = await (follow ? this.stat(path) : this.lstat(path)); // TODO: this creates more calls when done inside of a directory
      if (this.closed) return;
      if (this.isIgnored(path, stats)) {
        this.emitReady();
        return false;
      }
      const _handleDir = async (closerPath, dir, target, realpath) => {
        const parentDir = this.getWatchedDir(sysPath.dirname(dir));
        const tracked = parentDir.has(sysPath.basename(dir));
        if (!(initialAdd && this.options.ignoreInitial) && !target && !tracked)
          this._emit('addDir', dir, stats);
        const handleRead = (
          directory,
          initialAdd,
          throttler = this.throttle('readdir', directory, 1000)
        ) => {
          directory = sysPath.join(directory, ''); // Normalize the directory name on Windows
          if (!throttler) return;
          if (this.closed) return;
          const previous = this.getWatchedDir(path);
          const current = new Set();
          // eslint-disable-next-line
          return new Promise(async (resolve) => {
            try {
              const files = await this.readdir(directory);
              const all = files.map(async (dirent) => {
                try {
                  const basename = dirent.name;
                  const fullPath = sysPath.resolve(sysPath.join(directory, basename));
                  let stats: Stats | undefined;
                  if (this.closed) return;
                  // TODO: this is what ignoreDir && ignorePath did. Why don't we check dir && symlink perms?
                  if (this.isIgnored(entryPath(fullPath))) return;
                  if (
                    !dirent.isDirectory() &&
                    !dirent.isSymbolicLink() &&
                    !this.options.ignorePermissionErrors
                  ) {
                    stats = await this.lstat(fullPath);
                    if (!stats) return;
                    if (!hasReadPermissions(stats)) return;
                  }
                  if (this.closed) return;
                  const item = sysPath.relative(sysPath.resolve(directory), fullPath);
                  const path = sysPath.join(directory, item); // looks like absolute path?
                  current.add(item);
                  if (dirent.isSymbolicLink()) {
                    if (this.closed) return;
                    if (!follow) {
                      const dir = this.getWatchedDir(directory);
                      // watch symlink directly (don't follow) and detect changes
                      this.readyCount++;
                      let linkPath;
                      try {
                        linkPath = await fsrealpath(path);
                      } catch (e) {
                        this.emitReady();
                        return;
                      }
                      if (this.closed) return;
                      if (dir.has(item)) {
                        if (this.symlinkPaths.get(fullPath) !== linkPath) {
                          this.symlinkPaths.set(fullPath, linkPath);
                          this._emit('change', path, stats);
                        }
                      } else {
                        dir.add(item);
                        this.symlinkPaths.set(fullPath, linkPath);
                        this._emit('add', path, stats);
                      }
                      this.emitReady();
                      return;
                    }
                    // don't follow the same symlink more than once
                    if (this.symlinkPaths.has(fullPath)) return;
                    this.symlinkPaths.set(fullPath, true);
                  }
                  if (this.closed) return;
                  // Files which are present in current directory snapshot
                  // but absent from previous one, are added to watch list and
                  // emit `add` event.
                  if (item === target || (!target && !previous.has(item))) {
                    this.readyCount++;
                    this.addToNodeFs(
                      // ensure relativeness of path is preserved in case of watcher reuse
                      sysPath.join(dir, sysPath.relative(dir, path)),
                      initialAdd,
                      watchPath,
                      depth + 1
                    ); // wh re-used only here
                  }
                } catch (err) {
                  if (!NORMAL_FLOW_ERRORS.has(err.code)) this.handleError(err);
                }
              });
              await Promise.all(all);
            } catch (err) {
              if (!NORMAL_FLOW_ERRORS.has(err.code)) {
                this.handleError(err);
                return; // promise never resolves?
              }
            } finally {
              resolve(undefined);
            }
            // End, only if everything is ok? will create promise which will never resolve!
            const wasThrottled = throttler ? (throttler as any).clear() : false;
            // Files which are absent in current directory snapshot,
            // but present in previous one, emit `remove` event
            // and are removed from @watched[directory].
            for (const item of previous) {
              if (item === directory || current.has(item)) continue;
              this.remove(directory, item);
            }
            // one more time for any missed in case changes came in extremely quickly
            if (wasThrottled) handleRead(directory, false, throttler);
          });
        };
        // ensure dir is tracked (harmless if redundant)
        parentDir.add(sysPath.basename(dir));
        this.getWatchedDir(dir);
        const maxDepth = this.options.depth;
        if ((maxDepth == null || depth <= maxDepth) && !this.symlinkPaths.has(realpath)) {
          if (!target) {
            // Initial read (before watch)
            await handleRead(dir, initialAdd);
            if (this.closed) return;
          }
          this.addWatcher(closerPath, dir, (dirPath, stats) => {
            if (stats && stats.mtimeMs === 0) return; // if current directory is removed, do nothing
            handleRead(dirPath, false);
          });
        }
      };
      if (stats.isDirectory()) {
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.closed) return;
        await _handleDir(path, path, target, targetPath);
        if (this.closed) return;
        // preserve this symlink's target path
        const absPath = sysPath.resolve(path);
        if (absPath !== targetPath && targetPath !== undefined)
          this.symlinkPaths.set(absPath, targetPath);
      } else if (stats.isSymbolicLink()) {
        // Symlinks doesn't emit any event, only parent directory does
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.closed) return;
        const parent = sysPath.dirname(path);
        this.getWatchedDir(parent).add(path);
        this._emit('add', path, stats);
        await _handleDir(path, parent, path, targetPath);
        if (this.closed) return;
        // preserve this symlink's target path
        if (targetPath !== undefined) this.symlinkPaths.set(sysPath.resolve(path), targetPath);
      } else {
        const handleFile = () => {
          if (this.closed) return;
          const dirname = sysPath.dirname(path);
          const basename = sysPath.basename(path);
          const parent = this.getWatchedDir(dirname);
          // stats is always present
          let prevStats: Stats = stats;
          // if the file is already being watched, do nothing
          if (parent.has(basename)) return;
          const file = path;
          const listener = async (path: Path, newStats: Stats) => {
            if (!this.throttle('watch', file, 5)) return;
            if (!newStats || newStats.mtimeMs === 0) {
              try {
                const newStats = await this.stat(file);
                if (this.closed) return;
                // This is broken: we cannot check atime at all, it can be empty (noatime), it can be slowly updated (relatime),
                // modification can be done without read (no atime changed).
                // Correct way:
                // oldmtime !== newmtime -> change
                // oldsize !== size -> change: this way we can catch change, even when mtime is identical
                // Check that `change` event was not fired because of changed only accessTime.
                const at = newStats.atimeMs;
                const mt = newStats.mtimeMs;
                if (!at || at <= mt || mt !== prevStats.mtimeMs)
                  this._emit('change', file, newStats);
                // When inode is changed, we need to re-add file with same path
                if ((isMacos || isLinux) && prevStats.ino !== newStats.ino) {
                  this.closeWatcher(path);
                  this.addWatcher(path, file, listener); // TODO: read file? looks ugly
                }
                prevStats = newStats;
              } catch (error) {
                // Fix issues where mtime is null but file is still present
                this.remove(dirname, basename);
              }
              // Add is about to be emitted if file not already tracked in parent
            } else if (parent.has(basename)) {
              // Check that change event was not fired because of changed only accessTime.
              const at = newStats.atimeMs;
              const mt = newStats.mtimeMs;
              if (!at || at <= mt || mt !== prevStats.mtimeMs) this._emit('change', file, newStats);
              prevStats = newStats;
            }
          };
          // Kick off the watcher
          this.addWatcher(path, file, listener);
          // Emit an add event if we're supposed to
          if (!(initialAdd && this.options.ignoreInitial) && !this.isIgnored(file)) {
            if (!this.throttle('add', file, 0)) return;
            this._emit('add', file, stats);
          }
        };
        handleFile();
      }

      this.emitReady();
      return false;
    } catch (error) {
      this.emitReady();
      return path;
    }
  }

  private emitWithAll(event: EventName, args: EmitArgs) {
    this.emit(...args);
    if (event !== 'error') this.emit('all', ...args);
  }
  // Common helpers
  // --------------
  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @param {EventName} event Type of event
   * @param {Path} path File or directory path
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  private async _emit(event: EventName, path: Path, stats?: Stats) {
    if (this.closed) return;
    const opts = this.options;
    if (isWindows) path = sysPath.normalize(path);
    if (opts.cwd) path = sysPath.relative(opts.cwd, path);
    const args: EmitArgs = [event, path];
    if (stats !== undefined) args.push(stats);
    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this.pendingWrites.get(path))) {
      pw.lastChange = Date.now();
      return this;
    }
    if (opts.atomic) {
      if (event === 'unlink') {
        this.pendingUnlinks.set(path, args);
        setTimeout(
          () => {
            this.pendingUnlinks.forEach((entry: EmitArgs, path: Path) => {
              this.emit(...entry);
              this.emit('all', ...entry);
              this.pendingUnlinks.delete(path);
            });
          },
          typeof opts.atomic === 'number' ? opts.atomic : 100 // TODO: defaults should be in constructor
        );
        return this;
      }
      if (event === 'add' && this.pendingUnlinks.has(path)) {
        event = args[0] = 'change';
        this.pendingUnlinks.delete(path);
      }
    }
    const fullPath = opts.cwd ? sysPath.join(opts.cwd, path) : path;
    if (
      opts.alwaysStat &&
      stats === undefined &&
      (event === 'add' || event === 'addDir' || event === 'change')
    ) {
      let stats;
      try {
        stats = await this.stat(fullPath);
      } catch (err) {
        // do nothing
      }
      // Suppress event when fs_stat fails, to avoid sending undefined 'stat'
      if (!stats || this.closed) return;
      args.push(stats);
    }
    if (
      awf &&
      typeof awf === 'object' &&
      (event === 'add' || event === 'change') &&
      this.readyEmitted
    ) {
      const threshold = awf.stabilityThreshold;
      if (!this.pendingWrites.has(path)) {
        let timeoutHandler;
        this.pendingWrites.set(path, {
          lastChange: Date.now(),
          cancelWait: () => {
            this.pendingWrites.delete(path);
            clearTimeout(timeoutHandler);
            return event;
          },
        });
        // TODO: cleanup
        const awaitWriteFinish = async (prevStat?: Stats) => {
          try {
            const curStat = await this.stat(fullPath);
            if (!this.pendingWrites.has(path)) return;
            const now = Date.now();
            if (prevStat && curStat.size !== prevStat.size)
              this.pendingWrites.get(path).lastChange = now;
            const pw = this.pendingWrites.get(path);
            const df = now - pw.lastChange;
            if (df >= threshold) {
              this.pendingWrites.delete(path);
              this.emitWithAll(event, [event, path, curStat]);
            } else timeoutHandler = setTimeout(awaitWriteFinish, awf.pollInterval, curStat);
          } catch (err) {
            if (err && err.code !== 'ENOENT') this.emitWithAll(event, ['error', err as any]);
          }
        };
        timeoutHandler = setTimeout(awaitWriteFinish, awf.pollInterval);
      }
      return this;
    }
    if (event === 'change' && !this.throttle('change', path, 50)) return this;
    this.emitWithAll(event, args);
    return this;
  }
  /**
   * Common handler for errors
   */
  private handleError(error: Error & { code?: string }, path?: Path) {
    const code = error && error.code;
    if (
      error &&
      code !== 'ENOENT' &&
      code !== 'ENOTDIR' &&
      (!this.options.ignorePermissionErrors || (code !== 'EPERM' && code !== 'EACCES'))
    ) {
      // TODO: this problem still exists in node v18 + windows 11
      // supressing error doesn't actually fix it, since watcher is unusable after that
      // Worth fixing later
      // Workaround for https://github.com/joyent/node/issues/4337
      if (isWindows && error.code === 'EPERM') {
        (async () => {
          if (await this.canOpen(path)) this.emit('error', error);
        })();
        return;
      }
      this.emit('error', error);
    }
  }
  /**
   * Determines whether user has asked to ignore this path.
   */
  private isIgnored(path: Path, stats?: Stats) {
    // Temporary files for editors with atomic write. This probably should be handled separately.
    const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
    if (this.options.atomic && DOT_RE.test(path)) return true;
    if (!this.userIgnored) {
      const list: Matcher[] = [...this.ignoredPaths, ...(this.options.ignored || [])].map((path) =>
        typeof path === 'string' ? this.normalizePath(path) : path
      );
      // Early cache for matchers.
      const patterns = list.map((matcher) => {
        if (typeof matcher === 'function') return matcher;
        if (typeof matcher === 'string') return (string) => matcher === string;
        if (matcher instanceof RegExp) return (string) => matcher.test(string);
        // TODO: remove / refactor
        if (typeof matcher === 'object' && matcher !== null) {
          return (string) => {
            if (matcher.path === string) return true;
            if (matcher.recursive) {
              const relative = sysPath.relative(matcher.path, string);
              if (!relative) return false;
              return !relative.startsWith('..') && !sysPath.isAbsolute(relative);
            }
            return false;
          };
        }
        return () => false;
      });
      this.userIgnored = (path: string, stats?: Stats): boolean => {
        path = this.normalizePath(path);
        for (const pattern of patterns) if (pattern(path, stats)) return true;
        return false;
      };
    }
    return this.userIgnored(path, stats);
  }
  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  private remove(directory: string, item: string, isDirectory?: boolean) {
    // When a directory is deleted, get its paths for recursive deletion
    // and cleaning of watched object.
    // When not a directory, nestedDirectoryChildren will be empty.
    const path = sysPath.join(directory, item);
    const fullPath = sysPath.resolve(path);
    isDirectory =
      isDirectory != null ? isDirectory : this.watched.has(path) || this.watched.has(fullPath);
    // prevent duplicate handling in case of arriving here nearly simultaneously
    // via multiple paths (such as _handleFile and _handleDir)
    if (!this.throttle('remove', path, 100)) return;
    // if the only watched file is removed, watch for its return
    if (!isDirectory && this.watched.size === 1) this.add(directory, item, true);
    // This will create a new entry in the watched object in either case
    // so we got to do the directory check beforehand
    const wp = this.getWatchedDir(path);
    // Recursively remove children directories / files.
    wp.forEach((nested) => this.remove(path, nested));
    // Check if item was on the watched list and remove it
    const parent = this.getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.delete(item);
    this.canOpenDir(directory);
    // Fixes issue #1042 -> Relative paths were detected and added as symlinks
    // (https://github.com/paulmillr/chokidar/blob/e1753ddbc9571bdc33b4a4af172d52cb6e611c10/lib/nodefs-handler.js#L612),
    // but never removed from the map in case the path was deleted.
    // This leads to an incorrect state if the path was recreated:
    // https://github.com/paulmillr/chokidar/blob/e1753ddbc9571bdc33b4a4af172d52cb6e611c10/lib/nodefs-handler.js#L553
    if (this.symlinkPaths.has(fullPath)) this.symlinkPaths.delete(fullPath);
    // If we wait for this file to be fully written, cancel the wait.
    let relPath = path;
    if (this.options.cwd) relPath = sysPath.relative(this.options.cwd, path);
    if (this.options.awaitWriteFinish && this.pendingWrites.has(relPath)) {
      const event = this.pendingWrites.get(relPath).cancelWait();
      if (event === 'add') return;
    }
    // The Entry will either be a directory that just got removed
    // or a bogus entry to a file, in either case we have to remove it
    this.watched.delete(path);
    this.watched.delete(fullPath);
    const eventName: EventName = isDirectory ? 'unlinkDir' : 'unlink';
    if (wasTracked && !this.isIgnored(path)) this._emit(eventName, path);
    // Avoid conflicts if we later create another file with the same name
    this.closeWatcher(path);
  }

  // Public API
  /**
   * Adds paths to be watched on an existing FSWatcher instance
   * @param {Path|Array<Path>} paths_
   * @param {String=} _origAdd private; for handling non-existent paths to be watched
   * @param {Boolean=} _internal private; indicates a non-user add
   * @returns {FSWatcher} for chaining
   */
  add(paths_: Path | Path[], _origAdd?: string, _internal?: boolean) {
    this.closed = false;
    const paths = this.normalizePaths(paths_);
    paths.forEach((matcher) => {
      this.ignoredPaths.delete(matcher);
      // now find any matcher objects with the matcher as path
      if (typeof matcher === 'string') {
        for (const ignored of this.ignoredPaths) {
          // TODO (43081j): make this more efficient.
          // probably just make a `this._ignoredDirectories` or some
          // such thing.
          if (isMatcherObject(ignored) && ignored.path === matcher)
            this.ignoredPaths.delete(ignored);
        }
      }
    });
    this.userIgnored = undefined;
    if (!this.readyCount) this.readyCount = 0;
    this.readyCount += paths.length;
    Promise.all(
      paths.map(async (path) => {
        const res = await this.addToNodeFs(path, !_internal, undefined, 0, _origAdd);
        if (this.closed) return;
        if (res) {
          this.emitReady();
          this.add(sysPath.dirname(res), sysPath.basename(_origAdd || res));
        }
        return res;
      })
    );
    return this;
  }
  /**
   * Close watchers or start ignoring events from specified paths.
   * @param {Path|Array<Path>} paths - string or array of strings, file/directory paths
   * @returns {FSWatcher} for chaining
   */
  unwatch(paths: Path | Path[]) {
    if (this.closed) return this;
    paths = flatten(arrify(paths));
    //paths = this.normalizePaths(paths);
    for (let path of paths) {
      const { cwd } = this.options;
      // If path relative and
      if (!sysPath.isAbsolute(path) && !this.closers.has(path)) {
        if (cwd) path = sysPath.join(cwd, path);
        path = sysPath.resolve(path);
      }
      this.closeWatcher(path);
      if (isMatcherObject(path)) {
        // return early if we already have a deeply equal matcher object
        for (const ignored of this.ignoredPaths) {
          if (
            isMatcherObject(ignored) &&
            ignored.path === path.path &&
            ignored.recursive === path.recursive
          ) {
            continue;
          }
        }
      }
      this.ignoredPaths.add(path);
      this.userIgnored = undefined; // reset the cached userIgnored fn
    }
    return this;
  }
  /**
   * Expose list of watched paths
   * @returns {Record<string, string[]>}
   */
  getWatched() {
    const watchList = {};
    this.watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sysPath.relative(this.options.cwd, dir) : dir;
      watchList[key || '.'] = Array.from(entry).sort();
    });
    return watchList;
  }
  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close() {
    if (this.closed) return this.closePromise;
    this.closed = true;
    // Memory management.
    this.removeAllListeners();
    const closers = [];
    this.closers.forEach((closerList) =>
      closerList.forEach((closer) => {
        const promise = closer();
        if (promise instanceof Promise) closers.push(promise);
      })
    );
    this.userIgnored = undefined;
    // this allows to re-start?
    this.readyCount = 0;
    this.readyEmitted = false;
    this.watched.forEach((dirent) => dirent.clear());
    ['closers', 'watched', 'symlinkPaths', 'throttled'].forEach((key) => {
      this[key].clear();
    });
    this.metrics = {};
    this.closePromise = closers.length
      ? Promise.all(closers).then(() => undefined)
      : Promise.resolve();
    return this.closePromise;
  }
}

// Public API

/**
 * Instantiates watcher with paths to be tracked.
 * @param paths file/directory paths and/or globs
 * @param options chokidar opts
 * @returns an instance of FSWatcher for chaining.
 */
export const watch = (paths: Path | Path[], options: ChokidarOptions) => {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
};

export default { watch, FSWatcher };
