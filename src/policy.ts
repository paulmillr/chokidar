import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as sp from 'node:path';
import {
  EVENTS,
  isMissingError,
  isWindows,
  logicalPathKey,
  type EmitArgs,
  type EmitArgsWithName,
  type EmitErrorArgs,
  type EventName,
  type FSWInstanceOptions,
  type LogicalPathKey,
  type Path,
  type Scheduler,
  type SchedulerTimer,
  type Throttler,
  type ThrottleType,
} from './runtime.js';
import { LifecycleScope } from './tree.js';

export type PendingWrite = { lastChange: number; cancelWait: () => EventName };
export type PendingChangeEmission = {
  path: Path;
  stats?: Stats;
  replay: boolean;
};

type EventPolicyContext = {
  options: FSWInstanceOptions;
  scheduler: Scheduler;
  lifecycle: LifecycleScope;
  isClosed: () => boolean;
  capturePathGeneration: () => number;
  isPathGenerationActive: (path: Path, generation: number) => boolean;
  isReady: () => boolean;
  remove: (directory: string, item: string) => void;
  handleError: (error: Error) => void;
  publish: (event: EventName, args: EmitArgs | EmitErrorArgs) => void;
};

function sameChangeStats(left: Stats | undefined, right: Stats | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino
  );
}

/** Converts truthful tree transitions into the public, timing-aware event API. */
export class EventPolicy {
  readonly pendingWrites: Map<string, PendingWrite> = new Map();
  readonly pendingUnlinks: Map<string, { event: EmitArgsWithName; timer: SchedulerTimer }> =
    new Map();
  readonly pendingChanges: Map<string, PendingChangeEmission> = new Map();
  readonly throttled: Map<ThrottleType, Map<string, Throttler>> = new Map();
  private readonly context: EventPolicyContext;

  constructor(context: EventPolicyContext) {
    this.context = context;
  }

  private setTimeout(callback: () => void, delay: number): SchedulerTimer {
    const timer = this.context.scheduler.setTimeout(callback, delay);
    if (!this.context.options.persistent) timer.unref();
    return timer;
  }

  async emit(event: EventName, path: Path, stats?: Stats): Promise<void> {
    if (this.context.isClosed()) return;

    const { options, scheduler } = this.context;
    const sourcePath = path;
    const logicalKey = logicalPathKey(path);
    const generation = this.context.lifecycle.generation;
    const pathGeneration = this.context.capturePathGeneration();
    if (isWindows) path = sp.normalize(path);
    if (options.cwd) path = sp.relative(options.cwd, path);
    const args: EmitArgs | EmitErrorArgs = [path];
    if (stats != null) args.push(stats);

    if (event === EVENTS.UNLINK || event === EVENTS.UNLINK_DIR) {
      this.pendingChanges.delete(logicalKey);
      this.throttled.get(EVENTS.CHANGE)?.get(logicalKey)?.clear(false);
    }

    const awf = options.awaitWriteFinish;
    const pendingWrite = awf ? this.pendingWrites.get(logicalKey) : undefined;
    if (pendingWrite) {
      pendingWrite.lastChange = scheduler.now();
      return;
    }

    if (options.atomic) {
      if (event === EVENTS.UNLINK) {
        const existing = this.pendingUnlinks.get(logicalKey);
        if (existing) scheduler.clearTimeout(existing.timer);
        const entry: EmitArgsWithName = [event, ...(args as EmitArgs)];
        const timer = this.setTimeout(
          () => {
            const pending = this.pendingUnlinks.get(logicalKey);
            if (!pending || pending.timer !== timer) return;
            this.pendingUnlinks.delete(logicalKey);
            if (this.context.isClosed()) return;
            const [pendingEvent, ...pendingArgs] = pending.event;
            this.context.publish(pendingEvent, pendingArgs as EmitArgs);
          },
          typeof options.atomic === 'number' ? options.atomic : 100
        );
        this.pendingUnlinks.set(logicalKey, { event: entry, timer });
        return;
      }
      const pendingUnlink = this.pendingUnlinks.get(logicalKey);
      if (event === EVENTS.ADD && pendingUnlink) {
        event = EVENTS.CHANGE;
        scheduler.clearTimeout(pendingUnlink.timer);
        this.pendingUnlinks.delete(logicalKey);
      }
    }

    if (awf && (event === EVENTS.ADD || event === EVENTS.CHANGE) && this.context.isReady()) {
      const awfEmit = (error?: Error, currentStats?: Stats) => {
        if (this.context.isClosed()) return;
        if (error) {
          event = EVENTS.ERROR;
          (args as unknown as EmitErrorArgs)[0] = error;
          this.context.publish(event, args);
        } else if (currentStats) {
          if (args.length > 1) args[1] = currentStats;
          else args.push(currentStats);
          this.context.publish(event, args);
        }
      };
      this.awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit, logicalKey);
      return;
    }

    if (event === EVENTS.CHANGE) {
      const throttler = this.throttle(EVENTS.CHANGE, sourcePath, 50, (suppressedCount) => {
        const pending = this.pendingChanges.get(logicalKey);
        this.pendingChanges.delete(logicalKey);
        if (
          suppressedCount > 0 &&
          pending?.replay &&
          this.context.lifecycle.isActive(generation) &&
          this.context.isPathGenerationActive(logicalKey, pathGeneration)
        ) {
          void this.emit(EVENTS.CHANGE, pending.path, pending.stats);
        }
      });
      if (!throttler) {
        const pending = this.pendingChanges.get(logicalKey);
        if (pending && !sameChangeStats(pending.stats, stats)) {
          pending.path = sourcePath;
          pending.stats = stats;
          pending.replay = true;
        }
        return;
      }
      this.pendingChanges.set(logicalKey, { path: sourcePath, stats, replay: false });
    }

    if (
      options.alwaysStat &&
      stats === undefined &&
      (event === EVENTS.ADD || event === EVENTS.ADD_DIR || event === EVENTS.CHANGE)
    ) {
      const fullPath = options.cwd ? sp.join(options.cwd, path) : path;
      try {
        stats = await stat(fullPath);
      } catch (error) {
        this.context.handleError(error as Error);
      }
      if (
        !stats ||
        !this.context.lifecycle.isActive(generation) ||
        !this.context.isPathGenerationActive(logicalKey, pathGeneration)
      ) {
        return;
      }
      args.push(stats);
    }
    this.context.publish(event, args);
  }

  throttle(
    actionType: ThrottleType,
    path: Path,
    timeout: number,
    onRelease?: (suppressedCount: number) => void
  ): Throttler | false {
    let action = this.throttled.get(actionType);
    if (!action) {
      action = new Map();
      this.throttled.set(actionType, action);
    }
    const key = actionType === 'readdir' ? path : logicalPathKey(path);
    const active = action.get(key);
    if (active) {
      active.count += 1;
      return false;
    }

    let timeoutObject: SchedulerTimer;
    const clear = (invokeRelease = true): number => {
      const item = action.get(key);
      const count = item?.count ?? 0;
      action.delete(key);
      this.context.scheduler.clearTimeout(timeoutObject);
      if (item) this.context.scheduler.clearTimeout(item.timeoutObject);
      if (invokeRelease && onRelease) onRelease(count);
      return count;
    };
    timeoutObject = this.setTimeout(clear, timeout);
    const throttler: Throttler = { timeoutObject, clear, count: 0 };
    action.set(key, throttler);
    return throttler;
  }

  awaitWriteFinish(
    path: Path,
    threshold: number,
    event: EventName,
    awfEmit: (error?: Error, stats?: Stats) => void,
    logicalKey?: LogicalPathKey
  ): void {
    const awf = this.context.options.awaitWriteFinish;
    if (typeof awf !== 'object') return;
    const pollInterval = awf.pollInterval;
    let timeoutHandler: SchedulerTimer | undefined;
    let fullPath = path;
    if (this.context.options.cwd && !sp.isAbsolute(path)) {
      fullPath = sp.join(this.context.options.cwd, path);
    }
    const writeKey = logicalKey ?? logicalPathKey(fullPath);
    const generation = this.context.lifecycle.generation;

    const inspect = (previous?: Stats): void => {
      const task = (async () => {
        let current: Stats;
        try {
          current = await stat(fullPath);
        } catch (error) {
          if (!this.context.lifecycle.isActive(generation) || !this.pendingWrites.has(writeKey)) {
            return;
          }
          if (isMissingError(error)) {
            this.context.remove(sp.dirname(fullPath), sp.basename(fullPath));
          } else {
            this.pendingWrites.delete(writeKey);
            awfEmit(error as Error);
          }
          return;
        }

        if (!this.context.lifecycle.isActive(generation) || !this.pendingWrites.has(writeKey)) {
          return;
        }
        const now = this.context.scheduler.now();
        const pending = this.pendingWrites.get(writeKey);
        if (!pending) return;
        if (previous && current.size !== previous.size) pending.lastChange = now;
        if (now - pending.lastChange >= threshold) {
          this.pendingWrites.delete(writeKey);
          awfEmit(undefined, current);
        } else {
          timeoutHandler = this.setTimeout(() => inspect(current), pollInterval);
        }
      })();
      this.context.lifecycle.track(task);
    };

    if (!this.pendingWrites.has(writeKey)) {
      this.pendingWrites.set(writeKey, {
        lastChange: this.context.scheduler.now(),
        cancelWait: () => {
          this.pendingWrites.delete(writeKey);
          this.context.scheduler.clearTimeout(timeoutHandler);
          return event;
        },
      });
      timeoutHandler = this.setTimeout(inspect, pollInterval);
    }
  }

  cancelPath(path: Path): void {
    const logicalKey = logicalPathKey(path);
    const pendingUnlink = this.pendingUnlinks.get(logicalKey);
    if (pendingUnlink) {
      this.context.scheduler.clearTimeout(pendingUnlink.timer);
      this.pendingUnlinks.delete(logicalKey);
    }
    this.pendingWrites.get(logicalKey)?.cancelWait();
    this.pendingChanges.delete(logicalKey);
    (['watch', 'add', 'remove', 'change'] as const).forEach((actionType) => {
      this.throttled.get(actionType)?.get(logicalKey)?.clear(false);
    });
    const readdirEntries = this.throttled.get('readdir');
    readdirEntries?.get(logicalKey)?.clear(false);
    readdirEntries
      ?.get(`${logicalPathKey(sp.dirname(logicalKey))}\0${sp.basename(logicalKey)}`)
      ?.clear(false);
  }

  cancelWhere(contains: (path: string) => boolean): void {
    const paths = new Set([
      ...this.pendingUnlinks.keys(),
      ...this.pendingWrites.keys(),
      ...this.pendingChanges.keys(),
    ]);
    [...paths].filter(contains).forEach((path) => this.cancelPath(path));
    this.throttled.forEach((entries, actionType) => {
      [...entries.keys()]
        .filter((key) => contains(actionType === 'readdir' ? key.split('\0', 1)[0] : key))
        .forEach((key) => entries.get(key)?.clear(false));
    });
  }

  close(): void {
    this.pendingWrites.forEach((pending) => pending.cancelWait());
    this.pendingUnlinks.forEach(({ timer }) => this.context.scheduler.clearTimeout(timer));
    this.pendingUnlinks.clear();
    this.pendingChanges.clear();
    this.throttled.forEach((entries) => {
      entries.forEach((throttler) => throttler.clear(false));
    });
    this.throttled.clear();
  }
}
