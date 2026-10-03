import type { Stats } from 'node:fs';
import type { ReaddirpOptions, ReaddirpStream } from 'readdirp';
import type { NativeWatchFactory, RecursiveWatchFactory } from './backend.js';
import {
  failNativeWatch,
  failRecursiveWatch,
  nativeResourceCountForTests,
  setNativeWatchFactoryForTests,
  setRecursiveWatchFactoryForTests,
} from './backend.js';
import type { FSWatcher } from './index.js';
import type { EventPolicy } from './policy.js';
import type { ObservationEngine } from './reconcile.js';
import type {
  EventName,
  LogicalPathKey,
  NativeTrigger,
  Path,
  Scheduler,
  Throttler,
  ThrottleType,
  WatchHandlers,
} from './runtime.js';
import { logicalPathKey, type WatchHelper } from './runtime.js';
import type {
  Closer,
  DirEntry,
  LifecycleScope,
  LifecycleState,
  ObservedPathFact,
  ReconciliationQueue,
  TreeState,
} from './tree.js';

type InternalWatcher = {
  lifecycle: LifecycleScope;
  tree: TreeState;
  reconciliation: ReconciliationQueue;
  events: EventPolicy;
  handler: ObservationEngine;
  scheduler: Scheduler;
  streams: Set<ReaddirpStream>;
  readyEmitted: boolean;
  emitRaw: WatchHandlers['rawEmitter'];
  createHelper(path: Path): WatchHelper;
  emitEvent(event: EventName, path: Path, stats?: Stats): Promise<void>;
  capturePathGeneration(): number;
  isIgnored(path: Path, stats?: Stats): boolean;
  addPathCloser(path: Path, closer: () => void | Promise<void>): void;
  removePath(directory: string, item: string, isDirectory?: boolean): void;
  createScanStream(root: Path, options?: Partial<ReaddirpOptions>): ReaddirpStream | undefined;
};

type AddPathAttemptHost = {
  addPathOnce(
    path: string,
    initialAdd: boolean,
    priorHelper: WatchHelper | undefined,
    depth: number,
    target?: string,
    pathGeneration?: number
  ): Promise<'complete' | 'watch-parent'>;
};

export type WatcherInternals = {
  lifecycle: LifecycleScope;
  state: LifecycleState;
  generation: number;
  abortController: AbortController;
  tasks: Set<Promise<unknown>>;
  closers: Map<string, Closer[]>;
  tree: TreeState;
  watched: TreeState['watched'];
  observed: TreeState['observed'];
  recursiveRoots: TreeState['recursiveRoots'];
  symlinkPaths: TreeState['symlinkPaths'];
  reconciliation: ReconciliationQueue;
  pendingReconciliations: ReconciliationQueue['pending'];
  events: EventPolicy;
  pendingWrites: EventPolicy['pendingWrites'];
  pendingUnlinks: EventPolicy['pendingUnlinks'];
  pendingChangeEmissions: EventPolicy['pendingChanges'];
  throttled: Map<ThrottleType, Map<string, Throttler>>;
  handler: ObservationEngine;
  scheduler: Scheduler;
  streams: Set<ReaddirpStream>;
  readyEmitted: boolean;
  emitRaw: WatchHandlers['rawEmitter'];
  drainTasks(): Promise<void>;
  createHelper(path: Path): WatchHelper;
  emitEvent(event: EventName, path: Path, stats?: Stats): Promise<void>;
  logicalKey(path: Path): LogicalPathKey;
  capturePathGeneration(): number;
  isIgnored(path: Path, stats?: Stats): boolean;
  awaitWriteFinish(
    path: Path,
    threshold: number,
    event: EventName,
    emit: (err?: Error, stat?: Stats) => void,
    logicalKey?: LogicalPathKey
  ): void;
  addPathCloser(path: Path, closer: () => void | Promise<void>): void;
  removePath(directory: string, item: string, isDirectory?: boolean): void;
  createScanStream(root: Path, options?: Partial<ReaddirpOptions>): ReaddirpStream | undefined;
  walkMissingRoot(path: string): Promise<number>;
  recordObserved(
    path: Path,
    stats: Stats,
    transition?: ObservedPathFact['transition'],
    trigger?: NativeTrigger,
    initialRecursive?: boolean
  ): void;
  directoryEntry(directory: string): DirEntry;
  throttle(
    actionType: ThrottleType,
    path: Path,
    timeout: number,
    onRelease?: (suppressedCount: number) => void
  ): Throttler | false;
  trackTask(task: Promise<unknown>): Promise<unknown>;
  enqueueReconciliation(
    scope: Path,
    work: () => Promise<void>,
    coalescePath?: Path | false
  ): Promise<void>;
  isDuplicateObservation(path: Path, stats: Stats, trigger: NativeTrigger): boolean;
};

/** Process-global backend fault injection, kept outside the packaged API. */
export const backendTesting = {
  nativeResourceCount(): number {
    return nativeResourceCountForTests();
  },
  setNativeWatchFactory(factory?: NativeWatchFactory): void {
    setNativeWatchFactoryForTests(factory);
  },
  setRecursiveWatchFactory(factory?: RecursiveWatchFactory): void {
    setRecursiveWatchFactoryForTests(factory);
  },
  failRecursiveWatch(path: string, error: unknown): boolean {
    return failRecursiveWatch(path, error);
  },
  failNativeWatch(path: string, error: Error & { code: string }): Promise<boolean> {
    return failNativeWatch(path, error);
  },
};

/** Deliberately unpackaged test seam for race injection and state assertions. */
export function inspectWatcher(watcher: FSWatcher): WatcherInternals {
  const internal = watcher as unknown as InternalWatcher;
  const { lifecycle, tree, reconciliation, events } = internal;
  return {
    lifecycle,
    state: lifecycle.state as LifecycleState,
    generation: lifecycle.generation,
    abortController: lifecycle.abortController,
    tasks: lifecycle.tasks,
    closers: lifecycle.closers,
    tree,
    watched: tree.watched,
    observed: tree.observed,
    recursiveRoots: tree.recursiveRoots,
    symlinkPaths: tree.symlinkPaths,
    reconciliation,
    pendingReconciliations: reconciliation.pending,
    events,
    pendingWrites: events.pendingWrites,
    pendingUnlinks: events.pendingUnlinks,
    pendingChangeEmissions: events.pendingChanges,
    throttled: events.throttled as Map<ThrottleType, Map<string, Throttler>>,
    handler: internal.handler,
    scheduler: internal.scheduler,
    streams: internal.streams,
    emitRaw: internal.emitRaw,
    get readyEmitted(): boolean {
      return internal.readyEmitted;
    },
    set readyEmitted(value: boolean) {
      internal.readyEmitted = value;
    },
    drainTasks: (): Promise<void> => lifecycle.drain(),
    createHelper: (path: Path): WatchHelper => internal.createHelper(path),
    emitEvent: (event: EventName, path: Path, stats?: Stats): Promise<void> =>
      internal.emitEvent(event, path, stats),
    logicalKey: logicalPathKey,
    capturePathGeneration: (): number => internal.capturePathGeneration(),
    isIgnored: (path: Path, stats?: Stats): boolean => internal.isIgnored(path, stats),
    awaitWriteFinish: (
      path: Path,
      threshold: number,
      event: EventName,
      emit: (err?: Error, stat?: Stats) => void,
      logicalKey?: LogicalPathKey
    ): void => events.awaitWriteFinish(path, threshold, event, emit, logicalKey),
    addPathCloser: (path: Path, closer: () => void | Promise<void>): void =>
      internal.addPathCloser(path, closer),
    removePath: (directory: string, item: string, isDirectory?: boolean): void =>
      internal.removePath(directory, item, isDirectory),
    createScanStream: (
      root: Path,
      options?: Partial<ReaddirpOptions>
    ): ReaddirpStream | undefined => internal.createScanStream(root, options),
    walkMissingRoot: async (path: string): Promise<number> => {
      const host = internal.handler as unknown as AddPathAttemptHost;
      const original = host.addPathOnce;
      let calls = 0;
      host.addPathOnce = async () => {
        calls += 1;
        return 'watch-parent';
      };
      try {
        await internal.handler.addRoot(path, true, internal.capturePathGeneration());
        return calls;
      } finally {
        host.addPathOnce = original;
      }
    },
    recordObserved: (
      path: Path,
      stats: Stats,
      transition?: ObservedPathFact['transition'],
      trigger?: NativeTrigger,
      initialRecursive?: boolean
    ): void => tree.recordObserved(path, stats, transition, trigger, initialRecursive),
    directoryEntry: (directory: string): DirEntry => tree.getDirectory(directory),
    throttle: (
      actionType: ThrottleType,
      path: Path,
      timeout: number,
      onRelease?: (suppressedCount: number) => void
    ): Throttler | false => events.throttle(actionType, path, timeout, onRelease),
    trackTask: (task: Promise<unknown>): Promise<unknown> => lifecycle.track(task),
    enqueueReconciliation: (
      scope: Path,
      work: () => Promise<void>,
      coalescePath: Path | false = scope
    ): Promise<void> => reconciliation.enqueue(scope, work, coalescePath),
    isDuplicateObservation: (path: Path, stats: Stats, trigger: NativeTrigger): boolean =>
      tree.isDuplicateObservation(path, stats, trigger),
  };
}
