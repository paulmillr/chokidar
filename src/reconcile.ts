import type { Stats } from 'node:fs';
import { realpath as fsrealpath, lstat, readlink, stat } from 'node:fs/promises';
import * as sp from 'node:path';
import type { EntryInfo, ReaddirpStream } from 'readdirp';
import {
  backendNow,
  isMissingObservation,
  setFsWatchListener,
  setPollingListener,
  subscribeRecursiveNative,
} from './backend.js';
import type { WatchHelper } from './runtime.js';
import {
  type BackendResourceKey,
  type BackendSubscription,
  type BackendTrigger,
  EVENTS,
  type FSWInstanceOptions,
  isMacos,
  isMissingError,
  isStrictlyInside,
  isWindows,
  logicalPathKey,
  type NativeTrigger,
  type Path,
  type SchedulerTimer,
} from './runtime.js';
import { type DirEntry, resolveRecursiveCandidate, type WatcherContext } from './tree.js';

const EV = EVENTS;
const RECURSIVE_TRIGGER_BUFFER_LIMIT = 1024;
const MAX_NATIVE_RESUBSCRIBES = 3;
const FALLBACK_SUBSCRIBE_CONCURRENCY = 16;
type AddPathOutcome = 'complete' | 'watch-parent';
type MappedFileSnapshot = Stats | false;
/** Reconcile exactly one candidate path; its siblings are never scanned. */
type ExactCandidate = { onRootMissing?: () => void };
const EXACT_CANDIDATE: ExactCandidate = Object.freeze({});

/** An invalidation with no name: reconcile the whole subscribed path. */
function recoveryTrigger(resource: string): NativeTrigger {
  return {
    kind: 'native',
    resource: resource as BackendResourceKey,
    rawEvent: EV.CHANGE,
    relativePath: null,
    sequence: Number.MAX_SAFE_INTEGER,
    observedAt: backendNow(),
  };
}

function sameMappedFileSnapshot(left: MappedFileSnapshot, right: MappedFileSnapshot): boolean {
  if (left === false || right === false) return left === right;
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

class ReplayBuffer<T> {
  readonly entries: T[] = [];
  overflow?: T;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get overflowed(): boolean {
    return this.overflow !== undefined;
  }
  push(value: T): void {
    if (this.entries.length < this.limit && !this.overflowed) this.entries.push(value);
    else this.overflow = value;
  }
  clear(): void {
    this.entries.length = 0;
    this.overflow = undefined;
  }
}

type ScanOutcome = { complete: boolean; error?: unknown; failures: unknown[] };
/** Collects what a recursive rescan saw so absent tracked entries can be removed. */
type RecursiveRescan = { seen: Set<string>; directories: string[]; complete: boolean };
function consumeDirectoryStream(
  stream: ReaddirpStream,
  onEntry: (entry: EntryInfo) => void | Promise<void>
): Promise<ScanOutcome> {
  const tasks: Promise<void>[] = [];
  stream.on('data', (entry) => {
    let result: void | Promise<void>;
    try {
      result = onEntry(entry);
    } catch (error) {
      result = Promise.reject(error);
    }
    if (!result) return;
    tasks.push(Promise.resolve(result));
  });
  return new Promise<{ complete: boolean; error?: unknown }>((resolve) => {
    stream.once('end', () => resolve({ complete: true }));
    stream.once('close', () => resolve({ complete: false }));
    stream.once(EV.ERROR, (error) => resolve({ complete: false, error }));
  }).then(async ({ complete, error }) => {
    const settled = await Promise.allSettled(tasks);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    return { complete: complete && failures.length === 0, error, failures };
  });
}

const binaryExtensions = new Set(
  `3dm 3ds 3g2 3gp 7z a aac adp afdesign afphoto afpub ai aif aiff alz ape apk appimage ar arj asf au avi bak baml bh bin bk bmp btif bz2 bzip2 cab caf cgm class cmx cpio cr2 cur dat dcm deb dex djvu dll dmg dng doc docm docx dot dotm dra ds_store dsk dts dtshd dvb dwg dxf ecelp4800 ecelp7470 ecelp9600 egg eol eot epub exe f4v fbs fh fla flac flatpak fli flv fpx fst fvt g3 gh gif graffle gz gzip h261 h263 h264 icns ico ief img ipa iso jar jpeg jpg jpgv jpm jxr key ktx lha lib lvp lz lzh lzma lzo m3u m4a m4v mar mdi mht mid midi mj2 mka mkv mmr mng mobi mov movie mp3 mp4 mp4a mpeg mpg mpga mxu nef npx numbers nupkg o odp ods odt oga ogg ogv otf ott pages pbm pcx pdb pdf pea pgm pic png pnm pot potm potx ppa ppam ppm pps ppsm ppsx ppt pptm pptx psd pya pyc pyo pyv qt rar ras raw resources rgb rip rlc rmf rmvb rpm rtf rz s3m s7z scpt sgi shar snap sil sketch slk smv snk so stl suo sub swf tar tbz tbz2 tga tgz thmx tif tiff tlz ttc ttf txz udf uvh uvi uvm uvp uvs uvu viv vob war wav wax wbmp wdp weba webm webp whl wim wm wma wmv wmx woff woff2 wrm wvx xbm xif xla xlam xls xlsb xlsm xlsx xlt xltm xltx xm xmind xpi xpm xwd xz z zip zipx`.split(
    ' '
  )
);
function isBinaryPath(filePath: string) {
  return binaryExtensions.has(sp.extname(filePath).slice(1).toLowerCase());
}

/** The only scanner, subscriber, and filesystem transition engine. */
export class ObservationEngine {
  fsw: WatcherContext;
  reportError: (error: unknown) => void;
  constructor(fsW: WatcherContext) {
    this.fsw = fsW;
    this.reportError = (error) => fsW.handleError(error);
  }

  /**
   * Watch a path with the owned polling scheduler or fs.watch.
   * @param path to file or dir
   * @param listener on fs change
   * @returns closer for the watcher instance
   */
  subscribePath(
    path: string,
    listener: (
      path: string,
      newStats: Stats | undefined,
      trigger: BackendTrigger
    ) => void | Promise<void>,
    initialStats?: Stats,
    mapRelative = false,
    queueScope: string = path
  ): (() => void | Promise<void>) | undefined {
    const opts = this.fsw.options;
    const basename = sp.basename(path);
    const absolutePath = sp.resolve(path);
    const options: Partial<FSWInstanceOptions> = {
      persistent: opts.persistent,
    };
    const generation = this.fsw.lifecycle.generation;
    let active = true;
    const trackedListener = (
      watchedPath: string,
      stats: Stats | undefined,
      trigger: BackendTrigger
    ): void | Promise<void> => {
      if (!active || !this.fsw.lifecycle.isActive(generation)) return;
      return listener(watchedPath, stats, trigger);
    };
    const publish = (trigger: BackendTrigger): void => {
      void this.reconcileBackendTrigger(
        path,
        mapRelative,
        trigger,
        (candidate) =>
          trackedListener(
            candidate,
            trigger.kind === 'poll' && !isMissingObservation(trigger.current)
              ? trigger.current
              : undefined,
            trigger
          ),
        () => active && this.fsw.lifecycle.isActive(generation),
        true,
        queueScope
      );
    };

    let subscription: BackendSubscription | undefined;
    let resubscribes = 0;
    const subscribeNative = (): BackendSubscription | undefined =>
      setFsWatchListener(
        path,
        absolutePath,
        options,
        {
          publish: (trigger) => {
            resubscribes = 0;
            publish(trigger);
          },
          errHandler: this.reportError,
          rawEmitter: (...args) => this.fsw.emitRaw(...args),
          failure: () => {
            if (!active || !this.fsw.lifecycle.isActive(generation)) return;
            subscription = resubscribes++ < MAX_NATIVE_RESUBSCRIBES ? subscribeNative() : undefined;
            publish(recoveryTrigger(absolutePath));
          },
        },
        this.fsw.lifecycle.abortController.signal
      );
    if (opts.backendCapabilities.polling) {
      const enableBin = opts.pollingInterval !== opts.pollingBinaryInterval;
      const pollingInterval =
        enableBin && isBinaryPath(basename) ? opts.pollingBinaryInterval : opts.pollingInterval;
      subscription = setPollingListener(
        path,
        absolutePath,
        { interval: pollingInterval, persistent: opts.persistent },
        this.fsw.scheduler,
        {
          publish,
          errHandler: this.reportError,
          rawEmitter: (...args) => this.fsw.emitRaw(...args),
        },
        initialStats,
        this.fsw.lifecycle.abortController.signal
      );
    } else {
      subscription = subscribeNative();
    }
    if (!subscription) return;
    return () => {
      if (!active) return;
      active = false;
      return subscription?.close();
    };
  }

  /**
   * Watch a followed file symlink through the target's parent directory.
   * macOS also starts a one-shot exact-target fallback: FSEvents can omit the
   * first directory callback immediately after a subscription is established.
   */
  subscribeMappedFile(
    logicalPath: string,
    targetPath: string,
    helper: WatchHelper,
    depth: number,
    useExactFallback: boolean = isMacos
  ): (() => void | Promise<void>) | undefined {
    if (this.fsw.options.backendCapabilities.polling) return;
    const targetDirectory = sp.dirname(targetPath);
    const targetKey = logicalPathKey(targetPath);
    const logicalParent = sp.dirname(logicalPath);
    const generation = this.fsw.lifecycle.generation;
    let active = true;
    let exactActive = useExactFallback;
    let suppressDirectoryEcho = false;
    let fallbackSnapshot: MappedFileSnapshot | undefined;
    let directorySubscription: BackendSubscription | undefined;
    let exactSubscription: BackendSubscription | undefined;
    const isActive = () =>
      active && this.fsw.lifecycle.isActive(generation) && this.isHelperActive(helper, logicalPath);
    const matchesTarget = (relativePath: string | null): boolean => {
      if (relativePath === null) return true;
      const candidate = sp.isAbsolute(relativePath)
        ? relativePath
        : sp.resolve(targetDirectory, relativePath);
      const candidateKey = logicalPathKey(candidate);
      return isWindows
        ? candidateKey.toLowerCase() === targetKey.toLowerCase()
        : candidateKey === targetKey;
    };
    const retireExact = (): void => {
      if (!exactActive) return;
      exactActive = false;
      if (exactSubscription) void exactSubscription.close();
    };
    const publish = (source: 'directory' | 'exact', trigger: BackendTrigger): void => {
      if (trigger.kind !== 'native' || !matchesTarget(trigger.relativePath) || !isActive()) return;
      const deduplicateAgainstFallback = source === 'directory' && suppressDirectoryEcho;
      if (source === 'directory') {
        suppressDirectoryEcho = false;
        retireExact();
      } else if (directorySubscription) {
        suppressDirectoryEcho = true;
        retireExact();
      }
      void this.reconcileBackendTrigger(
        targetDirectory,
        true,
        trigger,
        async () => {
          if (deduplicateAgainstFallback && fallbackSnapshot !== undefined) {
            const current = await this.mappedFileSnapshot(targetPath);
            if (current !== undefined && sameMappedFileSnapshot(fallbackSnapshot, current)) return;
          }
          await this.reconcileNativeTrigger(
            logicalParent,
            helper,
            trigger,
            logicalPath,
            depth - 1,
            EXACT_CANDIDATE
          );
          if (source === 'exact') fallbackSnapshot = await this.mappedFileSnapshot(targetPath);
        },
        isActive,
        false,
        logicalPath
      );
    };
    let resubscribes = 0;
    const handlers = (source: 'directory' | 'exact') => ({
      publish: (trigger: BackendTrigger): void => {
        if (source === 'directory') resubscribes = 0;
        publish(source, trigger);
      },
      errHandler: this.reportError,
      rawEmitter: (event: 'rename' | 'change', relativePath: string | null): void => {
        if ((source === 'directory' || exactActive) && matchesTarget(relativePath) && isActive()) {
          this.fsw.emitRaw(event, relativePath, { watchedPath: logicalPath });
        }
      },
      failure: (): void => {
        if (source === 'exact') {
          exactSubscription = undefined;
          exactActive = false;
          return;
        }
        directorySubscription = undefined;
        if (!isActive()) return;
        // Re-establish the retired handle and reconcile anything it missed.
        if (resubscribes++ < MAX_NATIVE_RESUBSCRIBES) directorySubscription = subscribe(source);
        publish(source, recoveryTrigger(sp.resolve(targetDirectory)));
      },
    });
    const subscribe = (source: 'directory' | 'exact'): BackendSubscription | undefined => {
      const path = source === 'directory' ? targetDirectory : targetPath;
      return setFsWatchListener(
        path,
        sp.resolve(path),
        { persistent: this.fsw.options.persistent },
        handlers(source),
        this.fsw.lifecycle.abortController.signal
      );
    };
    directorySubscription = subscribe('directory');
    exactSubscription = useExactFallback ? subscribe('exact') : undefined;
    if (!exactSubscription) exactActive = false;
    if (!directorySubscription && !exactSubscription) return;
    return async () => {
      if (!active) return;
      active = false;
      const subscriptions = [directorySubscription, exactSubscription].filter(
        (subscription): subscription is BackendSubscription => subscription !== undefined
      );
      await Promise.allSettled(subscriptions.map((subscription) => subscription.close()));
    };
  }

  private async mappedFileSnapshot(path: string): Promise<MappedFileSnapshot | undefined> {
    try {
      return await lstat(path);
    } catch (error) {
      if (isMissingError(error)) return false;
      this.reportError(error);
      return;
    }
  }

  /**
   * macOS can follow an exact symlink handle and miss the link's own removal.
   * Check only link existence so target-directory activity stays invisible when
   * followSymlinks is disabled.
   */
  watchSymlinkDeletion(path: string, force = false): (() => void) | undefined {
    if ((!isMacos && !force) || this.fsw.options.backendCapabilities.polling) return;
    const fsw = this.fsw;
    const generation = fsw.lifecycle.generation;
    const directory = sp.dirname(path);
    const basename = sp.basename(path);
    let active = true;
    let timer: SchedulerTimer | undefined;

    const schedule = () => {
      timer = fsw.scheduler.setTimeout(() => {
        timer = undefined;
        void (async () => {
          try {
            await lstat(path);
          } catch (error) {
            if (!active || !fsw.lifecycle.isActive(generation)) return;
            if (isMissingError(error)) {
              active = false;
              fsw.removePath(directory, basename);
              return;
            }
            this.reportError(error);
          }
          if (active && fsw.lifecycle.isActive(generation)) schedule();
        })();
      }, fsw.options.pollingInterval);
      if (!fsw.options.persistent) timer.unref();
    };
    schedule();

    return () => {
      if (!active) return;
      active = false;
      fsw.scheduler.clearTimeout(timer);
      timer = undefined;
    };
  }

  /**
   * Map one backend notification into a logical candidate and serialize its
   * filesystem reconciliation in the owning watcher instance.
   */
  reconcileBackendTrigger(
    scope: string,
    mapRelative: boolean,
    trigger: BackendTrigger,
    reconcile: (candidate: string) => void | Promise<void>,
    isActive: () => boolean = () => true,
    coalesce = true,
    queueScope: string = scope
  ): Promise<void> {
    let candidate = scope;
    if (mapRelative && trigger.kind === 'native' && trigger.relativePath !== null) {
      const resolved = resolveRecursiveCandidate(scope, trigger.relativePath);
      if (!resolved) {
        this.reportError(
          new Error(`Watcher reported a path outside its root: ${trigger.relativePath}`)
        );
        return Promise.resolve();
      }
      candidate = resolved;
    }
    if (!isActive() || this.fsw.isUnwatched(candidate)) return Promise.resolve();
    const rootKey = logicalPathKey(queueScope);
    const candidateKey = logicalPathKey(candidate);
    return this.fsw.reconciliation.enqueue(
      rootKey,
      async () => {
        if (!isActive() || this.fsw.isUnwatched(candidateKey)) return;
        await reconcile(candidate);
      },
      coalesce ? candidateKey : false
    );
  }

  /**
   * Watch a file and emit add event if warranted.
   * @returns closer for the watcher instance
   */
  handleFile(
    file: Path,
    stats: Stats,
    initialAdd: boolean,
    watchResource = true,
    trigger?: NativeTrigger,
    initialRecursive = false,
    retainObservation = false
  ): (() => void | Promise<void>) | undefined {
    if (this.fsw.closed) {
      return;
    }
    const dirname = sp.dirname(file);
    const basename = sp.basename(file);
    const parent = this.fsw.tree.getDirectory(dirname);
    // stats is always present
    let prevStats = stats;

    // if the file is already being watched, do nothing
    if (parent.has(basename)) return;
    const pathGeneration = this.fsw.capturePathGeneration();
    const isActive = () => this.fsw.isPathGenerationActive(file, pathGeneration);

    const listener = async (_path: Path, newStats?: Stats) => {
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats =
            prevStats.isSymbolicLink() && !this.fsw.options.followSymlinks
              ? await lstat(file)
              : await stat(file);
          // unwatch() may have retired this file while the stat was in flight.
          if (!isActive()) return;
          // Check that change event was not fired because of changed only accessTime.
          const at = newStats.atimeMs;
          const mt = newStats.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw.emitEvent(EV.CHANGE, file, newStats);
          }
          this.fsw.tree.recordObserved(file, newStats, 'change');
          prevStats = newStats;
        } catch (error) {
          if (!isActive()) return;
          if (isMissingError(error)) {
            this.fsw.removePath(dirname, basename);
          } else {
            this.reportError(error);
          }
        }
        // add is about to be emitted if file not already tracked in parent
      } else if (parent.has(basename)) {
        // Check that change event was not fired because of changed only accessTime.
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw.emitEvent(EV.CHANGE, file, newStats);
        }
        this.fsw.tree.recordObserved(file, newStats, 'change');
        prevStats = newStats;
      }
    };
    // kick off the watcher
    const watchesFile = watchResource && this.fsw.options.backendCapabilities.polling;
    const closer = watchesFile ? this.subscribePath(file, listener, stats) : undefined;
    parent.add(basename);
    this.fsw.tree.recordObserved(file, stats, 'add', trigger, initialRecursive, retainObservation);

    // emit an add event if we're supposed to
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !this.fsw.isIgnored(file, stats)) {
      this.fsw.emitEvent(EV.ADD, file, stats);
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
  async handleSymlink(
    entry: EntryInfo,
    directory: string,
    path: Path,
    item: string,
    initialAdd: boolean,
    wh?: WatchHelper
  ): Promise<boolean | undefined> {
    if (this.fsw.closed || (wh && !this.isHelperActive(wh, path))) {
      return;
    }
    const full = logicalPathKey(entry.fullPath);
    const dir = this.fsw.tree.getDirectory(directory);

    if (!this.fsw.options.followSymlinks) {
      // watch symlink directly (don't follow) and detect changes
      let linkPath;
      try {
        linkPath = await readlink(path);
      } catch (error) {
        if (!isMissingError(error)) this.reportError(error);
        return true;
      }

      if (this.fsw.closed || (wh && !this.isHelperActive(wh, path))) {
        return true;
      }
      if (dir.has(item)) {
        if (this.fsw.tree.symlinkPaths.get(full) !== linkPath) {
          this.fsw.tree.symlinkPaths.set(full, linkPath);
          this.fsw.emitEvent(EV.CHANGE, path, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw.tree.symlinkPaths.set(full, linkPath);
        this.fsw.tree.recordObserved(
          path,
          entry.stats!,
          'add',
          wh?.observationTrigger,
          initialAdd && Boolean(wh?.recursiveRoot)
        );
        if (!(initialAdd && this.fsw.options.ignoreInitial)) {
          this.fsw.emitEvent(EV.ADD, path, entry.stats);
        }
      }
      return true;
    }

    // don't follow the same symlink more than once
    if (this.fsw.tree.symlinkPaths.has(full)) {
      return true;
    }

    this.fsw.tree.symlinkPaths.set(full, true);
  }

  readDirectory(
    directory: string,
    initialAdd: boolean,
    wh: WatchHelper,
    target: Path | undefined,
    dir: Path,
    depth: number
  ): Promise<void> | undefined {
    if (!this.isHelperActive(wh, directory)) return;
    // Normalize the directory name on Windows
    directory = sp.join(directory, '');

    const directoryKey = logicalPathKey(directory);
    const previous = this.fsw.tree.getDirectory(wh.watchPath);
    const current = new Set<string>();

    const stream = this.fsw.createScanStream(directory, {
      fileFilter: (entry: EntryInfo) => wh.filterPath(entry),
      directoryFilter: (entry: EntryInfo) => wh.filterDir(entry),
    });
    if (!stream) return;
    const scan = consumeDirectoryStream(stream, (entry) => {
      if (!this.isHelperActive(wh, directory)) return;
      const stats = entry.stats;
      if (!stats) return;
      const item = entry.path;
      let path = sp.join(directory, item);
      if (!this.isHelperActive(wh, path)) return;
      current.add(item);

      const shouldAdd = item === target || (!target && !previous.has(item));
      if (target === undefined && !stats.isSymbolicLink() && !stats.isDirectory()) {
        if (!shouldAdd) return;
        path = sp.join(dir, sp.relative(dir, path));
        const closer = this.handleFile(
          path,
          stats,
          initialAdd,
          !wh.recursiveRoot,
          wh.observationTrigger,
          initialAdd && Boolean(wh.recursiveRoot)
        );
        if (closer) this.fsw.addPathCloser(path, closer);
        return;
      }

      return (async () => {
        if (
          stats.isSymbolicLink() &&
          (await this.handleSymlink(entry, directory, path, item, initialAdd, wh))
        ) {
          return;
        }

        if (!this.isHelperActive(wh, path)) return;
        // Files that present in current directory snapshot
        // but absent in previous are added to watch list and
        // emit `add` event.
        if (shouldAdd) {
          // ensure relativeness of path is preserved in case of watcher reuse
          path = sp.join(dir, sp.relative(dir, path));

          await this.addPathOnce(path, initialAdd, wh, depth + 1);
        }
      })();
    });

    return scan.then(async ({ complete, error, failures }) => {
      failures.forEach(this.reportError);

      if (error) {
        if (isMissingError(error) && this.isHelperActive(wh, directory)) {
          const affectedPath = target ? sp.join(directory, target) : directory;
          let disappeared = false;
          let becameNonDirectory = false;
          try {
            const currentStats = target ? await lstat(affectedPath) : await stat(affectedPath);
            becameNonDirectory = !target && !currentStats.isDirectory();
          } catch (stateError) {
            if (isMissingError(stateError)) disappeared = true;
            else this.reportError(stateError);
          }

          if (target) {
            if (disappeared && previous.has(target)) this.fsw.removePath(directory, target);
          } else if (
            (disappeared || becameNonDirectory) &&
            this.fsw.tree.watched.has(directoryKey)
          ) {
            this.fsw.removePath(sp.dirname(directory), sp.basename(directory), true);
            if (becameNonDirectory) {
              await this.addPathOnce(directory, false, wh, depth);
            }
          }
        } else {
          this.reportError(error);
        }
      }
      if (!complete || !this.isHelperActive(wh, directory)) {
        return;
      }

      // Entries tracked but absent from this listing are removed only once
      // lstat confirms they are gone: another queue may have added them after
      // the listing, and readdirp reports unreadable entries as warnings.
      await Promise.all(
        previous
          .getChildren()
          .filter((item) => !current.has(item))
          .map((item) => this.removeIfMissing(wh, directory, item, previous))
      );
    });
  }

  private async removeIfMissing(
    wh: WatchHelper,
    directory: string,
    item: string,
    entry: DirEntry
  ): Promise<void> {
    const path = sp.join(directory, item);
    if (!this.isHelperActive(wh, path)) return;
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (!isMissingError(error)) return;
    }
    if (this.isHelperActive(wh, path) && entry.has(item)) this.fsw.removePath(directory, item);
  }

  /**
   * Populate the logical directory tree beneath one native recursive watcher.
   * Regular entries are consumed synchronously from readdirp's stat-bearing
   * stream; only symlinks need the full per-path add machinery.
   */
  scanRecursiveTree(
    dir: string,
    initialAdd: boolean,
    wh: WatchHelper,
    baseDepth: number,
    rescan?: RecursiveRescan
  ): Promise<void> | undefined {
    if (!this.isHelperActive(wh, dir)) return;
    const fsw = this.fsw;
    const maxDepth = fsw.options.depth;
    const remainingDepth = maxDepth === undefined ? undefined : maxDepth - baseDepth;
    const stream = fsw.createScanStream(dir, {
      fileFilter: (entry: EntryInfo) => wh.filterPath(entry),
      directoryFilter: (entry: EntryInfo) => !entry.stats?.isSymbolicLink() && wh.filterDir(entry),
      depth: remainingDepth,
    });
    if (!stream) return;

    return consumeDirectoryStream(stream, (entry) => {
      if (!this.isHelperActive(wh, dir)) return;
      const stats = entry.stats;
      if (!stats) return;
      const path = sp.join(dir, entry.path);
      if (!this.isHelperActive(wh, path)) return;
      const directory = sp.dirname(path);
      const item = sp.basename(path);
      if (rescan) {
        rescan.seen.add(logicalPathKey(path));
        if (stats.isDirectory()) rescan.directories.push(path);
      }

      if (stats.isSymbolicLink()) {
        return (async () => {
          if (await this.handleSymlink(entry, directory, path, item, initialAdd, wh)) return;
          if (!this.isHelperActive(wh, path)) return;
          const entryDepth = baseDepth + entry.path.split(/[/\\]/).length;
          await this.addPathOnce(path, initialAdd, wh, entryDepth);
        })();
      }

      const parent = fsw.tree.getDirectory(directory);
      if (parent.has(item)) {
        // A rescan stands in for invalidations the backend dropped, so it also
        // reports writes to files whose recorded stat fact no longer matches.
        if (rescan && stats.isFile() && fsw.tree.changedSinceObserved(path, stats)) {
          fsw.tree.recordObserved(path, stats, 'change', undefined, false, true);
          fsw.emitEvent(EV.CHANGE, path, stats);
        }
        return;
      }
      parent.add(item);
      const isDirectory = stats.isDirectory();
      if (isDirectory) fsw.tree.getDirectory(path);
      fsw.tree.recordObserved(path, stats, 'add', wh.observationTrigger, initialAdd);
      if (!(initialAdd && fsw.options.ignoreInitial)) {
        fsw.emitEvent(isDirectory ? EV.ADD_DIR : EV.ADD, path, stats);
      }
    }).then((outcome) => {
      if (outcome.error) this.reportError(outcome.error);
      outcome.failures.forEach(this.reportError);
      if (rescan) rescan.complete = outcome.complete;
    });
  }

  /**
   * Reconcile a whole recursive root after an invalidation that names no path
   * (a backend buffer overflow) or a replay buffer overflow. A shallow root
   * listing would miss every change below the first level.
   */
  async rescanRecursiveTree(dir: string, wh: WatchHelper, baseDepth: number): Promise<void> {
    const rescan: RecursiveRescan = { seen: new Set(), directories: [dir], complete: false };
    await this.scanRecursiveTree(dir, false, wh, baseDepth, rescan);
    if (!rescan.complete || !this.isHelperActive(wh, dir)) return;
    // Only fully listed real directories can prove that a child is gone;
    // symlinked and ignored subtrees are not descended into.
    const missing: string[] = [];
    for (const directory of rescan.directories) {
      for (const item of this.fsw.tree.peekDirectory(directory)?.getChildren() ?? []) {
        const path = sp.join(directory, item);
        if (!rescan.seen.has(logicalPathKey(path))) missing.push(path);
      }
    }
    missing.sort((left, right) => left.length - right.length);
    for (const path of missing) {
      const entry = this.fsw.tree.peekDirectory(sp.dirname(path));
      // An ancestor removed earlier in this pass already took its subtree.
      if (entry?.has(sp.basename(path))) {
        await this.removeIfMissing(wh, sp.dirname(path), sp.basename(path), entry);
      }
    }
  }

  isHelperActive(wh: WatchHelper, path: string = wh.watchPath): boolean {
    return this.fsw.isPathGenerationActive(path, wh.pathGeneration);
  }

  private candidateDepth(root: string, candidate: string): number {
    const relative = sp.relative(root, candidate);
    return relative ? relative.split(sp.sep).length : 0;
  }

  private candidateIgnored(root: string, candidate: string, stats?: Stats): boolean {
    const relative = sp.relative(root, candidate);
    let ancestor = root;
    if (this.fsw.isIgnored(ancestor)) return true;
    if (relative) {
      const parts = relative.split(sp.sep);
      for (let index = 0; index < parts.length - 1; index++) {
        ancestor = sp.join(ancestor, parts[index]);
        if (this.fsw.isIgnored(ancestor)) return true;
      }
    }
    return this.fsw.isIgnored(candidate, stats);
  }

  private async highestMissingPath(root: string, candidate: string): Promise<string> {
    let missing = candidate;
    let ancestor = sp.dirname(candidate);
    while (true) {
      try {
        await lstat(ancestor);
        return missing;
      } catch (error) {
        if (!isMissingError(error)) {
          this.reportError(error);
          return missing;
        }
      }
      missing = ancestor;
      if (ancestor === root) return missing;
      const parent = sp.dirname(ancestor);
      if (parent === ancestor) return missing;
      ancestor = parent;
    }
  }

  async reconcileNativeTrigger(
    root: string,
    rootHelper: WatchHelper,
    trigger: NativeTrigger,
    candidateOverride?: string,
    baseDepth = 0,
    exact?: ExactCandidate
  ): Promise<void> {
    // An exact subscription observes one path inside `root`; an untracked or
    // unreadable candidate never justifies scanning its siblings.
    const fsw = this.fsw;
    if (!this.isHelperActive(rootHelper, root)) return;
    let localHelper: WatchHelper | undefined;
    const helper = (): WatchHelper => (localHelper ??= rootHelper.withObservation(trigger));
    const candidate =
      candidateOverride ??
      (trigger.relativePath === null
        ? root
        : resolveRecursiveCandidate(root, trigger.relativePath));
    if (!candidate) {
      this.reportError(
        new Error(`Native watcher reported a path outside its root: ${trigger.relativePath}`)
      );
      return;
    }

    const depth = baseDepth + this.candidateDepth(root, candidate);
    const maxDepth = fsw.options.depth;
    if (maxDepth !== undefined && depth > maxDepth + 1) return;
    if (this.candidateIgnored(root, candidate)) return;

    let stats: Stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (!isMissingError(error)) {
        this.reportError(error);
        if (exact) return;
        const ancestor = candidate === root ? root : sp.dirname(candidate);
        const ancestorDepth = Math.max(0, baseDepth + this.candidateDepth(root, ancestor));
        await this.readDirectory(
          ancestor,
          false,
          helper().fork(ancestor),
          undefined,
          ancestor,
          ancestorDepth
        );
        return;
      }
      if (fsw.closed) return;
      const missingPath =
        candidate === root ? root : await this.highestMissingPath(root, candidate);
      if (fsw.closed) return;
      if (missingPath === root) {
        fsw.removePath(sp.dirname(root), sp.basename(root), true);
        exact?.onRootMissing?.();
        return;
      }
      const parentPath = sp.dirname(missingPath);
      const item = sp.basename(missingPath);
      if (fsw.tree.getDirectory(parentPath).has(item)) {
        fsw.removePath(parentPath, item);
      } else if (!exact) {
        await this.readDirectory(
          parentPath,
          false,
          helper().fork(parentPath),
          undefined,
          parentPath,
          Math.max(0, baseDepth + this.candidateDepth(root, parentPath))
        );
      }
      return;
    }

    if (
      !this.isHelperActive(rootHelper, candidate) ||
      this.candidateIgnored(root, candidate, stats)
    ) {
      return;
    }

    if (!stats.isDirectory() && !(stats.isSymbolicLink() && fsw.options.followSymlinks)) {
      const initialCreate = fsw.tree.consumeInitialCreate(
        candidate,
        stats,
        trigger,
        fsw.options.ignoreInitial
      );
      if (initialCreate !== undefined) {
        if (initialCreate) fsw.emitEvent(initialCreate, candidate, stats);
        return;
      }
    }

    if (candidate === root) {
      if (!stats.isDirectory()) return;
      // A nameless invalidation of a recursive root can stand for any change in the tree.
      if (rootHelper.recursiveRoot === root) {
        await this.rescanRecursiveTree(root, helper(), baseDepth);
      } else {
        await this.readDirectory(root, false, helper(), undefined, root, baseDepth);
      }
      return;
    }

    const parentPath = sp.dirname(candidate);
    const item = sp.basename(candidate);
    const parent = fsw.tree.getDirectory(parentPath);
    const tracked = parent.has(item);

    if (stats.isSymbolicLink()) {
      if (!fsw.options.followSymlinks) {
        let target: string | boolean = true;
        try {
          target = await readlink(candidate);
        } catch {}
        if (!tracked) parent.add(item);
        fsw.tree.symlinkPaths.set(logicalPathKey(candidate), target);
        if (!tracked || !fsw.tree.isDuplicateObservation(candidate, stats, trigger)) {
          fsw.emitEvent(tracked ? EV.CHANGE : EV.ADD, candidate, stats);
        }
        if (!tracked) fsw.tree.recordObserved(candidate, stats, 'add', trigger);
        return;
      }

      const logicalKey = logicalPathKey(candidate);
      const previousTarget = fsw.tree.symlinkPaths.get(logicalKey);
      let currentTarget: string | undefined;
      try {
        currentTarget = await fsrealpath(candidate);
      } catch (error) {
        if (!isMissingError(error)) {
          this.reportError(error);
          return;
        }
      }
      const targetChanged =
        tracked &&
        typeof previousTarget === 'string' &&
        (currentTarget === undefined ||
          logicalPathKey(previousTarget) !== logicalPathKey(currentTarget));
      if (targetChanged) {
        const previousKind = fsw.tree.observed.get(logicalKey)?.kind;
        fsw.removePath(parentPath, item, previousKind === 'directory');
        if (!currentTarget || !this.isHelperActive(rootHelper, candidate)) return;
        const linkHelper = helper().fork(candidate);
        linkHelper.recursiveRoot = undefined;
        await this.addPathOnce(candidate, false, linkHelper, depth);
        return;
      }
      const initialCreate = fsw.tree.consumeInitialCreate(
        candidate,
        stats,
        trigger,
        fsw.options.ignoreInitial
      );
      if (initialCreate !== undefined) {
        if (initialCreate) {
          fsw.closePath(candidate, true);
          const linkHelper = helper().fork(candidate);
          linkHelper.recursiveRoot = undefined;
          await this.addPathOnce(candidate, false, linkHelper, depth);
        }
        return;
      }
      if (!tracked) {
        const linkHelper = helper().fork(candidate);
        linkHelper.recursiveRoot = undefined;
        await this.addPathOnce(candidate, false, linkHelper, depth);
      } else {
        fsw.emitEvent(EV.CHANGE, candidate, stats);
      }
      return;
    }

    if (stats.isDirectory()) {
      const directoryHelper = helper().fork(candidate);
      const initialCreate = fsw.tree.consumeInitialCreate(
        candidate,
        stats,
        trigger,
        fsw.options.ignoreInitial
      );
      if (initialCreate !== undefined) {
        if (initialCreate) {
          fsw.closePath(candidate, true);
          await this.addPathOnce(candidate, false, directoryHelper, depth);
        }
        return;
      }
      if (!tracked) {
        await this.addPathOnce(candidate, false, directoryHelper, depth);
      } else if (fsw.tree.replacedSinceObserved(candidate, stats)) {
        // Deleted and recreated before this callback ran: an inode-bound
        // handle still watches the old directory, so replace the whole entry.
        fsw.removePath(parentPath, item, true);
        await this.addPathOnce(candidate, false, directoryHelper, depth);
      } else if (maxDepth === undefined || depth <= maxDepth) {
        await this.readDirectory(candidate, false, directoryHelper, undefined, candidate, depth);
      }
      return;
    }

    if (!tracked) {
      await this.addPathOnce(candidate, false, helper(), depth);
    } else if (!fsw.tree.isDuplicateObservation(candidate, stats, trigger)) {
      fsw.emitEvent(EV.CHANGE, candidate, stats);
    }
  }

  /**
   * Keep a Windows parent handle for a directly watched directory. Windows can
   * silently retire the directory's own handle when an empty root is removed;
   * its parent still receives the namespace transition and can reconcile it.
   */
  watchRootParent(dir: string, wh: WatchHelper): (() => void | Promise<void>) | undefined {
    if (!this.fsw.options.backendCapabilities.perDirectory || !isWindows) return;
    const parentPath = sp.dirname(dir);
    if (sp.resolve(parentPath) === sp.resolve(dir)) return;

    const canonicalParent = sp.normalize(sp.toNamespacedPath(sp.resolve(parentPath))).toLowerCase();
    const rootName = sp.basename(dir).toLowerCase();
    const generation = this.fsw.lifecycle.generation;
    let active = true;
    const matchesRoot = (relativePath: string | null): boolean => {
      if (relativePath === null) return true;
      const candidate = sp.isAbsolute(relativePath)
        ? sp.resolve(relativePath)
        : sp.resolve(parentPath, relativePath);
      return (
        sp.normalize(sp.toNamespacedPath(sp.dirname(candidate))).toLowerCase() ===
          canonicalParent && sp.basename(candidate).toLowerCase() === rootName
      );
    };
    const isActive = () =>
      active && this.fsw.lifecycle.isActive(generation) && this.isHelperActive(wh, dir);
    const publish = (trigger: BackendTrigger): void => {
      if (trigger.kind !== 'native' || !matchesRoot(trigger.relativePath) || !isActive()) return;
      void this.reconcileBackendTrigger(
        dir,
        false,
        trigger,
        async () => {
          let rootStats: Stats;
          try {
            rootStats = await lstat(dir);
          } catch (error) {
            if (isMissingError(error)) {
              this.fsw.removePath(parentPath, sp.basename(dir), true);
            } else {
              this.reportError(error);
            }
            return;
          }
          if (!isActive()) return;
          if (!rootStats.isDirectory()) {
            this.fsw.removePath(parentPath, sp.basename(dir), true);
            await this.addPathOnce(dir, false, wh, 0);
            return;
          }
          await this.readDirectory(dir, false, wh, undefined, dir, 0);
        },
        isActive
      );
    };
    const subscription = setFsWatchListener(
      parentPath,
      sp.resolve(parentPath),
      { persistent: this.fsw.options.persistent },
      {
        publish,
        errHandler: this.reportError,
        rawEmitter: (event, relativePath, details) => {
          if (matchesRoot(relativePath)) this.fsw.emitRaw(event, relativePath, details);
        },
      },
      this.fsw.lifecycle.abortController.signal
    );
    if (!subscription) return;
    return () => {
      if (!active) return;
      active = false;
      return subscription.close();
    };
  }

  async watchRecursiveDirectory(
    dir: string,
    initialAdd: boolean,
    depth: number,
    wh: WatchHelper
  ): Promise<(() => void | Promise<void>) | false | undefined> {
    const fsw = this.fsw;
    const generation = fsw.lifecycle.generation;
    const rootKey = logicalPathKey(dir);
    const buffered = new ReplayBuffer<NativeTrigger>(RECURSIVE_TRIGGER_BUFFER_LIMIT);
    const fallbackClosers: Array<() => void | Promise<void>> = [];
    let phase: 'scanning' | 'replaying' | 'live' | 'recovering' | 'closed' = 'scanning';
    let pendingFailure: unknown;
    let hasPendingFailure = false;
    let recovery: Promise<void> | undefined;
    let subscription: BackendSubscription | undefined;
    const scopeActive = (path: string = dir) =>
      fsw.lifecycle.isActive(generation) && fsw.isPathGenerationActive(path, wh.pathGeneration);
    const acceptsTrigger = (path: string = dir) =>
      phase !== 'recovering' && phase !== 'closed' && scopeActive(path);

    const establishFallback = async (error: unknown): Promise<void> => {
      if (!scopeActive()) return;
      wh.recursiveRoot = undefined;
      wh.recursiveDisabled = true;
      let currentStats: Stats;
      try {
        currentStats = await lstat(dir);
      } catch (statError) {
        if (isMissingError(statError)) fsw.removePath(sp.dirname(dir), sp.basename(dir), true);
        else this.reportError(statError);
        this.reportError(error);
        return;
      }
      const closer = await this.handleDirectory(dir, currentStats, false, depth, undefined, wh);
      if (!scopeActive()) {
        if (closer) await closer();
        return;
      }
      if (closer) fallbackClosers.push(closer);
      await this.subscribeTrackedDirectories(dir, wh, depth);
      this.reportError(error);
    };

    const handleFailure = (error: unknown): void => {
      if (!acceptsTrigger()) return;
      const initializing = phase !== 'live';
      phase = 'recovering';
      fsw.tree.recursiveRoots.delete(rootKey);
      pendingFailure = error;
      hasPendingFailure = true;
      if (!initializing) {
        recovery = fsw.reconciliation.enqueue(dir, () => establishFallback(error), false);
      }
    };
    const processTrigger = (trigger: NativeTrigger): void => {
      if (!acceptsTrigger()) return;
      if (phase !== 'live') {
        buffered.push(trigger);
        return;
      }
      const coalescePath =
        trigger.relativePath === null
          ? dir
          : (resolveRecursiveCandidate(dir, trigger.relativePath) ?? dir);
      void this.reconcileBackendTrigger(
        dir,
        true,
        trigger,
        () => (acceptsTrigger() ? this.reconcileNativeTrigger(dir, wh, trigger) : undefined),
        () => acceptsTrigger(coalescePath)
      );
    };

    const result = subscribeRecursiveNative(
      dir,
      fsw.options.persistent,
      {
        publish: processTrigger,
        failure: handleFailure,
        rawEmitter: (...args) => fsw.emitRaw(...args),
      },
      fsw.lifecycle.abortController.signal
    );
    if (result.kind === 'unsupported') return false;
    if (result.kind === 'failed') throw result.error;
    subscription = result.subscription;
    fsw.tree.recursiveRoots.add(rootKey);
    wh.recursiveRoot = dir;

    const close = async (): Promise<void> => {
      if (phase === 'closed') return;
      phase = 'closed';
      fsw.tree.recursiveRoots.delete(rootKey);
      buffered.clear();
      await subscription?.close();
      if (recovery) await Promise.allSettled([recovery]);
      await Promise.allSettled(fallbackClosers.map((closer) => closer()));
    };

    try {
      await this.scanRecursiveTree(dir, initialAdd, wh, depth);
      if (!hasPendingFailure) {
        phase = 'replaying';
        let index = 0;
        while (acceptsTrigger()) {
          if (buffered.overflowed) {
            // Collapse to one tree rescan; triggers arriving during it are
            // buffered again and replayed instead of being discarded.
            buffered.clear();
            index = 0;
            const overflowTrigger: NativeTrigger = {
              kind: 'native',
              resource: subscription.resource,
              rawEvent: EV.CHANGE,
              relativePath: null,
              sequence: Number.MAX_SAFE_INTEGER,
              observedAt: backendNow(),
            };
            await this.reconcileBackendTrigger(
              dir,
              true,
              overflowTrigger,
              () => this.reconcileNativeTrigger(dir, wh, overflowTrigger),
              () => acceptsTrigger(),
              false
            );
            continue;
          }
          if (index >= buffered.entries.length) break;
          const trigger = buffered.entries[index++];
          if (trigger.rawEvent === 'rename' && trigger.relativePath !== null) {
            const candidate = resolveRecursiveCandidate(dir, trigger.relativePath);
            if (
              candidate &&
              candidate !== dir &&
              fsw.tree.getDirectory(sp.dirname(candidate)).has(sp.basename(candidate))
            ) {
              fsw.tree.markInitialCreate(candidate);
            }
          }
          await this.reconcileBackendTrigger(
            dir,
            true,
            trigger,
            () => this.reconcileNativeTrigger(dir, wh, trigger),
            () => acceptsTrigger(),
            false
          );
        }
        if ((phase as string) !== 'recovering') phase = 'live';
      }
      if (hasPendingFailure) {
        // A failure while scanning or replaying enqueued no recovery; there is
        // no live handle to recover into, so fall back now.
        buffered.clear();
        await establishFallback(pendingFailure);
      }
      buffered.clear();
      fsw.tree.clearInitialCreates(dir);
    } catch (error) {
      await close();
      throw error;
    }
    if (!scopeActive()) {
      await close();
      return;
    }
    return close;
  }

  /**
   * A recursive root that falls back to per-directory handles already tracks
   * every subdirectory, so the fallback scan sees none of them as new. Give
   * each its own subscription; existing entries emit nothing.
   */
  private async subscribeTrackedDirectories(
    root: string,
    wh: WatchHelper,
    baseDepth: number
  ): Promise<void> {
    const fsw = this.fsw;
    const absoluteRoot = sp.resolve(root);
    const needsSubscription = (path: string): boolean => {
      const key = logicalPathKey(path);
      return (
        this.isHelperActive(wh, path) &&
        !fsw.lifecycle.closers.has(key) &&
        !fsw.tree.symlinkPaths.has(key) &&
        (fsw.tree.peekDirectory(sp.dirname(path))?.has(sp.basename(path)) ?? false)
      );
    };
    const directories = [...fsw.tree.watched.values()]
      .filter((entry) => isStrictlyInside(absoluteRoot, entry.path))
      // Keep the root's spelling so events stay relative when the root was.
      .map((entry) => sp.join(root, sp.relative(absoluteRoot, entry.path)))
      .filter(needsSubscription)
      .sort((left, right) => left.length - right.length);
    let next = 0;
    const subscribeNext = async (): Promise<void> => {
      while (next < directories.length) {
        const directory = directories[next++];
        if (!needsSubscription(directory)) continue;
        await this.addPathOnce(
          directory,
          false,
          wh,
          baseDepth + this.candidateDepth(root, directory)
        );
      }
    };
    const workers = Math.min(FALLBACK_SUBSCRIBE_CONCURRENCY, directories.length);
    await Promise.all(Array.from({ length: workers }, subscribeNext));
  }

  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param dir fs path
   * @param stats
   * @param initialAdd
   * @param depth relative to user-supplied path
   * @param target child path targeted for watch
   * @param wh Common watch helpers for this path
   * @returns closer for the watcher instance.
   */
  async handleDirectory(
    dir: string,
    stats: Stats,
    initialAdd: boolean,
    depth: number,
    target: string | undefined,
    wh: WatchHelper
  ): Promise<(() => void | Promise<void>) | undefined> {
    if (!this.isHelperActive(wh, dir)) return;
    if (target) {
      this.fsw.tree.getDirectory(dir);
    } else {
      const parentDir = this.fsw.tree.getDirectory(sp.dirname(dir));
      const tracked = parentDir.has(sp.basename(dir));
      if (!(initialAdd && this.fsw.options.ignoreInitial) && !tracked) {
        this.fsw.emitEvent(EV.ADD_DIR, dir, stats);
      }

      // ensure dir is tracked (harmless if redundant)
      parentDir.add(sp.basename(dir));
      this.fsw.tree.getDirectory(dir);
      // Always retain the directory's identity so a delete-and-recreate that
      // outpaces its callbacks can be told apart from a content change.
      this.fsw.tree.recordObserved(
        dir,
        stats,
        tracked ? undefined : 'add',
        wh.observationTrigger,
        initialAdd && Boolean(wh.recursiveRoot),
        true
      );
    }
    let closer;

    const oDepth = this.fsw.options.depth;
    if (oDepth == null || depth <= oDepth) {
      if (
        this.fsw.options.backendCapabilities.recursive &&
        depth === 0 &&
        !target &&
        !wh.recursiveRoot &&
        !wh.recursiveDisabled
      ) {
        const recursiveCloser = await this.watchRecursiveDirectory(dir, initialAdd, depth, wh);
        if (recursiveCloser !== false) return recursiveCloser;
      }
      if (wh.recursiveRoot) {
        if (!target) {
          await this.scanRecursiveTree(dir, initialAdd, wh, depth);
        }
        return;
      }

      type BufferedDirectoryTrigger = { path: string; stats?: Stats; trigger: BackendTrigger };
      const buffered = new ReplayBuffer<BufferedDirectoryTrigger>(RECURSIVE_TRIGGER_BUFFER_LIMIT);
      const replayCreates = new Set<string>();
      let initializing = !target;
      let active = true;
      const targetPath = target ? sp.join(dir, target) : undefined;
      // The directory holding the target is gone: wait from the nearest existing ancestor.
      const rewatchTarget = (): void => {
        if (targetPath && active && this.isHelperActive(wh, targetPath)) {
          this.fsw.rewatchMissingPath(targetPath);
        }
      };
      const removeObserved = (dirPath: string): void => {
        if (target) {
          if (this.fsw.tree.getDirectory(dirPath).has(target)) this.fsw.removePath(dirPath, target);
          rewatchTarget();
          return;
        }
        this.fsw.removePath(sp.dirname(dirPath), sp.basename(dirPath), true);
      };
      const observeDirectory = async (
        dirPath: string,
        currentStats: Stats | undefined,
        trigger: BackendTrigger
      ): Promise<void> => {
        if (!active || !this.isHelperActive(wh, dirPath)) return;
        if (this.fsw.options.backendCapabilities.polling && !currentStats) {
          removeObserved(dirPath);
          return;
        }

        if (trigger.kind === 'native') {
          let observedStats: Stats;
          try {
            const linkStats = await lstat(dirPath);
            observedStats =
              linkStats.isSymbolicLink() && this.fsw.options.followSymlinks
                ? await stat(dirPath)
                : linkStats;
          } catch (error) {
            if (isMissingError(error)) {
              removeObserved(dirPath);
            } else {
              this.reportError(error);
            }
            return;
          }

          if (!observedStats.isDirectory()) {
            removeObserved(dirPath);
            if (!target) await this.addPathOnce(dirPath, false, wh, depth);
            return;
          }
        }

        await this.readDirectory(dirPath, false, wh, target, dir, depth);
      };
      const reconcile = (
        candidate: string,
        currentStats: Stats | undefined,
        trigger: BackendTrigger
      ): Promise<void> | undefined => {
        if (!active || !this.isHelperActive(wh, candidate)) return;
        if (initializing) {
          buffered.push({ path: candidate, stats: currentStats, trigger });
          return;
        }
        if (trigger.kind === 'native' && !target) {
          return this.reconcileNativeTrigger(dir, wh, trigger, candidate, depth);
        }
        if (trigger.kind === 'native' && target) {
          const matchesTarget =
            candidate === dir ||
            (isWindows
              ? sp.basename(candidate).toLowerCase() === target.toLowerCase()
              : sp.basename(candidate) === target);
          if (matchesTarget) {
            return this.reconcileNativeTrigger(dir, wh, trigger, targetPath, depth, {
              onRootMissing: rewatchTarget,
            });
          }
        }
        return observeDirectory(dir, currentStats, trigger);
      };
      const rootParentCloser = depth === 0 && !target ? this.watchRootParent(dir, wh) : undefined;
      closer = this.subscribePath(
        dir,
        reconcile,
        stats.isDirectory() ? stats : undefined,
        true,
        target ? sp.join(dir, target) : dir
      );

      if (target && targetPath && closer) {
        // The target may have appeared after the caller's failed lstat and
        // before this subscription existed; nothing would report it.
        const check = recoveryTrigger(sp.resolve(dir));
        await this.fsw.reconciliation.enqueue(
          targetPath,
          async () => {
            if (this.fsw.tree.getDirectory(dir).has(target)) return;
            await reconcile(targetPath, undefined, check);
          },
          targetPath
        );
      }

      if (!target) {
        await this.readDirectory(dir, initialAdd, wh, target, dir, depth);
        let index = 0;
        while (!this.fsw.closed) {
          if (buffered.overflow) {
            // Triggers arriving during the bulk rescan are buffered again and
            // replayed after it instead of being discarded with this overflow.
            const overflow = buffered.overflow;
            buffered.clear();
            index = 0;
            await observeDirectory(dir, overflow.stats, overflow.trigger);
            continue;
          }
          if (index >= buffered.entries.length) break;
          const event = buffered.entries[index++];
          if (
            event.trigger.kind === 'native' &&
            event.trigger.rawEvent === 'rename' &&
            event.path !== dir &&
            this.fsw.tree.getDirectory(sp.dirname(event.path)).has(sp.basename(event.path))
          ) {
            this.fsw.tree.markInitialCreate(event.path);
            replayCreates.add(event.path);
          }
          await this.reconcileBackendTrigger(
            dir,
            true,
            event.trigger,
            () => {
              if (event.trigger.kind === 'native' && !target) {
                return this.reconcileNativeTrigger(dir, wh, event.trigger, event.path, depth);
              }
              return observeDirectory(dir, event.stats, event.trigger);
            },
            () => active && this.isHelperActive(wh, event.path),
            false
          );
        }
        buffered.clear();
        replayCreates.forEach((path) => this.fsw.tree.clearInitialCreate(path));
        initializing = false;
      }
      if (!this.isHelperActive(wh, dir)) {
        active = false;
        if (closer) await closer();
        if (rootParentCloser) await rootParentCloser();
        return;
      }
      if (closer || rootParentCloser) {
        const backendClosers = [closer, rootParentCloser].filter(
          (candidate): candidate is () => void | Promise<void> => candidate !== undefined
        );
        closer = async () => {
          if (!active) return;
          active = false;
          buffered.clear();
          await Promise.allSettled(backendClosers.map((backendCloser) => backendCloser()));
        };
      }
    }
    return closer;
  }

  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to handleFile / handleDirectory after checks.
   * @param path to file or ir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async addRoot(
    path: string,
    initialAdd: boolean,
    pathGeneration: number,
    target?: string
  ): Promise<void> {
    let candidate = path;
    let childTarget = target;
    const generation = this.fsw.lifecycle.generation;
    while (this.fsw.lifecycle.isActive(generation)) {
      const outcome = await this.addPathOnce(
        candidate,
        initialAdd,
        undefined,
        0,
        childTarget,
        pathGeneration
      );
      if (outcome === 'complete') return;
      const parent = sp.dirname(candidate);
      if (parent === candidate) return;
      childTarget = sp.basename(candidate);
      candidate = parent;
    }
  }

  public async addPathOnce(
    path: string,
    initialAdd: boolean,
    priorWh: WatchHelper | undefined,
    depth: number,
    target?: string,
    pathGeneration?: number
  ): Promise<AddPathOutcome> {
    if (this.fsw.isIgnored(path) || this.fsw.closed) {
      return 'complete';
    }

    const wh = priorWh ? priorWh.fork(path) : this.fsw.createHelper(path);
    if (!priorWh && pathGeneration !== undefined) wh.pathGeneration = pathGeneration;

    if (!this.isHelperActive(wh)) {
      return 'complete';
    }

    // evaluate what is at the path we're being asked to watch
    try {
      const linkStats = await lstat(wh.watchPath);
      if (!this.isHelperActive(wh)) {
        return 'complete';
      }
      if (this.fsw.isIgnored(wh.watchPath, linkStats)) {
        return 'complete';
      }

      const follow = this.fsw.options.followSymlinks;
      const isSymbolicLink = linkStats.isSymbolicLink();
      const stats = isSymbolicLink && follow ? await stat(wh.watchPath) : linkStats;
      const followedTarget = isSymbolicLink && follow ? await fsrealpath(path) : undefined;
      let closer;
      if (stats.isDirectory()) {
        const absPath = logicalPathKey(path);
        const ancestryPath = follow ? await fsrealpath(path) : path;
        const targetPath = followedTarget ?? path;
        const targetKey = logicalPathKey(ancestryPath);
        if (!this.isHelperActive(wh)) {
          return 'complete';
        }
        if (isSymbolicLink && wh.realpathAncestry.has(targetKey)) {
          const parent = this.fsw.tree.getDirectory(sp.dirname(wh.watchPath));
          parent.add(sp.basename(wh.watchPath));
          this.fsw.tree.getDirectory(wh.watchPath);
          this.fsw.tree.symlinkPaths.set(absPath, targetPath);
          this.fsw.tree.recordObserved(
            wh.watchPath,
            stats,
            'add',
            wh.observationTrigger,
            initialAdd && Boolean(wh.recursiveRoot)
          );
          if (!(initialAdd && this.fsw.options.ignoreInitial)) {
            this.fsw.emitEvent(EV.ADD_DIR, wh.watchPath, stats);
          }
          return 'complete';
        }
        wh.realpathAncestry.add(targetKey);
        if (wh.recursiveRoot && isSymbolicLink) {
          wh.recursiveRoot = undefined;
        }
        if (isSymbolicLink) wh.recursiveDisabled = true;
        closer = await this.handleDirectory(wh.watchPath, stats, initialAdd, depth, target, wh);
        if (!this.isHelperActive(wh)) {
          if (closer) await closer();
          return 'complete';
        }
        // The directory vanished before it could be subscribed: keep climbing.
        if (target && !closer) return 'watch-parent';
        // preserve this symlink's target path
        if (isSymbolicLink) {
          this.fsw.tree.symlinkPaths.set(absPath, targetPath);
        }
      } else if (isSymbolicLink && !follow) {
        const linkTarget = await readlink(path);
        const retainsNativeFact =
          !this.fsw.options.backendCapabilities.polling && !wh.recursiveRoot && !priorWh;
        const fileCloser = this.handleFile(
          wh.watchPath,
          stats,
          initialAdd,
          !wh.recursiveRoot,
          wh.observationTrigger,
          initialAdd && Boolean(wh.recursiveRoot),
          retainsNativeFact
        );
        if (wh.recursiveRoot) {
          this.fsw.tree.symlinkPaths.set(logicalPathKey(path), linkTarget);
          return 'complete';
        }
        const parent = sp.dirname(wh.watchPath);
        const parentStats = await stat(parent);
        const parentHelper = this.fsw.createHelper(parent);
        parentHelper.pathGeneration = wh.pathGeneration;
        const parentCloser = await this.handleDirectory(
          parent,
          parentStats,
          initialAdd,
          depth,
          sp.basename(wh.watchPath),
          parentHelper
        );
        const deletionCloser = this.watchSymlinkDeletion(wh.watchPath);
        if (!this.isHelperActive(wh)) {
          if (fileCloser) await fileCloser();
          if (parentCloser) await parentCloser();
          if (deletionCloser) deletionCloser();
          return 'complete';
        }
        closer = async () => {
          await Promise.allSettled(
            [fileCloser, parentCloser, deletionCloser]
              .filter(
                (candidate): candidate is () => void | Promise<void> => candidate !== undefined
              )
              .map((backendCloser) => backendCloser())
          );
        };
        this.fsw.tree.symlinkPaths.set(logicalPathKey(path), linkTarget);
      } else {
        if (followedTarget) {
          this.fsw.tree.symlinkPaths.set(logicalPathKey(path), followedTarget);
        }
        const retainsNativeFact =
          !this.fsw.options.backendCapabilities.polling && !wh.recursiveRoot && !priorWh;
        const fileCloser = this.handleFile(
          wh.watchPath,
          stats,
          initialAdd,
          !wh.recursiveRoot,
          wh.observationTrigger,
          initialAdd && Boolean(wh.recursiveRoot),
          retainsNativeFact
        );
        const targetPath = followedTarget ?? (retainsNativeFact ? wh.watchPath : undefined);
        // fs.watch cannot open sockets, FIFOs or devices on macOS (UNKNOWN), so
        // only regular files get the exact fallback; the parent still covers them.
        const targetCloser = targetPath
          ? this.subscribeMappedFile(wh.watchPath, targetPath, wh, depth, isMacos && stats.isFile())
          : undefined;
        let parentCloser: (() => void | Promise<void>) | undefined;
        if (retainsNativeFact && followedTarget) {
          const parent = sp.dirname(wh.watchPath);
          const parentStats = await stat(parent);
          const parentHelper = this.fsw.createHelper(parent);
          parentHelper.pathGeneration = wh.pathGeneration;
          parentCloser = await this.handleDirectory(
            parent,
            parentStats,
            initialAdd,
            depth,
            sp.basename(wh.watchPath),
            parentHelper
          );
        }
        const fileClosers = [fileCloser, targetCloser, parentCloser].filter(
          (candidate): candidate is () => void | Promise<void> => candidate !== undefined
        );
        closer =
          fileClosers.length === 0
            ? undefined
            : async () => {
                await Promise.allSettled(fileClosers.map((fileCloser) => fileCloser()));
              };
      }
      if (!this.isHelperActive(wh)) {
        if (closer) await closer();
        return 'complete';
      }
      // A wait for a missing child belongs to that child: unwatching or
      // re-adding the parent must not be confused with it.
      if (closer) this.fsw.addPathCloser(target ? sp.join(path, target) : path, closer);
      return 'complete';
    } catch (error) {
      if (!this.isHelperActive(wh)) {
        return 'complete';
      }
      this.fsw.handleError(error);
      return 'watch-parent';
    }
  }
}
