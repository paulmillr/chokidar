import { describe, it } from '@paulmillr/jsbt/test.js';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watch as nativeWatch, unwatchFile, watchFile, type WatchListener } from 'node:fs';
import {
  lstat,
  realpath,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile as write,
} from 'node:fs/promises';
import * as sp from 'node:path';
import type { EmitArgs, FSWatcherEventMap, Scheduler, SchedulerTimer } from './index.js';

import * as chokidar from './index.js';
import {
  type BackendResourceKey,
  EVENTS as EV,
  type EventName,
  isIBMi,
  isMacos,
  isWindows,
} from './runtime.js';
import { backendTesting, inspectWatcher as internals } from './testing.js';

type SpyFn<TArgs extends any[] = any[], TReturn = any> = ((...args: TArgs) => TReturn) & {
  readonly called: boolean;
  readonly callCount: number;
  calls: TArgs[];
  reset: () => void;
};

type Spy<TArgs extends any[] = any[], TReturn = any> = SpyFn<TArgs, TReturn>;

export interface TestHarness {
  readonly currentDir: string;
  readonly testId: number;
  FIXTURES_PATH: string;
  WATCHERS: chokidar.FSWatcher[];
  calledWith<TArgs extends unknown[], TReturn>(
    spy: Spy<TArgs, TReturn>,
    args: TArgs,
    strict?: boolean
  ): boolean;
  canUseRecursiveWatch: boolean;
  createSpy<TArgs extends any[] = any[], TReturn = any>(
    implementation?: (...args: TArgs) => TReturn
  ): Spy<TArgs, TReturn>;
  cwatch(
    path?: Parameters<typeof chokidar.watch>[0],
    opts?: chokidar.ChokidarOptions
  ): chokidar.FSWatcher;
  delay(delayTime?: number): Promise<void>;
  dpath(subPath: string): string;
  getCallsWith<TArgs extends unknown[], TReturn>(
    spy: Spy<TArgs, TReturn>,
    args: TArgs,
    strict?: boolean
  ): TArgs[];
  mkdir(dir: string, opts?: Record<string, unknown>): Promise<void>;
  rmr(dir: string): Promise<void>;
  waitFor(spies: Array<Spy | [spy: Spy, callCount: number, args?: unknown[]]>): Promise<void>;
  waitForWatcher(watcher: chokidar.FSWatcher): Promise<void>;
}

class VirtualTimer implements SchedulerTimer {
  active = true;
  referenced = true;
  scheduler: VirtualScheduler;
  callback: () => void;
  due: number;
  order: number;
  constructor(scheduler: VirtualScheduler, callback: () => void, due: number, order: number) {
    this.scheduler = scheduler;
    this.callback = callback;
    this.due = due;
    this.order = order;
  }

  ref(): this {
    this.referenced = true;
    return this;
  }

  unref(): this {
    this.referenced = false;
    return this;
  }
}

class VirtualScheduler implements Scheduler {
  currentTime = 0;
  nextOrder = 0;
  timers = new Set<VirtualTimer>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delay: number): VirtualTimer {
    const timer = new VirtualTimer(
      this,
      callback,
      this.currentTime + Math.max(0, delay),
      this.nextOrder++
    );
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(timer: SchedulerTimer | undefined): void {
    if (!(timer instanceof VirtualTimer) || timer.scheduler !== this) return;
    timer.active = false;
    this.timers.delete(timer);
  }

  advanceBy(duration: number): void {
    const target = this.currentTime + duration;
    while (true) {
      const next = [...this.timers]
        .filter((timer) => timer.active && timer.due <= target)
        .sort((left, right) => left.due - right.due || left.order - right.order)[0];
      if (!next) break;
      this.currentTime = next.due;
      next.active = false;
      this.timers.delete(next);
      next.callback();
    }
    this.currentTime = target;
  }

  get activeCount(): number {
    return this.timers.size;
  }

  get referencedCount(): number {
    return [...this.timers].filter((timer) => timer.referenced).length;
  }

  get nextDelay(): number | undefined {
    const due = Math.min(...[...this.timers].map((timer) => timer.due));
    return Number.isFinite(due) ? due - this.currentTime : undefined;
  }
}

function createFakeNativeWatcher(): ReturnType<typeof nativeWatch> {
  const resource = new EventEmitter() as ReturnType<typeof nativeWatch>;
  resource.close = () => {
    resource.emit('close');
  };
  resource.ref = () => resource;
  resource.unref = () => resource;
  return resource;
}

export function registerV6Tests(context: TestHarness): void {
  const {
    FIXTURES_PATH,
    WATCHERS,
    calledWith,
    canUseRecursiveWatch,
    createSpy,
    cwatch,
    delay,
    dpath,
    getCallsWith,
    mkdir,
    rmr,
    waitFor,
    waitForWatcher,
  } = context;

  describe('configuration normalization', () => {
    it('should stop walking up when a missing path is its own parent', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const root = sp.parse(process.cwd()).root;
      const addCalls = await internals(watcher).walkMissingRoot(root);

      equal(addCalls, 1);
    });

    it('should use defaults for explicitly undefined options', () => {
      const watcher = new chokidar.FSWatcher({
        persistent: undefined,
        ignoreInitial: undefined,
        ignorePermissionErrors: undefined,
        pollingInterval: undefined,
        pollingBinaryInterval: undefined,
        interval: undefined,
        binaryInterval: undefined,
        followSymlinks: undefined,
        backend: undefined,
        usePolling: undefined,
        atomic: undefined,
      });
      WATCHERS.push(watcher);
      equal(watcher.options.persistent, true);
      equal(watcher.options.ignoreInitial, false);
      equal(watcher.options.ignorePermissionErrors, false);
      equal(watcher.options.pollingInterval, 100);
      equal(watcher.options.pollingBinaryInterval, 300);
      equal(watcher.options.interval, 100);
      equal(watcher.options.binaryInterval, 300);
      equal(watcher.options.followSymlinks, true);
      equal(watcher.options.backend, isIBMi ? 'polling' : 'auto');
      equal(watcher.options.usePolling, isIBMi);
      equal(
        watcher.options.backendStrategy,
        isIBMi
          ? 'polling'
          : isMacos || isWindows
            ? 'native-recursive-preferred'
            : 'native-per-directory'
      );
      equal(watcher.options.atomic, !isIBMi);
    });

    it('should normalize deprecated polling interval aliases with new-name precedence', () => {
      const legacy = new chokidar.FSWatcher({ interval: 25, binaryInterval: 75 });
      const preferred = new chokidar.FSWatcher({
        pollingInterval: 10,
        pollingBinaryInterval: 30,
        interval: 25,
        binaryInterval: 75,
      });
      WATCHERS.push(legacy, preferred);

      equal(legacy.options.pollingInterval, 25);
      equal(legacy.options.pollingBinaryInterval, 75);
      equal(legacy.options.interval, 25);
      equal(legacy.options.binaryInterval, 75);
      equal(preferred.options.pollingInterval, 10);
      equal(preferred.options.pollingBinaryInterval, 30);
      equal(preferred.options.interval, 10);
      equal(preferred.options.binaryInterval, 30);
    });

    it('should treat depth Infinity as an unbounded auto backend (#1452)', () => {
      const watcher = new chokidar.FSWatcher({ depth: Number.POSITIVE_INFINITY });
      WATCHERS.push(watcher);

      equal(watcher.options.depth, undefined);
      equal(watcher.options.backend, isIBMi ? 'polling' : 'auto');
      equal(
        watcher.options.backendStrategy,
        isIBMi
          ? 'polling'
          : isMacos || isWindows
            ? 'native-recursive-preferred'
            : 'native-per-directory'
      );
    });

    it('should default atomic based on the final polling selection', async () => {
      if (isIBMi) return true;
      const previous = process.env.CHOKIDAR_USEPOLLING;
      delete process.env.CHOKIDAR_USEPOLLING;
      try {
        const autoWatcher = new chokidar.FSWatcher({ usePolling: false });
        const perDirectoryWatcher = new chokidar.FSWatcher({ backend: 'native' });
        const backendPollingWatcher = new chokidar.FSWatcher({
          backend: 'polling',
          usePolling: false,
        });
        const pollingWatcher = new chokidar.FSWatcher({ usePolling: true });
        const explicitWatcher = new chokidar.FSWatcher({ usePolling: true, atomic: true });
        const recursiveWatcher = new chokidar.FSWatcher({ backend: 'native-recursive' });
        const depthLimitedRecursiveWatcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          depth: 1,
        });
        const pollingRecursiveWatcher = new chokidar.FSWatcher({
          usePolling: true,
          backend: 'native-recursive',
        });
        WATCHERS.push(
          autoWatcher,
          perDirectoryWatcher,
          backendPollingWatcher,
          pollingWatcher,
          explicitWatcher,
          recursiveWatcher,
          depthLimitedRecursiveWatcher,
          pollingRecursiveWatcher
        );

        equal(autoWatcher.options.atomic, true);
        equal(autoWatcher.options.backend, 'auto');
        equal(
          autoWatcher.options.backendStrategy,
          isMacos || isWindows ? 'native-recursive-preferred' : 'native-per-directory'
        );
        equal(perDirectoryWatcher.options.backendStrategy, 'native-per-directory');
        equal(backendPollingWatcher.options.usePolling, true);
        equal(backendPollingWatcher.options.atomic, false);
        equal(pollingWatcher.options.atomic, false);
        equal(pollingWatcher.options.backend, 'polling');
        equal(explicitWatcher.options.atomic, true);
        equal(recursiveWatcher.options.backendStrategy, 'native-recursive-preferred');
        equal(depthLimitedRecursiveWatcher.options.backendStrategy, 'native-per-directory');
        equal(pollingRecursiveWatcher.options.backendStrategy, 'polling');
      } finally {
        if (previous === undefined) delete process.env.CHOKIDAR_USEPOLLING;
        else process.env.CHOKIDAR_USEPOLLING = previous;
      }
    });

    it('should validate timing and depth options', () => {
      const invalid: chokidar.ChokidarOptions[] = [
        { backend: 'invalid' as never },
        { pollingInterval: 0 },
        { pollingBinaryInterval: Number.POSITIVE_INFINITY },
        { interval: 0 },
        { binaryInterval: Number.POSITIVE_INFINITY },
        { atomic: -1 },
        { atomic: Number.NaN },
        { atomic: 'invalid' as never },
        { depth: -1 },
        { depth: 1.5 },
        { awaitWriteFinish: { pollInterval: 0 } },
        { awaitWriteFinish: { stabilityThreshold: -1 } },
      ];
      invalid.forEach((options) => {
        throws(() => new chokidar.FSWatcher(options), /must be/);
      });

      const watcher = new chokidar.FSWatcher({ atomic: 0, depth: 0 });
      WATCHERS.push(watcher);
      equal(watcher.options.atomic, 0);
      equal(watcher.options.depth, 0);
    });

    it('should reject an invalid CHOKIDAR_INTERVAL override', () => {
      const previous = process.env.CHOKIDAR_INTERVAL;
      process.env.CHOKIDAR_INTERVAL = 'not-a-number';
      try {
        throws(() => new chokidar.FSWatcher(), /pollingInterval must be/);
      } finally {
        if (previous === undefined) delete process.env.CHOKIDAR_INTERVAL;
        else process.env.CHOKIDAR_INTERVAL = previous;
      }
    });

    it('should own immutable option containers without freezing caller data', () => {
      const ignored: chokidar.Matcher[] = ['first'];
      const awaitWriteFinish = { pollInterval: 25, stabilityThreshold: 50 };
      const watcher = new chokidar.FSWatcher({ ignored, awaitWriteFinish });
      WATCHERS.push(watcher);

      ignored.push('second');
      awaitWriteFinish.pollInterval = 1;
      equal(watcher.options.ignored.length, 1);
      equal((watcher.options.awaitWriteFinish as chokidar.AWF).pollInterval, 25);
      ok(Object.isFrozen(watcher.options.ignored));
      ok(Object.isFrozen(watcher.options.awaitWriteFinish));
      equal(Object.isFrozen(ignored), false);
      equal(Object.isFrozen(awaitWriteFinish), false);

      const ownedMatcherPath = sp.join(context.currentDir, 'owned-matcher');
      const mutatedMatcherPath = sp.join(context.currentDir, 'caller-mutated');
      const matcher = { path: ownedMatcherPath, recursive: true };
      const matcherWatcher = new chokidar.FSWatcher({ ignored: matcher });
      WATCHERS.push(matcherWatcher);
      matcher.path = mutatedMatcherPath;
      equal(internals(matcherWatcher).isIgnored(sp.join(ownedMatcherPath, 'child.txt')), true);
      equal(internals(matcherWatcher).isIgnored(sp.join(mutatedMatcherPath, 'child.txt')), false);
      ok(Object.isFrozen(matcherWatcher.options.ignored[0]));
      equal(Object.isFrozen(matcher), false);
    });

    it('should clone global and sticky regex matchers', () => {
      const matcher = /.*ignored\.txt$/gy;
      matcher.lastIndex = 3;
      Object.freeze(matcher);
      const watcher = new chokidar.FSWatcher({ ignored: matcher });
      WATCHERS.push(watcher);

      equal(internals(watcher).isIgnored('/tmp/ignored.txt'), true);
      equal(internals(watcher).isIgnored('/tmp/ignored.txt'), true);
      equal(matcher.lastIndex, 3);
    });

    it('should treat a legal child with a dot-dot prefix as inside its parent', () => {
      const root = sp.resolve('/watched-root');
      const watcher = new chokidar.FSWatcher({
        ignored: { path: root, recursive: true },
      });
      WATCHERS.push(watcher);

      equal(internals(watcher).isIgnored(sp.join(root, '..legal-child')), true);
      equal(internals(watcher).isIgnored(sp.resolve(root, '..', 'outside')), false);
    });
  });

  describe('platform regressions', () => {
    it('should allow renaming a watched directory containing a subdirectory (#1380)', async () => {
      const source = dpath('nested-rename');
      const child = sp.join(source, 'subfolder', 'file.txt');
      const destination = dpath('nested-renamed');
      const renamedChild = sp.join(destination, 'subfolder', 'file.txt');
      await mkdir(sp.dirname(child), { recursive: true });
      await write(child, 'nested');

      const watcher = cwatch(context.currentDir, { ignoreInitial: true });
      await waitForWatcher(watcher);
      equal(
        watcher.options.backendStrategy,
        isIBMi
          ? 'polling'
          : isMacos || isWindows
            ? 'native-recursive-preferred'
            : 'native-per-directory'
      );
      await delay(100);

      await rename(source, destination);
      equal((await lstat(renamedChild)).isFile(), true);
    });

    it('should retain exact target fallbacks for explicitly watched macOS files', async () => {
      if (!isMacos) return true;
      const target = dpath('macos-followed-target.txt');
      const link = dpath('macos-followed-link.txt');
      await write(target, 'initial');
      await symlink(target, link);
      for (const [watchedPath, resourcePath] of [
        [target, sp.resolve(target)],
        [link, await realpath(target)],
      ]) {
        const watcher = cwatch(watchedPath, { backend: 'native-recursive', atomic: false });
        const errorSpy = createSpy<[unknown], void>();
        watcher.on(EV.ERROR, errorSpy);
        await waitForWatcher(watcher);

        const failure = Object.assign(new Error('simulated exact-target failure'), { code: 'EIO' });
        equal(await backendTesting.failNativeWatch(resourcePath, failure), true);
        await waitFor([[errorSpy, 1, [failure]]]);
      }
    });
  });

  describe('lifecycle and policy ownership', () => {
    it('should route rejected add work to the watcher error event (#1378)', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const failure = Object.assign(new Error('watch limit reached'), { code: 'ENOSPC' });
      const errorSpy = createSpy<[unknown], void>();
      watcher.on(EV.ERROR, errorSpy);
      internals(watcher).handler.addRoot = async () => {
        throw failure;
      };

      equal(watcher.add(dpath('rejected-add')), watcher);
      await waitFor([[errorSpy, 1, [failure]]]);
      equal(errorSpy.callCount, 1);
      equal(errorSpy.calls[0][0], failure);
      await internals(watcher).drainTasks();
    });

    it('should replay distinct rapid changes but collapse duplicate observations', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('change-observations.txt');
      await write(filePath, 'first');
      const firstStats = await lstat(filePath);
      const scheduler = new VirtualScheduler();

      const duplicateWatcher = new chokidar.FSWatcher({ atomic: false }, scheduler);
      WATCHERS.push(duplicateWatcher);
      const duplicateSpy = createSpy<EmitArgs, void>();
      duplicateWatcher.on(EV.CHANGE, duplicateSpy);
      await internals(duplicateWatcher).emitEvent(EV.CHANGE, filePath, firstStats);
      await internals(duplicateWatcher).emitEvent(EV.CHANGE, filePath, firstStats);
      scheduler.advanceBy(50);
      equal(duplicateSpy.callCount, 1);

      const distinctWatcher = new chokidar.FSWatcher({ atomic: false }, scheduler);
      WATCHERS.push(distinctWatcher);
      const distinctSpy = createSpy<EmitArgs, void>();
      distinctWatcher.on(EV.CHANGE, distinctSpy);
      await internals(distinctWatcher).emitEvent(EV.CHANGE, filePath, firstStats);
      await write(filePath, 'second-with-a-different-size');
      const secondStats = await lstat(filePath);
      await internals(distinctWatcher).emitEvent(EV.CHANGE, filePath, secondStats);
      scheduler.advanceBy(50);
      equal(distinctSpy.callCount, 2);
    });

    it('should make close terminal and suppress a late ready event', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const watcher = cwatch(context.currentDir);
      const closePromise = watcher.close();
      const readySpy = createSpy<[], void>();
      watcher.on(EV.READY, readySpy);

      throws(() => watcher.add(context.currentDir), /Cannot add paths after FSWatcher\.close/);
      equal(watcher.close(), closePromise);
      await closePromise;
      await delay();
      equal(readySpy.called, false);
      equal(internals(watcher).abortController.signal.aborted, true);
    });

    it('should give atomic unlinks independent deadlines', async () => {
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher({ atomic: 120 }, scheduler);
      WATCHERS.push(watcher);
      const spy = createSpy<FSWatcherEventMap['all'], void>();
      watcher.on(EV.ALL, spy);

      await internals(watcher).emitEvent(EV.UNLINK, 'first.txt');
      scheduler.advanceBy(70);
      await internals(watcher).emitEvent(EV.UNLINK, 'second.txt');
      scheduler.advanceBy(50);

      ok(calledWith(spy, [EV.UNLINK, 'first.txt']));
      equal(calledWith(spy, [EV.UNLINK, 'second.txt']), false);
      scheduler.advanceBy(70);
      ok(calledWith(spy, [EV.UNLINK, 'second.txt']));
      equal(scheduler.activeCount, 0);
    });

    it('should unref policy timers for a non-persistent watcher', async () => {
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher({ atomic: 100, persistent: false }, scheduler);
      WATCHERS.push(watcher);

      await internals(watcher).emitEvent(EV.UNLINK, 'non-persistent.txt');

      equal(scheduler.activeCount, 1);
      equal(scheduler.referencedCount, 0);
    });

    it('should cancel pending policy timers on close', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('pending.txt');
      await write(filePath, 'pending');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          atomic: 1000,
          awaitWriteFinish: { pollInterval: 1000, stabilityThreshold: 1000 },
        },
        scheduler
      );
      WATCHERS.push(watcher);

      await internals(watcher).emitEvent(EV.UNLINK, filePath);
      internals(watcher).awaitWriteFinish(filePath, 1000, EV.ADD, () => {});
      internals(watcher).throttle(EV.CHANGE, filePath, 1000);
      equal(internals(watcher).pendingUnlinks.size, 1);
      equal(internals(watcher).pendingWrites.size, 1);
      ok(internals(watcher).throttled.size > 0);
      equal(scheduler.activeCount, 3);

      await watcher.close();
      equal(internals(watcher).pendingUnlinks.size, 0);
      equal(internals(watcher).pendingWrites.size, 0);
      equal(internals(watcher).throttled.size, 0);
      equal(scheduler.activeCount, 0);
    });

    it('should cancel canonical policy timers on unwatch', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('unwatch-policy.txt');
      await write(filePath, 'pending');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          cwd: context.currentDir,
          atomic: 1000,
          awaitWriteFinish: { pollInterval: 1000, stabilityThreshold: 1000 },
        },
        scheduler
      );
      WATCHERS.push(watcher);

      await internals(watcher).emitEvent(EV.UNLINK, filePath);
      internals(watcher).awaitWriteFinish(filePath, 1000, EV.ADD, () => {});
      internals(watcher).throttle(EV.ADD, filePath, 1000);
      internals(watcher).throttle(EV.CHANGE, filePath, 1000);
      internals(watcher).throttle('watch', filePath, 1000);
      internals(watcher).throttle('remove', filePath, 1000);
      internals(watcher).throttle(
        'readdir',
        `${internals(watcher).logicalKey(sp.dirname(filePath))}\0${sp.basename(filePath)}`,
        1000
      );
      equal(scheduler.activeCount, 7);

      watcher.unwatch(sp.basename(filePath));

      equal(internals(watcher).pendingUnlinks.size, 0);
      equal(internals(watcher).pendingWrites.size, 0);
      equal(scheduler.activeCount, 0);
    });

    it('should close every owned polling resource below an unwatched directory', async () => {
      await mkdir(dpath('owned/subdir'), { recursive: true });
      await write(dpath('owned/subdir/file.txt'), 'value');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        { usePolling: true, pollingInterval: 100, ignoreInitial: true, cwd: context.currentDir },
        scheduler
      );
      WATCHERS.push(watcher);
      const ready = waitForWatcher(watcher);
      watcher.add('owned');
      await ready;
      ok(scheduler.activeCount >= 3);

      watcher.unwatch('owned');
      await internals(watcher).drainTasks();

      equal(scheduler.activeCount, 0);
      equal(
        [...internals(watcher).closers.keys()].some((path) =>
          path.startsWith(internals(watcher).logicalKey(dpath('owned')))
        ),
        false
      );
    });

    it('should stabilize awaitWriteFinish with virtual time', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('stable.txt');
      await write(filePath, 'stable');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          awaitWriteFinish: { pollInterval: 10, stabilityThreshold: 30 },
        },
        scheduler
      );
      WATCHERS.push(watcher);
      internals(watcher).readyEmitted = true;
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.ADD, spy);

      await internals(watcher).emitEvent(EV.ADD, filePath);
      for (let elapsed = 10; elapsed <= 30; elapsed += 10) {
        scheduler.advanceBy(10);
        await internals(watcher).drainTasks();
      }

      ok(calledWith(spy, [filePath]));
      equal(internals(watcher).pendingWrites.size, 0);
      equal(scheduler.activeCount, 0);
    });

    it('should clean up a deleted AWF-pending add without emitting unlink', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('deleted-during-awf.txt');
      await write(filePath, 'pending');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          atomic: false,
          awaitWriteFinish: { pollInterval: 100, stabilityThreshold: 500 },
        },
        scheduler
      );
      WATCHERS.push(watcher);
      internals(watcher).readyEmitted = true;
      internals(watcher).directoryEntry(context.currentDir).add(sp.basename(filePath));
      internals(watcher).directoryEntry(dpath('another-awf-directory'));
      const closer = createSpy<[], void>();
      internals(watcher).addPathCloser(filePath, closer);
      const allSpy = createSpy<FSWatcherEventMap['all'], void>();
      watcher.on(EV.ALL, allSpy);

      await internals(watcher).emitEvent(EV.ADD, filePath);
      equal(internals(watcher).pendingWrites.size, 1);
      await unlink(filePath);
      scheduler.advanceBy(100);
      await internals(watcher).drainTasks();
      internals(watcher).removePath(context.currentDir, sp.basename(filePath), false);

      equal(getCallsWith(allSpy, [EV.UNLINK, filePath]).length, 0);
      equal(getCallsWith(allSpy, [EV.ADD, filePath]).length, 0);
      equal(internals(watcher).pendingWrites.size, 0);
      equal(
        internals(watcher).directoryEntry(context.currentDir).has(sp.basename(filePath)),
        false
      );
      equal(internals(watcher).closers.has(internals(watcher).logicalKey(filePath)), false);
      equal(closer.callCount, 1);
    });

    it('should await tasks and closers handed off after close starts', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      let release!: () => void;
      let closerFinished = false;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      internals(watcher).trackTask(
        (async () => {
          await barrier;
          internals(watcher).addPathCloser('late.txt', async () => {
            await delay(20);
            closerFinished = true;
          });
        })()
      );

      const closePromise = watcher.close();
      release();
      await closePromise;
      equal(closerFinished, true);
      equal(internals(watcher).tasks.size, 0);
      equal(internals(watcher).state, 'CLOSED');
    });

    it('should let a re-add supersede an in-flight initial scan', async () => {
      await mkdir(context.currentDir, { recursive: true });
      await write(dpath('existing.txt'), 'existing');
      const watcher = new chokidar.FSWatcher({
        backend: 'native',
        ignoreInitial: true,
        atomic: false,
      });
      WATCHERS.push(watcher);
      const handler = internals(watcher).handler;
      const originalRead = handler.readDirectory.bind(handler);
      let releaseFirst!: () => void;
      let firstReadStarted!: () => void;
      const firstRead = new Promise<void>((resolve) => {
        firstReadStarted = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let intercepted = false;
      handler.readDirectory = async (...args) => {
        if (!intercepted) {
          intercepted = true;
          firstReadStarted();
          await barrier;
        }
        return originalRead(...args);
      };

      const ready = waitForWatcher(watcher);
      watcher.add(context.currentDir);
      await firstRead;
      watcher.unwatch(context.currentDir);
      watcher.add(context.currentDir);

      const key = internals(watcher).logicalKey(context.currentDir);
      for (let attempt = 0; attempt < 100 && !internals(watcher).closers.has(key); attempt++) {
        await delay(10);
      }
      ok(internals(watcher).closers.has(key), 'the replacement subscription was not registered');
      releaseFirst();
      await ready;
      await internals(watcher).drainTasks();
      equal(internals(watcher).closers.get(key)?.length, 1);

      const addSpy = createSpy<EmitArgs, void>();
      watcher.on(EV.ADD, addSpy);
      const added = dpath('after-readd.txt');
      await write(added, 'after');
      await waitFor([[addSpy, 1, [added]]]);
      equal(getCallsWith(addSpy, [added]).length, 1);
    });

    it('should suppress raw callbacks after close', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      await watcher.close();
      const spy = createSpy<FSWatcherEventMap['raw'], void>();
      watcher.on(EV.RAW, spy);

      internals(watcher).emitRaw(EV.CHANGE, null, { watchedPath: context.currentDir });
      equal(spy.called, false);
    });
  });

  describe('owned polling', () => {
    it('should use the normal interval for extensionless paths', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('extensionless');
      await write(filePath, 'value');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          usePolling: true,
          pollingInterval: 10,
          pollingBinaryInterval: 100,
          persistent: false,
          ignoreInitial: true,
        },
        scheduler
      );
      WATCHERS.push(watcher);
      const ready = waitForWatcher(watcher);
      watcher.add(filePath);
      await ready;

      equal(scheduler.nextDelay, 10);
      equal(scheduler.referencedCount, 0);
    });

    it('should use the binary interval for recognized extensions', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('image.png');
      await write(filePath, 'value');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          usePolling: true,
          pollingInterval: 10,
          pollingBinaryInterval: 100,
          persistent: false,
          ignoreInitial: true,
        },
        scheduler
      );
      WATCHERS.push(watcher);
      const ready = waitForWatcher(watcher);
      watcher.add(filePath);
      await ready;

      equal(scheduler.nextDelay, 100);
      equal(scheduler.referencedCount, 0);
    });

    it('should detect deletion of an empty directly watched directory', async () => {
      const watchedDir = dpath('empty-polling-root');
      await mkdir(watchedDir, { recursive: true });
      const watcher = cwatch(watchedDir, {
        usePolling: true,
        pollingInterval: 10,
        ignoreInitial: true,
      });
      await waitForWatcher(watcher);
      const unlinkDirSpy = createSpy<EmitArgs, void>();
      watcher.on(EV.UNLINK_DIR, unlinkDirSpy);

      await rmr(watchedDir);
      await waitFor([[unlinkDirSpy, 1, [watchedDir]]]);
      equal(getCallsWith(unlinkDirSpy, [watchedDir]).length, 1);
    });

    it('should detect a missed symlink unlink through the deletion monitor', async () => {
      if (isWindows || isIBMi) return true;
      await mkdir(context.currentDir, { recursive: true });
      const targetPath = dpath('monitored-target.txt');
      const filePath = dpath('monitored-symlink.txt');
      await write(targetPath, 'value');
      await symlink(targetPath, filePath);
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        { usePolling: false, pollingInterval: 25, ignoreInitial: true, atomic: false },
        scheduler
      );
      WATCHERS.push(watcher);
      internals(watcher).directoryEntry(context.currentDir).add(sp.basename(filePath));
      const closer = internals(watcher).handler.watchSymlinkDeletion(filePath, true);
      ok(closer);
      internals(watcher).addPathCloser(filePath, closer);
      const unlinkSpy = createSpy<EmitArgs, void>();
      watcher.on(EV.UNLINK, unlinkSpy);

      await unlink(filePath);
      scheduler.advanceBy(25);
      await delay();
      await internals(watcher).drainTasks();

      equal(getCallsWith(unlinkSpy, [filePath]).length, 1);
      await watcher.close();
      equal(scheduler.activeCount, 0);
    });

    it('should monitor a non-followed symlink without an exact native file handle', async () => {
      if (isWindows || isIBMi) return true;
      await mkdir(context.currentDir, { recursive: true });
      const targetPath = dpath('monitored-target-dir');
      const linkPath = dpath('monitored-dir-link');
      await mkdir(targetPath);
      await symlink(targetPath, linkPath);
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        {
          usePolling: false,
          followSymlinks: false,
          pollingInterval: 25,
          ignoreInitial: true,
          atomic: false,
        },
        scheduler
      );
      WATCHERS.push(watcher);
      const handler = internals(watcher).handler;
      const fileCloser = handler.handleFile(linkPath, await lstat(linkPath), true);
      const deletionCloser = handler.watchSymlinkDeletion(linkPath, true);
      equal(fileCloser, undefined);
      ok(deletionCloser);
      internals(watcher).addPathCloser(linkPath, deletionCloser);
      const unlinkSpy = createSpy<EmitArgs, void>();
      watcher.on(EV.UNLINK, unlinkSpy);

      await unlink(linkPath);
      scheduler.advanceBy(25);
      await delay();
      await internals(watcher).drainTasks();

      equal(getCallsWith(unlinkSpy, [linkPath]).length, 1);
      await watcher.close();
      equal(scheduler.activeCount, 0);
    });

    it('should use directory resources rather than one native handle per regular file', async () => {
      if (isIBMi) return true;
      const root = dpath('directory-resource-tree');
      const nested = sp.join(root, 'nested');
      await mkdir(nested, { recursive: true });
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          write(sp.join(index % 2 === 0 ? root : nested, `file-${index}.txt`), 'initial')
        )
      );
      const before = backendTesting.nativeResourceCount();
      const watcher = cwatch(root, { backend: 'native', atomic: false });
      await waitForWatcher(watcher);

      const resources = backendTesting.nativeResourceCount() - before;
      ok(resources <= (isWindows ? 3 : 2), `opened ${resources} native resources`);

      const changed = sp.join(nested, 'file-1.txt');
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.CHANGE, spy);
      await write(changed, 'changed');
      await waitFor([[spy, 1, [changed]]]);
    });

    it('should retire an exact file fallback and suppress its delayed directory echo', async () => {
      if (isIBMi) return true;
      const filePath = dpath('mapped-file-handoff.txt');
      await write(filePath, 'initial');
      const scheduler = new VirtualScheduler();
      const listeners: WatchListener<string>[] = [];
      let watcher: chokidar.FSWatcher | undefined;
      backendTesting.setNativeWatchFactory((_path, _options, listener) => {
        listeners.push(listener);
        return createFakeNativeWatcher();
      });

      try {
        watcher = new chokidar.FSWatcher(
          { backend: 'native', ignoreInitial: true, atomic: false },
          scheduler
        );
        WATCHERS.push(watcher);
        const state = internals(watcher);
        const initialStats = await lstat(filePath);
        state.handler.handleFile(filePath, initialStats, true, false, undefined, false, true);
        const closer = state.handler.subscribeMappedFile(
          filePath,
          filePath,
          state.createHelper(filePath),
          1,
          true
        );
        ok(closer);
        state.addPathCloser(filePath, closer);

        const [directoryListener, exactListener] = listeners;
        ok(directoryListener);
        ok(exactListener);
        equal(backendTesting.nativeResourceCount(), 2);

        const changes = createSpy<EmitArgs, void>();
        watcher.on(EV.CHANGE, changes);
        await write(filePath, 'first changed value');
        exactListener(EV.CHANGE, sp.basename(filePath));
        await state.drainTasks();
        equal(getCallsWith(changes, [filePath]).length, 1);
        equal(backendTesting.nativeResourceCount(), 1);

        scheduler.advanceBy(100);
        await delay(25);
        directoryListener(EV.CHANGE, sp.basename(filePath));
        await state.drainTasks();
        equal(getCallsWith(changes, [filePath]).length, 1);

        scheduler.advanceBy(100);
        await write(filePath, 'second changed value is distinct');
        await delay(20);
        directoryListener(EV.CHANGE, sp.basename(filePath));
        await state.drainTasks();
        equal(getCallsWith(changes, [filePath]).length, 2);

        scheduler.advanceBy(100);
        exactListener(EV.CHANGE, sp.basename(filePath));
        await state.drainTasks();
        equal(getCallsWith(changes, [filePath]).length, 2);

        const parentFirstPath = dpath('mapped-file-parent-first.txt');
        await write(parentFirstPath, 'initial');
        state.handler.handleFile(
          parentFirstPath,
          await lstat(parentFirstPath),
          true,
          false,
          undefined,
          false,
          true
        );
        const parentFirstCloser = state.handler.subscribeMappedFile(
          parentFirstPath,
          parentFirstPath,
          state.createHelper(parentFirstPath),
          1,
          true
        );
        ok(parentFirstCloser);
        state.addPathCloser(parentFirstPath, parentFirstCloser);
        const parentFirstExact = listeners[2];
        ok(parentFirstExact);
        equal(backendTesting.nativeResourceCount(), 2);

        await write(parentFirstPath, 'changed through parent');
        await delay(20);
        directoryListener(EV.CHANGE, sp.basename(parentFirstPath));
        await state.drainTasks();
        equal(getCallsWith(changes, [parentFirstPath]).length, 1);
        equal(backendTesting.nativeResourceCount(), 1);

        scheduler.advanceBy(100);
        parentFirstExact(EV.CHANGE, sp.basename(parentFirstPath));
        await state.drainTasks();
        equal(getCallsWith(changes, [parentFirstPath]).length, 1);
      } finally {
        if (watcher) await watcher.close();
        backendTesting.setNativeWatchFactory();
      }
    });

    it('should deterministically renegotiate interval and persistence', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('virtual-shared.txt');
      await write(filePath, 'before');
      const scheduler = new VirtualScheduler();
      const slow = new chokidar.FSWatcher(
        { usePolling: true, pollingInterval: 80, persistent: false, ignoreInitial: true },
        scheduler
      );
      const fast = new chokidar.FSWatcher(
        { usePolling: true, pollingInterval: 10, persistent: true, ignoreInitial: true },
        scheduler
      );
      WATCHERS.push(slow, fast);
      const slowReady = waitForWatcher(slow);
      slow.add(filePath);
      await slowReady;
      equal(scheduler.activeCount, 1);
      equal(scheduler.nextDelay, 80);
      equal(scheduler.referencedCount, 0);

      const fastReady = waitForWatcher(fast);
      fast.add(filePath);
      await fastReady;
      equal(scheduler.activeCount, 1);
      equal(scheduler.nextDelay, 10);
      equal(scheduler.referencedCount, 1);

      await fast.close();
      equal(scheduler.activeCount, 1);
      equal(scheduler.nextDelay, 80);
      equal(scheduler.referencedCount, 0);
      await slow.close();
      equal(scheduler.activeCount, 0);
    });

    it('should detect polling changes and clean up under virtual time', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('virtual-change.txt');
      await write(filePath, 'before');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        { usePolling: true, pollingInterval: 25, ignoreInitial: true },
        scheduler
      );
      WATCHERS.push(watcher);
      const ready = waitForWatcher(watcher);
      watcher.add(filePath);
      await ready;
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.CHANGE, spy);

      await write(filePath, 'after-with-a-different-size');
      const changed = new Promise<void>((resolve) => watcher.once(EV.CHANGE, () => resolve()));
      scheduler.advanceBy(25);
      await changed;
      await internals(watcher).drainTasks();

      ok(calledWith(spy, [filePath]));
      await watcher.close();
      equal(scheduler.activeCount, 0);
    });

    it('should preserve an external fs.watchFile listener', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('external.txt');
      await write(filePath, 'before');
      const externalSpy = createSpy();
      watchFile(filePath, { interval: 10 }, externalSpy);
      try {
        const watcher = cwatch(filePath, {
          usePolling: true,
          pollingInterval: 10,
          ignoreInitial: true,
        });
        await waitForWatcher(watcher);
        await watcher.close();

        await write(filePath, 'after');
        await waitFor([externalSpy]);
        ok(externalSpy.called);
      } finally {
        unwatchFile(filePath, externalSpy);
      }
    });

    it('should preserve slower subscribers when a faster subscriber closes', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('shared.txt');
      await write(filePath, 'before');
      const slow = cwatch(filePath, {
        usePolling: true,
        pollingInterval: 80,
        ignoreInitial: true,
      });
      const fast = cwatch(filePath, {
        usePolling: true,
        pollingInterval: 10,
        ignoreInitial: true,
      });
      await Promise.all([waitForWatcher(slow), waitForWatcher(fast)]);
      await fast.close();
      const spy = createSpy<EmitArgs, void>();
      slow.on(EV.CHANGE, spy);

      await write(filePath, 'after');
      await waitFor([spy]);
      ok(calledWith(spy, [filePath]));
    });

    it('should prevent a stale polling closer from closing a successor resource', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('successor.txt');
      await write(filePath, 'before');
      const first = cwatch(filePath, {
        usePolling: true,
        pollingInterval: 10,
        ignoreInitial: true,
      });
      await waitForWatcher(first);
      const staleCloser = [...internals(first).closers.values()].flat()[0];
      ok(staleCloser);
      await first.close();

      const successor = cwatch(filePath, {
        usePolling: true,
        pollingInterval: 10,
        ignoreInitial: true,
      });
      await waitForWatcher(successor);
      const spy = createSpy<EmitArgs, void>();
      successor.on(EV.CHANGE, spy);
      staleCloser();

      await write(filePath, 'after');
      await waitFor([spy]);
      ok(calledWith(spy, [filePath]));
    });

    it('should detect a backwards mtime change', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('backwards-mtime.txt');
      await write(filePath, 'same-size');
      const future = new Date(Date.now() + 60_000);
      await utimes(filePath, future, future);
      const watcher = cwatch(filePath, {
        usePolling: true,
        pollingInterval: 10,
        ignoreInitial: true,
      });
      await waitForWatcher(watcher);
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.CHANGE, spy);

      const past = new Date(Date.now() - 60_000);
      await utimes(filePath, past, past);
      await waitFor([spy]);
      ok(calledWith(spy, [filePath]));
    });

    if (!isWindows) {
      it('should detect reliable inode replacement with equal size and mtime', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const filePath = dpath('inode.txt');
        const replacementPath = dpath('replacement.txt');
        const timestamp = new Date(Date.now() - 60_000);
        await write(filePath, 'same-size');
        await write(replacementPath, 'new-value');
        await utimes(filePath, timestamp, timestamp);
        await utimes(replacementPath, timestamp, timestamp);
        const watcher = cwatch(filePath, {
          usePolling: true,
          pollingInterval: 10,
          ignoreInitial: true,
        });
        await waitForWatcher(watcher);
        const spy = createSpy<EmitArgs, void>();
        watcher.on(EV.CHANGE, spy);

        await rename(replacementPath, filePath);
        await waitFor([spy]);
        ok(calledWith(spy, [filePath]));
      });
    }
  });

  describe('native resource generations', () => {
    if (!isIBMi) {
      it('should detect deletion of an empty directly watched native directory', async () => {
        const watchedDir = dpath('empty-native-root');
        await mkdir(watchedDir, { recursive: true });
        const watcher = cwatch(watchedDir, {
          usePolling: false,
          backend: 'native',
          ignoreInitial: true,
        });
        await waitForWatcher(watcher);
        const unlinkDirSpy = createSpy<EmitArgs, void>();
        watcher.on(EV.UNLINK_DIR, unlinkDirSpy);

        await rmr(watchedDir);
        await waitFor([[unlinkDirSpy, 1, [watchedDir]]]);
        equal(getCallsWith(unlinkDirSpy, [watchedDir]).length, 1);
      });

      it('should not let stale native closers kill a successor after failure', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const first = cwatch(context.currentDir, {
          usePolling: false,
          backend: 'native',
          ignoreInitial: true,
        });
        const second = cwatch(context.currentDir, {
          usePolling: false,
          backend: 'native',
          ignoreInitial: true,
        });
        await Promise.all([waitForWatcher(first), waitForWatcher(second)]);
        const firstError = createSpy<[unknown], void>();
        const secondError = createSpy<[unknown], void>();
        first.on(EV.ERROR, firstError);
        second.on(EV.ERROR, secondError);
        const failure = Object.assign(new Error('simulated native failure'), { code: 'EIO' });

        equal(await backendTesting.failNativeWatch(context.currentDir, failure), true);
        equal(firstError.callCount, 1);
        equal(secondError.callCount, 1);

        const successor = cwatch(context.currentDir, {
          usePolling: false,
          backend: 'native',
          ignoreInitial: true,
        });
        await waitForWatcher(successor);
        await Promise.all([first.close(), second.close()]);
        const addSpy = createSpy<EmitArgs, void>();
        successor.on(EV.ADD, addSpy);
        const filePath = dpath('native-successor.txt');

        await write(filePath, 'successor');
        await waitFor([[addSpy, 1, [filePath]]]);
        equal(getCallsWith(addSpy, [filePath]).length, 1);
      });
    }
  });

  describe('scanner finalization', () => {
    it('should allow callers to override scanner depth', async () => {
      await mkdir(dpath('subdir'), { recursive: true });
      await write(dpath('subdir/nested.txt'), 'nested');
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const entries: string[] = [];
      const stream = internals(watcher).createScanStream(context.currentDir, { depth: 1 });
      ok(stream);
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (entry) => entries.push(entry.path));
        stream.once(EV.ERROR, reject);
        stream.once('end', resolve);
      });

      ok(entries.includes(sp.join('subdir', 'nested.txt')));
      equal(internals(watcher).streams.size, 0);
    });

    it('should settle an interrupted directory scan and release the stream', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const helper = internals(watcher).createHelper(context.currentDir);
      const pending = internals(watcher).handler.readDirectory(
        context.currentDir,
        true,
        helper,
        undefined,
        context.currentDir,
        0
      );
      internals(watcher).streams.forEach((stream) => stream.destroy());
      await pending;

      equal(internals(watcher).streams.size, 0);
    });

    it('should settle and report an errored directory scan', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const errorSpy = createSpy<[unknown], void>();
      watcher.on(EV.ERROR, errorSpy);
      const helper = internals(watcher).createHelper(context.currentDir);
      const pending = internals(watcher).handler.readDirectory(
        context.currentDir,
        true,
        helper,
        undefined,
        context.currentDir,
        0
      );
      const stream = [...internals(watcher).streams][0];
      ok(stream);
      const failure = Object.assign(new Error('simulated scanner failure'), { code: 'EIO' });
      stream.destroy(failure);
      await pending;

      equal(errorSpy.callCount, 1);
      equal(errorSpy.calls[0][0], failure);
      equal(internals(watcher).streams.size, 0);
    });
  });

  describe('reconciliation regressions', () => {
    it('should ignore an unchanged ambiguous parent invalidation for a direct native file', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const file = dpath('direct-parent-invalidation.txt');
      await write(file, 'unchanged');
      const watcher = cwatch(file, { backend: 'native', atomic: false });
      await waitForWatcher(watcher);
      const state = internals(watcher);
      equal(state.observed.get(state.logicalKey(file))?.transition, 'add');
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.CHANGE, spy);
      const parent = sp.dirname(file);

      await state.handler.reconcileNativeTrigger(
        parent,
        state.createHelper(parent),
        {
          kind: 'native',
          resource: parent as BackendResourceKey,
          rawEvent: 'rename',
          relativePath: null,
          sequence: 1,
          observedAt: Date.now(),
        },
        file
      );

      equal(spy.callCount, 0);
    });

    it('should replay the latest invalidation coalesced during reconciliation', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const calls: string[] = [];
      let release!: () => void;
      let markStarted!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const scope = dpath('coalesced');

      const first = internals(watcher).enqueueReconciliation(scope, async () => {
        calls.push('first');
        markStarted();
        await barrier;
      });
      await started;
      const second = internals(watcher).enqueueReconciliation(scope, async () => {
        calls.push('second');
      });
      const third = internals(watcher).enqueueReconciliation(scope, async () => {
        calls.push('third');
      });
      release();
      await Promise.all([first, second, third]);

      deepEqual(calls, ['first', 'third']);
    });

    it('should remove a relative child that shares its root basename', async () => {
      await mkdir(dpath('foo/foo'), { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(context.currentDir);
      try {
        const watcher = cwatch('foo', { ignoreInitial: true });
        await waitForWatcher(watcher);
        const spy = createSpy<EmitArgs, void>();
        watcher.on(EV.UNLINK_DIR, spy);

        await delay(100);
        await rmr(sp.join('foo', 'foo'));
        await waitFor([[spy, 1, [sp.join('foo', 'foo')]]]);
        ok(calledWith(spy, [sp.join('foo', 'foo')]));
        await watcher.close();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should retain backend ownership while publishing ADD', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const filePath = dpath('throttled-add.txt');
      await write(filePath, 'value');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        { usePolling: true, pollingInterval: 25, atomic: false },
        scheduler
      );
      WATCHERS.push(watcher);
      const closer = internals(watcher).handler.handleFile(
        filePath,
        await lstat(filePath),
        false,
        true
      );

      equal(typeof closer, 'function');
      equal(internals(watcher).directoryEntry(context.currentDir).has(sp.basename(filePath)), true);
      ok(scheduler.activeCount >= 1);
      internals(watcher).addPathCloser(filePath, closer!);
      await watcher.close();
      equal(scheduler.activeCount, 0);
    });

    it('should keep rapid add-unlink-recreate events truthful with and without atomic mode', async () => {
      await mkdir(context.currentDir, { recursive: true });
      for (const atomic of [false, true]) {
        const watcher = new chokidar.FSWatcher({ atomic });
        WATCHERS.push(watcher);
        const filePath = dpath(`rapid-final-${atomic}.txt`);
        await write(filePath, 'first');
        internals(watcher).directoryEntry(context.currentDir).add(sp.basename(filePath));
        internals(watcher).directoryEntry(dpath(`ownership-${atomic}`));
        const allSpy = createSpy<FSWatcherEventMap['all'], void>();
        watcher.on(EV.ALL, allSpy);

        await unlink(filePath);
        internals(watcher).removePath(context.currentDir, sp.basename(filePath), false);
        await write(filePath, 'second');
        internals(watcher).handler.handleFile(filePath, await lstat(filePath), false, false);

        if (atomic) {
          equal(getCallsWith(allSpy, [EV.UNLINK, filePath]).length, 0);
          equal(getCallsWith(allSpy, [EV.ADD, filePath]).length, 0);
          equal(getCallsWith(allSpy, [EV.CHANGE, filePath]).length, 1);
        } else {
          equal(getCallsWith(allSpy, [EV.UNLINK, filePath]).length, 1);
          equal(getCallsWith(allSpy, [EV.ADD, filePath]).length, 1);
          equal(getCallsWith(allSpy, [EV.CHANGE, filePath]).length, 0);
        }
      }
    });
  });

  describe('recursive native reconciliation', () => {
    it('should collapse one native write burst and retain a later write', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const file = dpath('recursive-write-burst.txt');
      await write(file, 'initial');
      const scheduler = new VirtualScheduler();
      const watcher = new chokidar.FSWatcher(
        { backend: 'native-recursive', atomic: false },
        scheduler
      );
      WATCHERS.push(watcher);
      const root = sp.resolve(context.currentDir);
      const helper = internals(watcher).createHelper(root);
      helper.recursiveRoot = root;
      internals(watcher).directoryEntry(root).add(sp.basename(file));
      internals(watcher).recordObserved(file, await lstat(file), 'add', undefined, true);
      internals(watcher).tree.clearInitialCreates(root);
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.CHANGE, spy);
      const trigger = (sequence: number) => ({
        kind: 'native' as const,
        resource: root as BackendResourceKey,
        rawEvent: 'change' as const,
        relativePath: sp.basename(file),
        sequence,
        observedAt: scheduler.now(),
      });

      await write(file, 'one phase');
      await internals(watcher).handler.reconcileNativeTrigger(root, helper, trigger(1));
      await write(file, 'one write, final phase');
      await internals(watcher).handler.reconcileNativeTrigger(root, helper, trigger(2));
      scheduler.advanceBy(50);
      equal(spy.callCount, 1);

      await write(file, 'a distinct later write');
      await internals(watcher).handler.reconcileNativeTrigger(root, helper, trigger(3));
      equal(spy.callCount, 2);
    });

    it('should ignore a recursive invalidation whose stat fact is unchanged', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const file = dpath('recursive-unchanged.txt');
      await write(file, 'unchanged');
      const watcher = new chokidar.FSWatcher({ backend: 'native-recursive', atomic: false });
      WATCHERS.push(watcher);
      const root = sp.resolve(context.currentDir);
      const helper = internals(watcher).createHelper(root);
      helper.recursiveRoot = root;
      internals(watcher).directoryEntry(root).add(sp.basename(file));
      internals(watcher).recordObserved(file, await lstat(file), 'add', undefined, true);
      internals(watcher).tree.clearInitialCreates(root);
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.CHANGE, spy);

      await internals(watcher).handler.reconcileNativeTrigger(root, helper, {
        kind: 'native',
        resource: root as BackendResourceKey,
        rawEvent: 'change',
        relativePath: sp.basename(file),
        sequence: 1,
        observedAt: Date.now(),
      });

      equal(spy.callCount, 0);
    });

    it('should serialize out-of-order rename and change reconciliation for one root', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const root = sp.resolve(context.currentDir);
      const resource = root as BackendResourceKey;
      const renameTrigger = {
        kind: 'native' as const,
        resource,
        rawEvent: 'rename' as const,
        relativePath: 'renamed.txt',
        sequence: 1,
        observedAt: Date.now(),
      };
      const changeTrigger = {
        ...renameTrigger,
        rawEvent: 'change' as const,
        relativePath: 'changed.txt',
        sequence: 2,
      };
      const commits: string[] = [];
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = internals(watcher).handler.reconcileBackendTrigger(
        root,
        true,
        renameTrigger,
        async () => {
          await barrier;
          commits.push('rename');
        }
      );
      const second = internals(watcher).handler.reconcileBackendTrigger(
        root,
        true,
        changeTrigger,
        async () => {
          commits.push('change');
        }
      );

      await delay();
      deepEqual(commits, []);
      release();
      await Promise.all([first, second]);
      deepEqual(commits, ['rename', 'change']);
    });

    it('should not coalesce directory and exact-file scopes for one candidate', async () => {
      const watcher = new chokidar.FSWatcher();
      WATCHERS.push(watcher);
      const file = dpath('scope-change.txt');
      const resource = sp.resolve(context.currentDir) as BackendResourceKey;
      const commits: string[] = [];
      const directoryTrigger = {
        kind: 'native' as const,
        resource,
        rawEvent: 'change' as const,
        relativePath: sp.basename(file),
        sequence: 1,
        observedAt: Date.now(),
      };
      const fileTrigger = {
        ...directoryTrigger,
        resource: sp.resolve(file) as BackendResourceKey,
        relativePath: null,
        sequence: 2,
      };

      const directory = internals(watcher).handler.reconcileBackendTrigger(
        context.currentDir,
        true,
        directoryTrigger,
        () => {
          commits.push('directory');
        }
      );
      const exact = internals(watcher).handler.reconcileBackendTrigger(
        file,
        false,
        fileTrigger,
        () => {
          commits.push('file');
        }
      );
      await Promise.all([directory, exact]);

      deepEqual(commits.sort(), ['directory', 'file']);
    });

    it('should reconcile a null filename from the logical root', async () => {
      await mkdir(context.currentDir, { recursive: true });
      const missing = dpath('missing-after-null.txt');
      await write(missing, 'present');
      const watcher = new chokidar.FSWatcher({ atomic: false });
      WATCHERS.push(watcher);
      internals(watcher).directoryEntry(context.currentDir).add(sp.basename(missing));
      const helper = internals(watcher).createHelper(context.currentDir);
      helper.recursiveRoot = context.currentDir;
      await unlink(missing);
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.UNLINK, spy);

      await internals(watcher).handler.reconcileNativeTrigger(context.currentDir, helper, {
        kind: 'native',
        resource: sp.resolve(context.currentDir) as BackendResourceKey,
        rawEvent: 'rename',
        relativePath: null,
        sequence: 1,
        observedAt: Date.now(),
      });

      ok(calledWith(spy, [missing]));
    });

    it('should purge a missing subtree from a descendant-only recursive invalidation', async () => {
      const root = sp.resolve(context.currentDir);
      const outer = dpath('subdir');
      const removed = dpath('subdir/subdir2');
      const descendant = dpath('subdir/subdir2/subdir3');
      await mkdir(descendant, { recursive: true });
      const watcher = new chokidar.FSWatcher({ backend: 'native-recursive', atomic: false });
      WATCHERS.push(watcher);
      const helper = internals(watcher).createHelper(root);
      helper.recursiveRoot = root;
      internals(watcher).directoryEntry(root).add(sp.basename(outer));
      internals(watcher).directoryEntry(outer).add(sp.basename(removed));
      internals(watcher).directoryEntry(removed).add(sp.basename(descendant));
      internals(watcher).directoryEntry(descendant);
      const spy = createSpy<EmitArgs, void>();
      watcher.on(EV.UNLINK_DIR, spy);

      await rmr(removed);
      await internals(watcher).handler.reconcileNativeTrigger(root, helper, {
        kind: 'native',
        resource: root as BackendResourceKey,
        rawEvent: 'rename',
        relativePath: sp.relative(root, descendant),
        sequence: 1,
        observedAt: Date.now(),
      });

      equal(spy.callCount, 2);
      ok(calledWith(spy, [descendant]));
      ok(calledWith(spy, [removed]));
    });

    if (!isIBMi) {
      it('should preserve relative presentation paths in recursive mode', async () => {
        const relativeRoot = sp.relative(process.cwd(), context.currentDir);
        const watcher = cwatch(relativeRoot, {
          backend: 'native-recursive',
          ignoreInitial: true,
          atomic: false,
        });
        await waitForWatcher(watcher);
        const addSpy = createSpy<EmitArgs, void>();
        watcher.on(EV.ADD, addSpy);
        const absoluteFile = dpath('relative-recursive.txt');
        const presentedFile = sp.join(relativeRoot, 'relative-recursive.txt');

        await write(absoluteFile, 'relative');
        await waitFor([[addSpy, 1, [presentedFile]]]);
        equal(getCallsWith(addSpy, [presentedFile]).length, 1);
      });

      if (canUseRecursiveWatch) {
        it('should match the normalized per-directory trace in recursive mode', async () => {
          const captureTrace = async (name: string, backend: 'native' | 'native-recursive') => {
            const root = dpath(name);
            await mkdir(root, { recursive: true });
            const watcher = cwatch(root, {
              backend,
              ignoreInitial: true,
              atomic: false,
            });
            await waitForWatcher(watcher);
            const spy = createSpy<FSWatcherEventMap['all'], void>();
            const rawSpy = createSpy<FSWatcherEventMap['raw'], void>();
            watcher.on(EV.ALL, spy);
            watcher.on(EV.RAW, rawSpy);
            const file = sp.join(root, 'trace.txt');
            const directory = sp.join(root, 'trace-dir');
            const child = sp.join(directory, 'inside.txt');
            const waitForStage = async (stage: string, event: EventName, path: string) => {
              try {
                await waitFor([[spy, 1, [event, path]]]);
              } catch {
                const normalized = spy.calls.map(
                  ([seenEvent, seenPath]) => `${seenEvent}:${sp.relative(root, seenPath)}`
                );
                const raw = rawSpy.calls.map(
                  ([rawEvent, rawPath]) => `${rawEvent}:${rawPath === null ? '<null>' : rawPath}`
                );
                throw new Error(
                  `timeout during ${name}/${stage}; events=${JSON.stringify(normalized)}; ` +
                    `raw=${JSON.stringify(raw)}`
                );
              }
            };

            await write(file, 'one');
            await waitForStage('add file', EV.ADD, file);
            await delay(60);
            await write(file, 'two-with-a-different-size');
            await waitForStage('change file', EV.CHANGE, file);
            await unlink(file);
            await waitForStage('unlink file', EV.UNLINK, file);
            await mkdir(directory);
            await waitForStage('add directory', EV.ADD_DIR, directory);
            await write(child, 'inside');
            await waitForStage('add child', EV.ADD, child);
            await unlink(child);
            await waitForStage('unlink child', EV.UNLINK, child);
            await rmr(directory);
            await waitForStage('unlink directory', EV.UNLINK_DIR, directory);
            await delay(100);

            const normalized = spy.calls.map(
              ([event, path]) => `${event}:${sp.relative(root, path)}`
            );
            const raw = rawSpy.calls.map(
              ([event, path]) => `${event}:${path === null ? '<null>' : path}`
            );
            await watcher.close();
            return { normalized, raw };
          };

          const perDirectory = await captureTrace('trace-per-directory', 'native');
          const recursive = await captureTrace('trace-recursive', 'native-recursive');
          const expected = [
            'add:trace.txt',
            'change:trace.txt',
            'unlink:trace.txt',
            'addDir:trace-dir',
            `add:${sp.join('trace-dir', 'inside.txt')}`,
            `unlink:${sp.join('trace-dir', 'inside.txt')}`,
            'unlinkDir:trace-dir',
          ];

          deepEqual(perDirectory.normalized, expected);
          deepEqual(
            recursive.normalized,
            expected,
            `recursive raw trace: ${JSON.stringify(recursive.raw)}`
          );
        });
      }

      it('should replay one recursive create during initial scan with raw emitted once', async () => {
        for (const ignoreInitial of [false, true]) {
          const root = dpath(`initial-replay-${ignoreInitial}`);
          await mkdir(root, { recursive: true });
          const watcher = new chokidar.FSWatcher({
            backend: 'native-recursive',
            ignoreInitial,
            atomic: false,
          });
          WATCHERS.push(watcher);
          const handler = internals(watcher).handler;
          let publish!: (event: 'rename' | 'change', filename: string | null) => void;
          backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
            publish = listener;
            return createFakeNativeWatcher();
          });
          const originalRead = handler.scanRecursiveTree.bind(handler);
          let readStarted!: () => void;
          let releaseRead!: () => void;
          const started = new Promise<void>((resolve) => {
            readStarted = resolve;
          });
          const barrier = new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
          let intercepted = false;
          handler.scanRecursiveTree = async (...args) => {
            if (!intercepted) {
              intercepted = true;
              readStarted();
              await barrier;
            }
            return originalRead(...args);
          };
          const rawSpy = createSpy<FSWatcherEventMap['raw'], void>();
          const addSpy = createSpy<EmitArgs, void>();
          const addDirSpy = createSpy<EmitArgs, void>();
          const changeSpy = createSpy<EmitArgs, void>();
          watcher
            .on(EV.RAW, rawSpy)
            .on(EV.ADD, addSpy)
            .on(EV.ADD_DIR, addDirSpy)
            .on(EV.CHANGE, changeSpy);

          try {
            const ready = waitForWatcher(watcher);
            watcher.add(root);
            await started;
            const created = sp.join(root, 'during.txt');
            await write(created, 'during scan');
            publish('rename', 'during.txt');
            const populated = sp.join(root, 'populated');
            const populatedChild = sp.join(populated, 'child.txt');
            await mkdir(populated);
            await write(populatedChild, 'populated during scan');
            publish('rename', 'populated');
            releaseRead();
            await ready;
            await internals(watcher).drainTasks();

            equal(rawSpy.callCount, 2);
            equal(getCallsWith(addSpy, [created]).length, 1);
            equal(getCallsWith(addDirSpy, [populated]).length, 1);
            equal(getCallsWith(addSpy, [populatedChild]).length, 1);
            equal(getCallsWith(changeSpy, [created]).length, 0);
          } finally {
            await watcher.close();
            backendTesting.setRecursiveWatchFactory();
          }
        }
      });

      it('should collapse recursive initialization buffer overflow to one root reconciliation', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
        });
        WATCHERS.push(watcher);
        const handler = internals(watcher).handler;
        let publish!: (event: 'rename' | 'change', filename: string | null) => void;
        backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
          publish = listener;
          return createFakeNativeWatcher();
        });
        const originalRead = handler.scanRecursiveTree.bind(handler);
        const originalReconcile = handler.reconcileNativeTrigger.bind(handler);
        let releaseRead = () => {};
        let readStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          readStarted = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        let intercepted = false;
        handler.scanRecursiveTree = async (...args) => {
          if (!intercepted) {
            intercepted = true;
            readStarted();
            await barrier;
          }
          return originalRead(...args);
        };
        const reconciled: Array<{ relativePath: string | null; sequence: number }> = [];
        handler.reconcileNativeTrigger = async (...args) => {
          reconciled.push({ relativePath: args[2].relativePath, sequence: args[2].sequence });
          return originalReconcile(...args);
        };

        try {
          const ready = waitForWatcher(watcher);
          watcher.add(context.currentDir);
          await started;
          for (let index = 0; index <= 1024; index++) {
            publish('change', `overflow-${index}.txt`);
          }
          releaseRead();
          await ready;

          deepEqual(reconciled, [{ relativePath: null, sequence: Number.MAX_SAFE_INTEGER }]);
        } finally {
          releaseRead();
          await watcher.close();
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should classify only unsupported recursive construction errors as fallback', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const first = new chokidar.FSWatcher({ backend: 'native-recursive', ignoreInitial: true });
        const second = new chokidar.FSWatcher({ backend: 'native-recursive', ignoreInitial: true });
        WATCHERS.push(first, second);
        let attempts = 0;
        backendTesting.setRecursiveWatchFactory(() => {
          attempts += 1;
          throw Object.assign(new Error('recursive unsupported'), {
            code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
          });
        });
        try {
          const firstReady = waitForWatcher(first);
          first.add(context.currentDir);
          await firstReady;
          const secondReady = waitForWatcher(second);
          second.add(context.currentDir);
          await secondReady;

          equal(attempts, 1);
          equal(internals(first).recursiveRoots.size, 0);
          equal(internals(second).recursiveRoots.size, 0);
          const addSpy = createSpy<EmitArgs, void>();
          first.on(EV.ADD, addSpy);
          const added = dpath('unsupported-fallback.txt');
          await write(added, 'fallback');
          await waitFor([[addSpy, 1, [added]]]);
        } finally {
          await Promise.all([first.close(), second.close()]);
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should report operational recursive construction errors', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
        });
        WATCHERS.push(watcher);
        backendTesting.setRecursiveWatchFactory(() => {
          throw Object.assign(new Error('recursive permission denied'), { code: 'EACCES' });
        });
        try {
          const errorSpy = createSpy<[unknown], void>();
          watcher.on(EV.ERROR, errorSpy);
          const ready = new Promise<void>((resolve) => watcher.once(EV.READY, resolve));
          watcher.add(context.currentDir);
          await Promise.all([ready, waitFor([errorSpy])]);

          equal(errorSpy.callCount, 1);
          equal(internals(watcher).recursiveRoots.size, 0);
        } finally {
          await watcher.close();
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should recompute recursive persistence across shared subscribers', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const first = new chokidar.FSWatcher({
          backend: 'native-recursive',
          persistent: false,
          ignoreInitial: true,
        });
        const second = new chokidar.FSWatcher({
          backend: 'native-recursive',
          persistent: true,
          ignoreInitial: true,
        });
        WATCHERS.push(first, second);
        let refs = 0;
        let unrefs = 0;
        backendTesting.setRecursiveWatchFactory((path, options, listener) => {
          const resource = nativeWatch(path, options, listener);
          const ref = resource.ref.bind(resource);
          const unref = resource.unref.bind(resource);
          resource.ref = () => {
            refs += 1;
            return ref();
          };
          resource.unref = () => {
            unrefs += 1;
            return unref();
          };
          return resource;
        });
        try {
          const firstReady = waitForWatcher(first);
          first.add(context.currentDir);
          await firstReady;
          if (internals(first).recursiveRoots.size === 0) return;
          equal(unrefs, 1);

          const secondReady = waitForWatcher(second);
          second.add(context.currentDir);
          await secondReady;
          equal(refs, 1);

          await second.close();
          equal(unrefs, 2);
        } finally {
          await Promise.all([first.close(), second.close()]);
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should reconcile populated directories moved into and removed from the tree', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const source = sp.join(FIXTURES_PATH, `move-source-${context.testId}`);
        await mkdir(source, { recursive: true });
        await write(sp.join(source, 'inside.txt'), 'inside');
        const destination = dpath('moved');
        const inside = sp.join(destination, 'inside.txt');
        const watcher = cwatch(context.currentDir, {
          backend: 'native-recursive',
          ignoreInitial: true,
          atomic: false,
        });
        await waitForWatcher(watcher);
        const spy = createSpy<FSWatcherEventMap['all'], void>();
        watcher.on(EV.ALL, spy);

        await rename(source, destination);
        await waitFor([
          [spy, 1, [EV.ADD_DIR, destination]],
          [spy, 1, [EV.ADD, inside]],
        ]);
        await rmr(destination);
        await waitFor([
          [spy, 1, [EV.UNLINK, inside]],
          [spy, 1, [EV.UNLINK_DIR, destination]],
        ]);

        equal(getCallsWith(spy, [EV.ADD, inside]).length, 1);
      });

      it('should preserve distinct logical projections for symlink aliases', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const target = sp.join(FIXTURES_PATH, `alias-target-${context.testId}`);
        const firstAlias = dpath('first-alias');
        const secondAlias = dpath('second-alias');
        await mkdir(target, { recursive: true });
        await symlink(target, firstAlias, isWindows ? 'junction' : undefined);
        await symlink(target, secondAlias, isWindows ? 'junction' : undefined);
        const watcher = cwatch(context.currentDir, {
          backend: 'native-recursive',
          followSymlinks: true,
          ignoreInitial: true,
          atomic: false,
        });

        try {
          await waitForWatcher(watcher);
          const addSpy = createSpy<EmitArgs, void>();
          watcher.on(EV.ADD, addSpy);
          const targetFile = sp.join(target, 'aliased.txt');
          const firstProjection = sp.join(firstAlias, 'aliased.txt');
          const secondProjection = sp.join(secondAlias, 'aliased.txt');

          await write(targetFile, 'aliased');
          await waitFor([
            [addSpy, 1, [firstProjection]],
            [addSpy, 1, [secondProjection]],
          ]);

          equal(getCallsWith(addSpy, [firstProjection]).length, 1);
          equal(getCallsWith(addSpy, [secondProjection]).length, 1);
        } finally {
          await watcher.close();
          await rmr(target);
        }
      });

      it('should replace a followed symlink projection when its target changes', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const firstTarget = sp.join(FIXTURES_PATH, `first-link-target-${context.testId}`);
        const secondTarget = sp.join(FIXTURES_PATH, `second-link-target-${context.testId}`);
        const link = dpath('replacement-link');
        const oldProjection = sp.join(link, 'old.txt');
        const newProjection = sp.join(link, 'new.txt');
        await mkdir(firstTarget, { recursive: true });
        await mkdir(secondTarget, { recursive: true });
        await write(sp.join(firstTarget, 'old.txt'), 'old');
        await write(sp.join(secondTarget, 'new.txt'), 'new');
        await symlink(firstTarget, link, isWindows ? 'junction' : undefined);
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          followSymlinks: true,
          ignoreInitial: true,
          atomic: false,
        });
        WATCHERS.push(watcher);
        const linkKey = internals(watcher).logicalKey(link);
        internals(watcher).directoryEntry(context.currentDir).add(sp.basename(link));
        internals(watcher).directoryEntry(link).add('old.txt');
        internals(watcher).symlinkPaths.set(linkKey, firstTarget);
        internals(watcher).recordObserved(link, await lstat(firstTarget), 'add', undefined, true);
        internals(watcher).tree.clearInitialCreates(context.currentDir);
        const allSpy = createSpy<FSWatcherEventMap['all'], void>();
        watcher.on(EV.ALL, allSpy);

        try {
          await rmr(link);
          await symlink(secondTarget, link, isWindows ? 'junction' : undefined);
          const helper = internals(watcher).createHelper(context.currentDir);
          helper.recursiveRoot = context.currentDir;
          await internals(watcher).handler.reconcileNativeTrigger(context.currentDir, helper, {
            kind: 'native',
            resource: sp.resolve(context.currentDir) as BackendResourceKey,
            rawEvent: 'rename',
            relativePath: sp.basename(link),
            sequence: 1,
            observedAt: Date.now(),
          });
          await internals(watcher).drainTasks();

          equal(getCallsWith(allSpy, [EV.UNLINK, oldProjection]).length, 1);
          equal(getCallsWith(allSpy, [EV.UNLINK_DIR, link]).length, 1);
          equal(getCallsWith(allSpy, [EV.ADD_DIR, link]).length, 1);
          equal(getCallsWith(allSpy, [EV.ADD, newProjection]).length, 1);
          equal(internals(watcher).directoryEntry(link).has('old.txt'), false);
          equal(internals(watcher).directoryEntry(link).has('new.txt'), true);
          equal(internals(watcher).symlinkPaths.get(linkKey), await realpath(secondTarget));
        } finally {
          await watcher.close();
          await Promise.all([rmr(firstTarget), rmr(secondTarget)]);
        }
      });

      it('should keep recursive create-delete-recreate state truthful', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
          atomic: false,
        });
        WATCHERS.push(watcher);
        let publish!: (event: 'rename' | 'change', filename: string | null) => void;
        backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
          publish = listener;
          return createFakeNativeWatcher();
        });
        const file = dpath('recursive-recreated.txt');
        const addSpy = createSpy<EmitArgs, void>();
        const unlinkSpy = createSpy<EmitArgs, void>();
        watcher.on(EV.ADD, addSpy).on(EV.UNLINK, unlinkSpy);

        try {
          const ready = waitForWatcher(watcher);
          watcher.add(context.currentDir);
          await ready;

          await write(file, 'first');
          publish('rename', sp.basename(file));
          await internals(watcher).drainTasks();
          await unlink(file);
          publish('rename', sp.basename(file));
          await internals(watcher).drainTasks();
          await write(file, 'second');
          publish('rename', sp.basename(file));
          await internals(watcher).drainTasks();

          equal(getCallsWith(addSpy, [file]).length, 2);
          equal(getCallsWith(unlinkSpy, [file]).length, 1);
          equal(internals(watcher).directoryEntry(context.currentDir).has(sp.basename(file)), true);
          equal(internals(watcher).observed.has(internals(watcher).logicalKey(file)), true);
          equal((await lstat(file)).isFile(), true);
        } finally {
          await watcher.close();
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should keep an exact-root recursive subscriber alive when another closes', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const first = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
        });
        const second = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
        });
        WATCHERS.push(first, second);
        const closeSpy = createSpy<[], void>();
        let factoryCalls = 0;
        let publish!: (event: 'rename' | 'change', filename: string | null) => void;
        backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
          factoryCalls += 1;
          publish = listener;
          const resource = createFakeNativeWatcher();
          const close = resource.close.bind(resource);
          resource.close = () => {
            closeSpy();
            close();
          };
          return resource;
        });

        try {
          const firstReady = waitForWatcher(first);
          first.add(context.currentDir);
          await firstReady;
          const secondReady = waitForWatcher(second);
          second.add(context.currentDir);
          await secondReady;
          equal(factoryCalls, 1);

          await first.close();
          equal(closeSpy.callCount, 0);
          const spy = createSpy<EmitArgs, void>();
          second.on(EV.ADD, spy);
          const file = dpath('still-watched.txt');
          await write(file, 'value');
          publish('rename', sp.basename(file));
          await internals(second).drainTasks();

          equal(getCallsWith(spy, [file]).length, 1);
        } finally {
          await Promise.allSettled([first.close(), second.close()]);
          equal(closeSpy.callCount, 1);
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should use one native handle for a wide recursive tree (#1385, #1452)', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const directoryCount = 64;
        const directories = Array.from({ length: directoryCount }, (_, index) =>
          dpath(`wide-${index}`)
        );
        await Promise.all(directories.map((directory) => mkdir(directory)));
        await Promise.all(
          directories.map((directory, index) =>
            write(sp.join(directory, `file-${index}.txt`), 'watched')
          )
        );
        let factoryCalls = 0;
        const closeSpy = createSpy<[], void>();
        backendTesting.setRecursiveWatchFactory(() => {
          factoryCalls += 1;
          const resource = createFakeNativeWatcher();
          const close = resource.close.bind(resource);
          resource.close = () => {
            closeSpy();
            close();
          };
          return resource;
        });
        const watcher = cwatch(context.currentDir, {
          backend: 'native-recursive',
          ignoreInitial: true,
        });

        try {
          await waitForWatcher(watcher);
          equal(watcher.options.backend, 'native-recursive');
          equal(factoryCalls, 1);
          equal(internals(watcher).recursiveRoots.size, 1);
          ok(Object.keys(watcher.getWatched()).length >= directoryCount + 1);
        } finally {
          await watcher.close();
          equal(closeSpy.callCount, 1);
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should transactionally fall back after a recursive handle fails', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = cwatch(context.currentDir, {
          backend: 'native-recursive',
          ignoreInitial: true,
          atomic: false,
        });
        await waitForWatcher(watcher);
        if (internals(watcher).recursiveRoots.size === 0) return;
        const errorSpy = createSpy<[unknown], void>();
        watcher.on(EV.ERROR, errorSpy);

        const simulated = Object.assign(new Error('simulated recursive failure'), {
          code: 'EIO',
        });
        equal(backendTesting.failRecursiveWatch(context.currentDir, simulated), true);
        await waitFor([errorSpy]);
        equal(internals(watcher).recursiveRoots.size, 0);

        const file = dpath('after-fallback.txt');
        const addSpy = createSpy<EmitArgs, void>();
        watcher.on(EV.ADD, addSpy);
        await write(file, 'after fallback');
        await waitFor([[addSpy, 1, [file]]]);
        equal(getCallsWith(addSpy, [file]).length, 1);
      });

      it('should close while buffered recursive triggers are replaying', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
          atomic: false,
        });
        WATCHERS.push(watcher);
        const handler = internals(watcher).handler;
        let publish!: (event: 'rename' | 'change', filename: string | null) => void;
        backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
          publish = listener;
          return createFakeNativeWatcher();
        });
        const originalRead = handler.scanRecursiveTree.bind(handler);
        const originalReconcile = handler.reconcileNativeTrigger.bind(handler);
        let releaseRead = () => {};
        let releaseReplay = () => {};
        let readStarted!: () => void;
        let replayStarted!: () => void;
        const readBarrier = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        const replayBarrier = new Promise<void>((resolve) => {
          releaseReplay = resolve;
        });
        const reading = new Promise<void>((resolve) => {
          readStarted = resolve;
        });
        const replaying = new Promise<void>((resolve) => {
          replayStarted = resolve;
        });
        let blockedRead = false;
        let blockedReplay = false;
        handler.scanRecursiveTree = async (...args) => {
          if (!blockedRead) {
            blockedRead = true;
            readStarted();
            await readBarrier;
          }
          return originalRead(...args);
        };
        handler.reconcileNativeTrigger = async (...args) => {
          if (!blockedReplay) {
            blockedReplay = true;
            replayStarted();
            await replayBarrier;
          }
          return originalReconcile(...args);
        };
        const allSpy = createSpy<FSWatcherEventMap['all'], void>();
        const readySpy = createSpy<[], void>();
        watcher.on(EV.ALL, allSpy).on(EV.READY, readySpy);

        try {
          watcher.add(context.currentDir);
          await reading;
          await write(dpath('during-replay.txt'), 'buffered');
          publish('rename', 'during-replay.txt');
          releaseRead();
          await replaying;
          const closing = watcher.close();
          releaseReplay();
          await closing;

          equal(internals(watcher).state, 'CLOSED');
          equal(internals(watcher).tasks.size, 0);
          equal(internals(watcher).recursiveRoots.size, 0);
          equal(allSpy.called, false);
          equal(readySpy.called, false);
        } finally {
          releaseRead();
          releaseReplay();
          await watcher.close();
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should close while recursive runtime fallback is being established', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          ignoreInitial: true,
        });
        WATCHERS.push(watcher);
        const handler = internals(watcher).handler;
        backendTesting.setRecursiveWatchFactory(() => createFakeNativeWatcher());
        let releaseFallback = () => {};
        try {
          const ready = waitForWatcher(watcher);
          watcher.add(context.currentDir);
          await ready;

          const originalDir = handler.handleDirectory.bind(handler);
          let fallbackStarted!: () => void;
          const fallback = new Promise<void>((resolve) => {
            fallbackStarted = resolve;
          });
          const barrier = new Promise<void>((resolve) => {
            releaseFallback = resolve;
          });
          let intercepted = false;
          handler.handleDirectory = async (...args) => {
            const helper = args[5];
            if (!intercepted && helper.recursiveDisabled) {
              intercepted = true;
              fallbackStarted();
              await barrier;
            }
            return originalDir(...args);
          };

          const failure = Object.assign(new Error('close during fallback'), { code: 'EIO' });
          equal(backendTesting.failRecursiveWatch(context.currentDir, failure), true);
          await fallback;
          const closing = watcher.close();
          releaseFallback();
          await closing;

          equal(internals(watcher).state, 'CLOSED');
          equal(internals(watcher).tasks.size, 0);
          equal(internals(watcher).recursiveRoots.size, 0);
          equal(internals(watcher).closers.size, 0);
        } finally {
          releaseFallback();
          await watcher.close();
          backendTesting.setRecursiveWatchFactory();
        }
      });

      it('should close a followed-symlink child subscription during closer handoff', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const target = sp.join(FIXTURES_PATH, `child-target-${context.testId}`);
        const link = dpath('child-link');
        await mkdir(target, { recursive: true });
        await write(sp.join(target, 'inside.txt'), 'inside');
        await symlink(target, link, isWindows ? 'junction' : undefined);
        const watcher = new chokidar.FSWatcher({
          backend: 'native-recursive',
          followSymlinks: true,
          ignoreInitial: true,
        });
        WATCHERS.push(watcher);
        const handler = internals(watcher).handler;
        backendTesting.setRecursiveWatchFactory(() => createFakeNativeWatcher());
        const originalDir = handler.handleDirectory.bind(handler);
        let releaseChild = () => {};
        let childCreated!: () => void;
        const childHandoff = new Promise<void>((resolve) => {
          childCreated = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          releaseChild = resolve;
        });
        let intercepted = false;
        handler.handleDirectory = async (...args) => {
          const closer = await originalDir(...args);
          if (!intercepted && sp.resolve(args[0]) === sp.resolve(link)) {
            intercepted = true;
            childCreated();
            await barrier;
          }
          return closer;
        };

        try {
          watcher.add(context.currentDir);
          await childHandoff;
          const closing = watcher.close();
          releaseChild();
          await closing;

          equal(internals(watcher).state, 'CLOSED');
          equal(internals(watcher).tasks.size, 0);
          equal(internals(watcher).closers.size, 0);
          equal(internals(watcher).recursiveRoots.size, 0);
        } finally {
          releaseChild();
          await watcher.close();
          backendTesting.setRecursiveWatchFactory();
          await rmr(target);
        }
      });

      it('should close a recursive subscription created during an initial scan race', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({ backend: 'native-recursive' });
        WATCHERS.push(watcher);
        const handler = internals(watcher).handler;
        const originalRead = handler.scanRecursiveTree.bind(handler);
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        let intercepted = false;
        handler.scanRecursiveTree = async (...args) => {
          if (!intercepted) {
            intercepted = true;
            await barrier;
          }
          return originalRead(...args);
        };

        watcher.add(context.currentDir);
        await delay();
        const closed = watcher.close();
        release();
        await closed;

        equal(internals(watcher).state, 'CLOSED');
        equal(internals(watcher).tasks.size, 0);
      });

      it('should close a recursive subscription unwatched during its initial scan', async () => {
        await mkdir(context.currentDir, { recursive: true });
        const watcher = new chokidar.FSWatcher({ backend: 'native-recursive' });
        WATCHERS.push(watcher);
        const handler = internals(watcher).handler;
        const originalRead = handler.scanRecursiveTree.bind(handler);
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        let intercepted = false;
        handler.scanRecursiveTree = async (...args) => {
          if (!intercepted) {
            intercepted = true;
            await barrier;
          }
          return originalRead(...args);
        };

        watcher.add(context.currentDir);
        await delay();
        watcher.unwatch(context.currentDir);
        release();
        await internals(watcher).drainTasks();

        equal(internals(watcher).recursiveRoots.size, 0);
        equal(
          internals(watcher).closers.has(internals(watcher).logicalKey(context.currentDir)),
          false
        );
      });
    }
  });
}
