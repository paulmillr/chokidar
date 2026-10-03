import type { Stats } from 'node:fs';
import * as sp from 'node:path';
import type { ReaddirpOptions, ReaddirpStream } from 'readdirp';
import type { EventPolicy } from './policy.js';
import type { Scheduler } from './runtime.js';
import {
  EVENTS,
  isSameOrInside,
  logicalPathKey,
  type EventName,
  type FSWInstanceOptions,
  type NativeTrigger,
  type Path,
  type WatchHandlers,
  type WatchHelper,
} from './runtime.js';

export type LifecycleState = 'OPEN' | 'CLOSING' | 'CLOSED';
export type Closer = () => void | Promise<void>;

/**
 * Owns every asynchronous task and backend subscription created by one public
 * watcher. It deliberately knows nothing about paths, events, or backends.
 */
export class LifecycleScope {
  state: LifecycleState = 'OPEN';
  generation: number = 0;
  readonly abortController: AbortController = new AbortController();
  readonly tasks: Set<Promise<unknown>> = new Set();
  readonly closers: Map<string, Closer[]> = new Map();
  private readonly onTaskSettled: () => void;
  private readonly onTaskError: (error: unknown) => void;

  constructor(onTaskSettled: () => void, onTaskError: (error: unknown) => void) {
    this.onTaskSettled = onTaskSettled;
    this.onTaskError = onTaskError;
  }

  isActive(generation: number): boolean {
    return this.state === 'OPEN' && this.generation === generation;
  }

  track<T>(task: Promise<T>): Promise<T> {
    const tracked = Promise.resolve(task).finally(() => {
      this.tasks.delete(tracked);
      this.onTaskSettled();
    });
    this.tasks.add(tracked);
    void tracked.catch(this.onTaskError);
    return tracked;
  }

  addCloser(key: string, closer: Closer): void {
    const existing = this.closers.get(key);
    if (existing) existing.push(closer);
    else this.closers.set(key, [closer]);
  }

  takeClosers(key: string): Closer[] {
    const closers = this.closers.get(key) ?? [];
    this.closers.delete(key);
    return closers;
  }

  beginClose(): Promise<void>[] {
    if (this.state !== 'OPEN') return [];
    this.state = 'CLOSING';
    this.generation += 1;
    this.abortController.abort();
    const closing: Promise<void>[] = [];
    this.closers.forEach((closers) => {
      closers.forEach((closer) => {
        try {
          closing.push(Promise.resolve(closer()));
        } catch (error) {
          closing.push(Promise.reject(error));
        }
      });
    });
    this.closers.clear();
    return closing;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  finishClose(): void {
    this.state = 'CLOSED';
  }
}

function IGNORE_RECONCILIATION_ERROR(): void {}

export function resolveRecursiveCandidate(root: string, relativePath: string): string | undefined {
  if (sp.isAbsolute(relativePath)) return;
  const absoluteRoot = sp.resolve(root);
  const absoluteCandidate = sp.resolve(absoluteRoot, relativePath);
  if (!isSameOrInside(absoluteRoot, absoluteCandidate)) return;
  return sp.join(root, relativePath);
}

export type PendingReconciliation = {
  promise: Promise<void>;
  work: () => Promise<void>;
  replay: boolean;
};

/** Serializes commits per root and coalesces redundant candidate invalidations. */
export class ReconciliationQueue {
  readonly queues: Map<string, Promise<void>> = new Map();
  readonly pending: Map<string, PendingReconciliation> = new Map();
  private readonly lifecycle: LifecycleScope;

  constructor(lifecycle: LifecycleScope) {
    this.lifecycle = lifecycle;
  }

  enqueue(
    scope: Path,
    work: () => Promise<void>,
    coalescePath: Path | false = scope
  ): Promise<void> {
    const key = logicalPathKey(scope);
    const pendingKey =
      coalescePath === false ? undefined : `${key}\0${logicalPathKey(coalescePath)}`;
    const existing = pendingKey ? this.pending.get(pendingKey) : undefined;
    if (existing) {
      existing.work = work;
      existing.replay = true;
      return existing.promise;
    }

    const generation = this.lifecycle.generation;
    const reconciliation: PendingReconciliation = {
      promise: Promise.resolve(),
      work,
      replay: false,
    };
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous
      .catch(IGNORE_RECONCILIATION_ERROR)
      .then(async () => {
        do {
          const currentWork = reconciliation.work;
          reconciliation.replay = false;
          if (!this.lifecycle.isActive(generation)) return;
          await currentWork();
        } while (reconciliation.replay);
      })
      .finally(() => {
        if (this.queues.get(key) === task) this.queues.delete(key);
        if (pendingKey && this.pending.get(pendingKey) === reconciliation) {
          this.pending.delete(pendingKey);
        }
      });
    this.queues.set(key, task);
    const tracked = this.lifecycle.track(task);
    reconciliation.promise = tracked;
    if (pendingKey) this.pending.set(pendingKey, reconciliation);
    return tracked;
  }

  forgetPending(predicate: (scope: string, candidate: string) => boolean): void {
    for (const key of this.pending.keys()) {
      const [scope, candidate] = key.split('\0', 2);
      if (predicate(scope, candidate)) this.pending.delete(key);
    }
  }

  clear(): void {
    this.queues.clear();
    this.pending.clear();
  }
}

const CURRENT = '.';
const PARENT = '..';
const RECURSIVE_CREATE_BURST_WINDOW = 25;
const RECURSIVE_WRITE_BURST_WINDOW = 10;

export type ObservedPathFact = {
  size: number;
  mtimeMs: number;
  ino: number;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  transition?: 'add' | 'change';
  rawEvent?: NativeTrigger['rawEvent'];
  relativePath?: string | null;
  observedAt?: number;
  initialRecursive?: boolean;
};

const INITIAL_OBSERVATION_FACT: ObservedPathFact = Object.freeze({
  size: 0,
  mtimeMs: 0,
  ino: 0,
  kind: 'other',
  initialRecursive: true,
});

function statKind(stats: Stats): ObservedPathFact['kind'] {
  return stats.isSymbolicLink()
    ? 'symlink'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : 'other';
}

function sameStatFact(fact: ObservedPathFact | undefined, stats: Stats): boolean {
  return (
    fact?.size === stats.size &&
    fact.mtimeMs === stats.mtimeMs &&
    fact.ino === stats.ino &&
    fact.kind === statKind(stats)
  );
}

function withinWindow(
  fact: ObservedPathFact | undefined,
  trigger: NativeTrigger,
  window: number
): boolean {
  return (
    fact?.observedAt !== undefined &&
    trigger.observedAt >= fact.observedAt &&
    trigger.observedAt - fact.observedAt <= window
  );
}

/** A directory membership snapshot owned by one public watcher. */
export class DirEntry {
  path: Path;
  private readonly items: Set<Path> = new Set();

  constructor(dir: Path) {
    this.path = dir;
  }

  add(item: string): void {
    if (item !== CURRENT && item !== PARENT) this.items.add(item);
  }

  remove(item: string): boolean {
    this.items.delete(item);
    return this.items.size === 0;
  }

  has(item: string): boolean {
    return this.items.has(item);
  }

  getChildren(): string[] {
    return [...this.items];
  }

  dispose(): void {
    this.items.clear();
    this.path = '';
  }
}

/**
 * Per-watcher filesystem truth. Backends never mutate this object directly;
 * scanner and reconciliation stages commit observations through it.
 */
export class TreeState {
  readonly watched: Map<string, DirEntry> = new Map();
  readonly observed: Map<string, ObservedPathFact> = new Map();
  readonly symlinkPaths: Map<Path, string | boolean> = new Map();
  readonly recursiveRoots: Set<string> = new Set();
  private readonly observesNative: () => boolean;

  constructor(observesNative: () => boolean) {
    this.observesNative = observesNative;
  }

  getDirectory(directory: string): DirEntry {
    const dir = sp.resolve(directory);
    const key = logicalPathKey(dir);
    let entry = this.watched.get(key);
    if (!entry) {
      entry = new DirEntry(dir);
      this.watched.set(key, entry);
    }
    return entry;
  }

  recordObserved(
    path: Path,
    stats: Stats,
    transition?: ObservedPathFact['transition'],
    trigger?: NativeTrigger,
    initialRecursive = false,
    retainWithoutTrigger = false
  ): void {
    if (!this.observesNative()) return;
    if (!trigger && !initialRecursive && !retainWithoutTrigger) return;
    this.observed.set(logicalPathKey(path), {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: stats.ino,
      kind: statKind(stats),
      transition,
      rawEvent: trigger?.rawEvent,
      relativePath: trigger?.relativePath,
      observedAt: trigger?.observedAt,
      initialRecursive,
    });
  }

  consumeInitialCreate(
    path: Path,
    stats: Stats,
    trigger: NativeTrigger,
    ignoreInitial: boolean
  ): EventName | false | undefined {
    const previous = this.observed.get(logicalPathKey(path));
    if (!previous?.initialRecursive || trigger.rawEvent !== 'rename') return;
    this.recordObserved(path, stats, 'add', trigger);
    if (!ignoreInitial) return false;
    return stats.isDirectory() ? EVENTS.ADD_DIR : EVENTS.ADD;
  }

  markInitialCreate(path: Path): void {
    const key = logicalPathKey(path);
    const fact = this.observed.get(key);
    if (fact) fact.initialRecursive = true;
    else this.observed.set(key, { ...INITIAL_OBSERVATION_FACT });
  }

  clearInitialCreate(path: Path): void {
    const fact = this.observed.get(logicalPathKey(path));
    if (fact) fact.initialRecursive = false;
  }

  clearInitialCreates(root: Path): void {
    const rootKey = logicalPathKey(root);
    for (const [path, fact] of this.observed) {
      if (isSameOrInside(rootKey, path) && fact.initialRecursive) fact.initialRecursive = false;
    }
  }

  isDuplicateObservation(path: Path, stats: Stats, trigger: NativeTrigger): boolean {
    const previous = this.observed.get(logicalPathKey(path));
    const sameFact = sameStatFact(previous, stats);
    const duplicateCreate =
      previous?.transition === 'add' &&
      previous?.relativePath === trigger.relativePath &&
      previous.rawEvent === 'rename' &&
      trigger.rawEvent === 'change' &&
      withinWindow(previous, trigger, RECURSIVE_CREATE_BURST_WINDOW);
    const duplicateUnchanged =
      sameFact &&
      stats.isFile() &&
      !previous?.initialRecursive &&
      (previous?.transition === 'add' || trigger.relativePath === null);
    const duplicateWrite =
      previous?.transition === 'change' &&
      previous.relativePath === trigger.relativePath &&
      withinWindow(previous, trigger, RECURSIVE_WRITE_BURST_WINDOW) &&
      previous.rawEvent === trigger.rawEvent;
    const duplicate = duplicateUnchanged || duplicateCreate || duplicateWrite;
    const transition = duplicateWrite
      ? undefined
      : duplicateUnchanged
        ? previous?.transition
        : 'change';
    this.recordObserved(path, stats, transition, trigger);
    return duplicate;
  }

  dispose(): void {
    this.watched.forEach((entry) => entry.dispose());
    this.watched.clear();
    this.observed.clear();
    this.symlinkPaths.clear();
    this.recursiveRoots.clear();
  }
}

export type PathCloser = () => void | Promise<void>;

/**
 * The private port used by filesystem orchestration. It prevents a backend or
 * scanner from depending on EventEmitter or the public FSWatcher API.
 */
export interface WatcherContext {
  readonly closed: boolean;
  readonly options: FSWInstanceOptions;
  readonly lifecycle: LifecycleScope;
  readonly tree: TreeState;
  readonly reconciliation: ReconciliationQueue;
  readonly events: EventPolicy;
  readonly scheduler: Scheduler;
  readonly emitRaw: WatchHandlers['rawEmitter'];

  addPathCloser(path: Path, closer: PathCloser): void;
  closePath(path: Path, recursive?: boolean): void;
  emitEvent(event: EventName, path: Path, stats?: Stats): Promise<void>;
  createHelper(path: Path): WatchHelper;
  handleError(error: unknown): void;
  isIgnored(path: Path, stats?: Stats): boolean;
  isPathGenerationActive(path: Path, generation: number): boolean;
  isUnwatched(path: Path): boolean;
  createScanStream(root: Path, options?: Partial<ReaddirpOptions>): ReaddirpStream | undefined;
  removePath(directory: string, item: string, isDirectory?: boolean): void;
}
