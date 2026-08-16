import type { FSWatcher as NativeFsWatcher, Stats, WatchEventType, WatchListener } from 'node:fs';
import { watch as fsWatch, realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import * as sp from 'node:path';
import {
  type BackendResourceKey,
  type BackendStrategy,
  type BackendSubscription,
  type BackendTrigger,
  type ChokidarOptions,
  EVENTS,
  type FSWInstanceOptions,
  isMacos,
  isMissingError,
  isRecursiveWatchUnsupported,
  isSameOrInside,
  isWindows,
  type MissingPollObservation,
  type NativeTrigger,
  type Path,
  type PollObservation,
  type PollTrigger,
  type Scheduler,
  type SchedulerTimer,
  type WatchHandlers,
} from './runtime.js';

export type SharedResourceState<Subscriber> = {
  readonly resource: BackendResourceKey;
  readonly generation: number;
  readonly subscribers: Set<Subscriber>;
  closed: boolean;
};

let nextGeneration = 0;

export function allocateSharedResourceGeneration(): number {
  return ++nextGeneration;
}

/** Common ownership state for process-global backend handles. */
export function createSharedResourceState<Subscriber>(
  resource: BackendResourceKey,
  subscribers: Iterable<Subscriber> = []
): SharedResourceState<Subscriber> {
  return {
    resource,
    generation: allocateSharedResourceGeneration(),
    subscribers: new Set(subscribers),
    closed: false,
  };
}

export function attachSharedSubscriber<Subscriber>(
  resource: SharedResourceState<Subscriber>,
  subscriber: Subscriber
): boolean {
  if (resource.closed) return false;
  resource.subscribers.add(subscriber);
  return true;
}

export function detachSharedSubscriber<Subscriber>(
  resource: SharedResourceState<Subscriber>,
  subscriber: Subscriber
): 'remaining' | 'last' | undefined {
  if (resource.closed || !resource.subscribers.delete(subscriber)) return;
  return resource.subscribers.size > 0 ? 'remaining' : 'last';
}

/** Invalidates exactly this resource generation and returns its subscribers. */
export function invalidateSharedResource<Subscriber>(
  resource: SharedResourceState<Subscriber>
): readonly Subscriber[] | undefined {
  if (resource.closed) return;
  resource.closed = true;
  const subscribers = [...resource.subscribers];
  resource.subscribers.clear();
  return subscribers;
}

type PersistentSubscriber = { persistent: boolean };
type SharedWatcherResource<Subscriber extends PersistentSubscriber> =
  SharedResourceState<Subscriber> & { watcher: NativeFsWatcher };

function reconfigureWatcherPersistence<Subscriber extends PersistentSubscriber>(
  resource: SharedWatcherResource<Subscriber>
): void {
  const persistent = [...resource.subscribers].some((subscriber) => subscriber.persistent);
  if (persistent) resource.watcher.ref();
  else resource.watcher.unref();
}

function invalidateWatcherResource<
  Subscriber extends PersistentSubscriber,
  Resource extends SharedWatcherResource<Subscriber>,
>(
  resource: Resource,
  registry: Map<BackendResourceKey, Resource>
): readonly Subscriber[] | undefined {
  const subscribers = invalidateSharedResource(resource);
  if (!subscribers) return;
  if (registry.get(resource.resource) === resource) registry.delete(resource.resource);
  resource.watcher.close();
  return subscribers;
}

function attachWatcherSubscriber<Subscriber extends PersistentSubscriber>(
  resource: SharedWatcherResource<Subscriber>,
  subscriber: Subscriber
): void {
  attachSharedSubscriber(resource, subscriber);
  reconfigureWatcherPersistence(resource);
}

function createWatcherSubscription<
  Subscriber extends PersistentSubscriber,
  Resource extends SharedWatcherResource<Subscriber>,
>(
  resource: Resource,
  subscriber: Subscriber,
  registry: Map<BackendResourceKey, Resource>
): BackendSubscription {
  let closed = false;
  return {
    resource: resource.resource,
    close: () => {
      if (closed) return;
      closed = true;
      const remaining = detachSharedSubscriber(resource, subscriber);
      if (remaining === 'remaining') reconfigureWatcherPersistence(resource);
      else if (remaining === 'last' && registry.get(resource.resource) === resource) {
        invalidateWatcherResource(resource, registry);
      }
    },
  };
}

export type BackendCapabilities = Readonly<{
  kind: BackendStrategy;
  polling: boolean;
  recursive: boolean;
  perDirectory: boolean;
}>;

export function selectBackend(
  options: Pick<ChokidarOptions, 'backend' | 'depth'>
): BackendCapabilities {
  const preferRecursive =
    options.backend === 'native-recursive' ||
    (options.backend === 'auto' && (isMacos || isWindows));
  const kind: BackendStrategy =
    options.backend === 'polling'
      ? 'polling'
      : preferRecursive && options.depth === undefined
        ? 'native-recursive-preferred'
        : 'native-per-directory';
  return Object.freeze({
    kind,
    polling: kind === 'polling',
    recursive: kind === 'native-recursive-preferred',
    perDirectory: kind === 'native-per-directory',
  });
}

type BackendHandlers = {
  publish: (trigger: BackendTrigger) => void;
  errHandler: WatchHandlers['errHandler'];
  rawEmitter: WatchHandlers['rawEmitter'];
};

const EV = EVENTS;
const POLL_DIRECTORY_RECHECK_DELAY = 1000;

/** Native resources use one process-global monotonic time domain. */
export function backendNow(): number {
  return performance.now();
}

function toNativeWatchPath(path: string): string {
  const nativePath = sp.normalize(path);
  if (!isWindows) return nativePath;
  try {
    // Node 24's Windows fs-event implementation compares long callback paths
    // with the spelling passed here. Logical/resource keys remain lexical.
    return realpathSync.native(nativePath);
  } catch {
    return nativePath;
  }
}

function projectNativeRelativePath(nativeRoot: string, relativePath: string | null): string | null {
  if (!isWindows || relativePath === null || !sp.isAbsolute(relativePath)) return relativePath;
  const root = sp.normalize(sp.toNamespacedPath(nativeRoot));
  const candidate = sp.normalize(sp.toNamespacedPath(relativePath));
  const projected = sp.relative(root, candidate);
  if (!isSameOrInside(root, candidate)) return relativePath;
  return projected || null;
}

// fs_watch helpers

// object to hold per-process fs_watch instances
// (may be shared across chokidar FSWatcher instances)

type NativeSubscriber = BackendHandlers & { watchedPath: string; persistent: boolean };

export type FsWatchContainer = SharedResourceState<NativeSubscriber> & {
  watcher: NativeFsWatcher;
  sequence: number;
};

const FsWatchInstances = new Map<BackendResourceKey, FsWatchContainer>();

export type NativeWatchFactory = (
  path: string,
  options: { persistent: boolean | undefined },
  listener: WatchListener<string>
) => NativeFsWatcher;
function systemNativeWatchFactory(
  path: string,
  options: { persistent: boolean | undefined },
  listener: WatchListener<string>
): NativeFsWatcher {
  return fsWatch(path, options, listener);
}
let nativeWatchFactory = systemNativeWatchFactory;

type RecursiveNativeSubscriber = {
  watchedPath: string;
  persistent: boolean;
  publish: (trigger: NativeTrigger) => void;
  failure: (error: unknown) => void;
  rawEmitter: WatchHandlers['rawEmitter'];
};

type RecursiveNativeResource = SharedResourceState<RecursiveNativeSubscriber> & {
  watcher: NativeFsWatcher;
  sequence: number;
};

export type RecursiveSubscriptionResult =
  | { kind: 'subscribed'; subscription: BackendSubscription }
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: unknown };

const RecursiveWatchInstances = new Map<BackendResourceKey, RecursiveNativeResource>();
let recursiveWatchUnsupported = false;
export type RecursiveWatchFactory = (
  path: string,
  options: { persistent: boolean; recursive: true },
  listener: WatchListener<string>
) => NativeFsWatcher;
function systemRecursiveWatchFactory(
  path: string,
  options: { persistent: boolean; recursive: true },
  listener: WatchListener<string>
): NativeFsWatcher {
  return fsWatch(path, options, listener);
}
let recursiveWatchFactory = systemRecursiveWatchFactory;

function failRecursiveResource(resource: RecursiveNativeResource, error: unknown): void {
  const subscribers = invalidateWatcherResource<RecursiveNativeSubscriber, RecursiveNativeResource>(
    resource,
    RecursiveWatchInstances
  );
  if (!subscribers) return;
  subscribers.forEach((subscriber) => subscriber.failure(error));
}

export function subscribeRecursiveNative(
  path: string,
  persistent: boolean,
  handlers: Omit<RecursiveNativeSubscriber, 'watchedPath' | 'persistent'>,
  signal: AbortSignal
): RecursiveSubscriptionResult {
  if (recursiveWatchUnsupported) return { kind: 'unsupported' };
  const resourceKey = sp.resolve(path) as BackendResourceKey;
  const subscriber: RecursiveNativeSubscriber = {
    ...handlers,
    watchedPath: path,
    persistent,
  };
  let resource = RecursiveWatchInstances.get(resourceKey);
  if (!resource) {
    let watcher: NativeFsWatcher;
    const nativePath = toNativeWatchPath(path);
    try {
      watcher = recursiveWatchFactory(
        nativePath,
        { persistent, recursive: true },
        (rawEvent, relativePath) => {
          const active = RecursiveWatchInstances.get(resourceKey);
          if (!active || active.closed) return;
          const trigger: NativeTrigger = {
            kind: 'native',
            resource: resourceKey,
            rawEvent,
            relativePath: projectNativeRelativePath(nativePath, relativePath),
            sequence: ++active.sequence,
            observedAt: backendNow(),
          };
          active.subscribers.forEach((current) => {
            current.rawEmitter(rawEvent, relativePath, { watchedPath: current.watchedPath });
            current.publish(trigger);
          });
        }
      );
    } catch (error) {
      if (isRecursiveWatchUnsupported(error)) {
        recursiveWatchUnsupported = true;
        return { kind: 'unsupported' };
      }
      return { kind: 'failed', error };
    }
    resource = {
      resource: resourceKey,
      generation: allocateSharedResourceGeneration(),
      subscribers: new Set(),
      closed: false,
      watcher,
      sequence: 0,
    };
    RecursiveWatchInstances.set(resourceKey, resource);
    watcher.on(EV.ERROR, (error) => failRecursiveResource(resource!, error));
  }
  attachWatcherSubscriber(resource, subscriber);
  const subscription = createWatcherSubscription(resource, subscriber, RecursiveWatchInstances);
  if (signal.aborted) void subscription.close();
  return { kind: 'subscribed', subscription };
}

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
  listener: WatchListener<string>,
  errHandler: WatchHandlers['errHandler']
): NativeFsWatcher | undefined {
  try {
    return nativeWatchFactory(
      path,
      {
        persistent: options.persistent,
      },
      listener
    );
  } catch (error) {
    errHandler(error);
    return undefined;
  }
}

/**
 * Publish one invalidation to subscribers of an exact native resource.
 */
function publishNativeTrigger(
  cont: FsWatchContainer,
  rawEvent: WatchEventType,
  relativePath: string | null,
  emitRaw: boolean,
  rawRelativePath = relativePath
): void {
  if (cont.closed || FsWatchInstances.get(cont.resource) !== cont) return;
  const trigger: NativeTrigger = {
    kind: 'native',
    resource: cont.resource,
    rawEvent,
    relativePath,
    sequence: ++cont.sequence,
    observedAt: backendNow(),
  };
  cont.subscribers.forEach((subscriber) => {
    if (emitRaw) {
      subscriber.rawEmitter(rawEvent, rawRelativePath, { watchedPath: subscriber.watchedPath });
    }
    subscriber.publish(trigger);
  });
}

function broadcastNativeError(cont: FsWatchContainer, error: unknown): void {
  if (cont.closed || FsWatchInstances.get(cont.resource) !== cont) return;
  cont.subscribers.forEach((subscriber) => subscriber.errHandler(error));
}

function closeFailedNativeResource(cont: FsWatchContainer): void {
  invalidateWatcherResource(cont, FsWatchInstances);
}

async function handleNativeError(
  path: string,
  cont: FsWatchContainer,
  error: Error & { code: string }
): Promise<void> {
  // Workaround for https://github.com/joyent/node/issues/4337
  if (isWindows && error.code === 'EPERM') {
    try {
      const fd = await open(path, 'r');
      await fd.close();
      broadcastNativeError(cont, error);
    } catch {
      // ReadDirectoryChangesW reports a deleted watched directory as EPERM.
      // Turn that terminal backend failure into one final invalidation so
      // each subscriber can reconcile the path before the unusable shared
      // handle is discarded. If the path still exists, reconciliation is a
      // harmless refresh and preserves the historical error suppression.
      publishNativeTrigger(cont, 'rename', null, false);
    }
  } else {
    broadcastNativeError(cont, error);
  }
  closeFailedNativeResource(cont);
}

function createNativeContainer(
  path: string,
  nativePath: string,
  resourceKey: BackendResourceKey,
  options: Partial<FSWInstanceOptions>,
  subscriber: NativeSubscriber
): FsWatchContainer | undefined {
  let cont: FsWatchContainer;
  const watcher = createFsWatchInstance(
    nativePath,
    options,
    (rawEvent, relativePath) => {
      const projectedPath = projectNativeRelativePath(nativePath, relativePath);
      publishNativeTrigger(cont, rawEvent, projectedPath, true, relativePath);
    },
    subscriber.errHandler
  );
  if (!watcher) return;
  cont = {
    resource: resourceKey,
    generation: allocateSharedResourceGeneration(),
    subscribers: new Set([subscriber]),
    closed: false,
    watcher,
    sequence: 0,
  };
  FsWatchInstances.set(resourceKey, cont);
  watcher.on(EV.ERROR, (error: Error & { code: string }) => {
    void handleNativeError(path, cont, error);
  });
  return cont;
}

/**
 * Instantiates the fs_watch interface or binds listeners
 * to an existing one covering the same file system entry
 * @param path
 * @param fullPath absolute path
 * @param options to be passed to fs_watch
 * @param handlers container for event listener functions
 */
export function setFsWatchListener(
  path: string,
  fullPath: string,
  options: Partial<FSWInstanceOptions>,
  handlers: BackendHandlers,
  signal: AbortSignal
): BackendSubscription | undefined {
  const resourceKey = fullPath as BackendResourceKey;
  const subscriber: NativeSubscriber = {
    ...handlers,
    watchedPath: path,
    persistent: options.persistent ?? true,
  };
  let cont = FsWatchInstances.get(resourceKey);
  if (cont) {
    attachWatcherSubscriber(cont, subscriber);
  } else {
    cont = createNativeContainer(path, toNativeWatchPath(path), resourceKey, options, subscriber);
    if (!cont) return;
  }
  const subscription = createWatcherSubscription(cont, subscriber, FsWatchInstances);
  if (signal.aborted) {
    void subscription.close();
    return;
  }
  return subscription;
}

// Owned polling helpers

type PollSubscriber = {
  watchedPath: Path;
  interval: number;
  persistent: boolean;
  publish: BackendHandlers['publish'];
  errHandler: WatchHandlers['errHandler'];
  rawEmitter: WatchHandlers['rawEmitter'];
};

type PollingSubscriptionOptions = Pick<PollSubscriber, 'interval' | 'persistent'>;

type PollResource = SharedResourceState<PollSubscriber> & {
  scheduler: Scheduler;
  interval: number;
  persistent: boolean;
  previous?: PollObservation;
  timer?: SchedulerTimer;
  running: boolean;
  sequence: number;
  currentPoll?: Promise<void>;
  directoryReplayAt?: number;
};

const MISSING_POLL_OBSERVATION: MissingPollObservation = Object.freeze({ missing: true });
const PollingInstances = new Map<BackendResourceKey, Map<Scheduler, PollResource>>();

export function isMissingObservation(
  observation: PollObservation
): observation is MissingPollObservation {
  return 'missing' in observation;
}

function observationsDiffer(previous: PollObservation, current: PollObservation): boolean {
  const previousMissing = isMissingObservation(previous);
  const currentMissing = isMissingObservation(current);
  if (previousMissing || currentMissing) return previousMissing !== currentMissing;

  const reliableInodeChanged =
    !isWindows && previous.ino !== 0 && current.ino !== 0 && previous.ino !== current.ino;
  return (
    previous.size !== current.size || previous.mtimeMs !== current.mtimeMs || reliableInodeChanged
  );
}

function setTimerPersistence(resource: PollResource): void {
  if (!resource.timer) return;
  if (resource.persistent) resource.timer.ref();
  else resource.timer.unref();
}

function schedulePoll(resource: PollResource, delay = resource.interval): void {
  if (resource.closed || resource.subscribers.size === 0) return;
  resource.timer = resource.scheduler.setTimeout(() => {
    resource.timer = undefined;
    const currentPoll = pollResource(resource);
    resource.currentPoll = currentPoll;
    void currentPoll.then(
      () => {
        if (resource.currentPoll === currentPoll) resource.currentPoll = undefined;
      },
      () => {
        if (resource.currentPoll === currentPoll) resource.currentPoll = undefined;
      }
    );
  }, delay);
  setTimerPersistence(resource);
}

async function pollResource(resource: PollResource): Promise<void> {
  if (resource.closed || resource.running || resource.subscribers.size === 0) return;
  resource.running = true;
  const startedAt = resource.scheduler.now();
  let current: PollObservation | undefined;
  try {
    current = await stat(resource.resource);
  } catch (error) {
    if (isMissingError(error)) {
      current = MISSING_POLL_OBSERVATION;
    } else {
      resource.subscribers.forEach((subscriber) => subscriber.errHandler(error));
    }
  }

  if (!resource.closed && current) {
    const previous = resource.previous;
    resource.previous = current;
    const now = resource.scheduler.now();
    const changed = previous && observationsDiffer(previous, current);
    const directoryReplayDue =
      resource.directoryReplayAt !== undefined && now >= resource.directoryReplayAt;
    if (!isMissingObservation(current) && current.isDirectory()) {
      if (changed) resource.directoryReplayAt = now + POLL_DIRECTORY_RECHECK_DELAY;
      else if (directoryReplayDue) resource.directoryReplayAt = undefined;
    } else {
      resource.directoryReplayAt = undefined;
    }
    if (previous && (changed || directoryReplayDue)) {
      const trigger: PollTrigger = {
        kind: 'poll',
        resource: resource.resource,
        current,
        previous,
        sequence: ++resource.sequence,
        observedAt: resource.scheduler.now(),
      };
      resource.subscribers.forEach((subscriber) => {
        subscriber.rawEmitter(EV.CHANGE, resource.resource, { current, previous });
        subscriber.publish(trigger);
      });
    }
  }

  resource.running = false;
  if (!resource.closed && resource.subscribers.size > 0) {
    const elapsed = resource.scheduler.now() - startedAt;
    schedulePoll(resource, Math.max(0, resource.interval - elapsed));
  }
}

function reconfigurePollResource(resource: PollResource): void {
  if (resource.closed || resource.subscribers.size === 0) return;
  const interval = Math.min(...[...resource.subscribers].map((subscriber) => subscriber.interval));
  const persistent = [...resource.subscribers].some((subscriber) => subscriber.persistent);
  const intervalChanged = resource.interval !== interval;
  resource.interval = interval;
  resource.persistent = persistent;

  if (resource.timer && intervalChanged) {
    resource.scheduler.clearTimeout(resource.timer);
    resource.timer = undefined;
    schedulePoll(resource);
  } else if (resource.timer) {
    setTimerPersistence(resource);
  } else if (!resource.running) {
    schedulePoll(resource);
  }
}

/**
 * Adds a subscriber to a Chokidar-owned polling resource.
 */
export function setPollingListener(
  path: Path,
  fullPath: Path,
  options: PollingSubscriptionOptions,
  scheduler: Scheduler,
  handlers: BackendHandlers,
  initialStats: Stats | undefined,
  signal: AbortSignal
): BackendSubscription | undefined {
  const resourceKey = fullPath as BackendResourceKey;
  const subscriber: PollSubscriber = { watchedPath: path, ...options, ...handlers };
  let resources = PollingInstances.get(resourceKey);
  if (!resources) {
    resources = new Map();
    PollingInstances.set(resourceKey, resources);
  }
  let resource = resources.get(scheduler);
  if (!resource) {
    resource = {
      resource: resourceKey,
      generation: allocateSharedResourceGeneration(),
      scheduler,
      subscribers: new Set(),
      interval: options.interval,
      persistent: options.persistent,
      previous: initialStats,
      running: false,
      closed: false,
      sequence: 0,
    };
    resources.set(scheduler, resource);
  } else if (!resource.previous && initialStats) {
    resource.previous = initialStats;
  }
  resource.subscribers.add(subscriber);
  reconfigurePollResource(resource);

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const subscription: BackendSubscription = {
    resource: resourceKey,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (closed) return;
        closed = true;
        resource.subscribers.delete(subscriber);
        if (resource.subscribers.size > 0) {
          reconfigurePollResource(resource);
          return;
        }
        if (resource.closed) return;
        resource.closed = true;
        if (resource.timer) resource.scheduler.clearTimeout(resource.timer);
        resource.timer = undefined;
        const currentResources = PollingInstances.get(resourceKey);
        if (currentResources?.get(scheduler) === resource) {
          currentResources.delete(scheduler);
          if (currentResources.size === 0) PollingInstances.delete(resourceKey);
        }
        if (resource.currentPoll) {
          await Promise.allSettled([resource.currentPoll]);
        }
      })();
      return closePromise;
    },
  };
  if (signal.aborted) {
    void subscription.close();
    return;
  }
  return subscription;
}

/**
 * @mixin
 */

export function setRecursiveWatchFactoryForTests(factory?: RecursiveWatchFactory): void {
  if (RecursiveWatchInstances.size > 0) {
    throw new Error('Cannot replace the recursive watch factory while resources are active');
  }
  recursiveWatchFactory = factory ?? systemRecursiveWatchFactory;
  recursiveWatchUnsupported = false;
}

export function setNativeWatchFactoryForTests(factory?: NativeWatchFactory): void {
  if (FsWatchInstances.size > 0) {
    throw new Error('Cannot replace the native watch factory while resources are active');
  }
  nativeWatchFactory = factory ?? systemNativeWatchFactory;
}

export function failRecursiveWatch(path: string, error: unknown): boolean {
  const resource = RecursiveWatchInstances.get(sp.resolve(path) as BackendResourceKey);
  if (!resource) return false;
  failRecursiveResource(resource, error);
  return true;
}

export async function failNativeWatch(
  path: string,
  error: Error & { code: string }
): Promise<boolean> {
  const resource = FsWatchInstances.get(sp.resolve(path) as BackendResourceKey);
  if (!resource) return false;
  await handleNativeError(path, resource, error);
  return true;
}

export function nativeResourceCountForTests(): number {
  return FsWatchInstances.size;
}
