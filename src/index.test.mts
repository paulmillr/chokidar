import { afterEach, beforeEach, describe, it } from 'micro-should';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { exec as cexec } from 'node:child_process';
import { Stats } from 'node:fs';
import {
  appendFile,
  mkdir as mkd,
  readFile as read,
  rename,
  rm,
  symlink,
  unlink,
  writeFile as write,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as sp from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';
import { match as sinonmatch, type SinonSpy, spy as sspy } from 'sinon';
import upath from 'upath';

import { EVENTS as EV, isIBMi, isMacos, isWindows } from './handler.js';
import * as chokidar from './index.js';

const TEST_TIMEOUT = 32000; // ms
const imetaurl = import.meta.url;
const FIXTURES_PATH = sp.join(tmpdir(), 'chokidar-' + time());
const WATCHERS: chokidar.FSWatcher[] = [];
let testId = 0;
let currentDir: string;
let USE_SLOW_DELAY: number | undefined;

function time() {
  return Date.now().toString();
}
const exec = promisify(cexec);
function rmr(dir: string) {
  return rm(dir, { recursive: true, force: true });
}
function mkdir(dir: string, opts = {}) {
  const mode = 0o755; // read + execute
  return mkd(dir, { mode: mode, ...opts });
}

// spyOnReady
const aspy = (
  watcher: chokidar.FSWatcher,
  eventName: string,
  spy: SinonSpy | null = null,
  noStat: boolean = false
): Promise<SinonSpy> => {
  if (typeof eventName !== 'string') {
    throw new TypeError('aspy: eventName must be a String');
  }
  if (spy == null) spy = sspy();
  return new Promise((resolve, reject) => {
    const handler = noStat
      ? eventName === EV.ALL
        ? (event: string, path: string) => spy(event, path)
        : (path: string) => spy(path)
      : spy;
    const timeout = setTimeout(() => {
      reject(new Error('timeout'));
    }, TEST_TIMEOUT);
    watcher.on(EV.ERROR, (...args) => {
      clearTimeout(timeout);
      reject(...args);
    });
    watcher.on(EV.READY, () => {
      clearTimeout(timeout);
      resolve(spy);
    });
    watcher.on(eventName as keyof chokidar.FSWatcherEventMap, handler);
  });
};

const waitForWatcher = (watcher: chokidar.FSWatcher) => {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout'));
    }, TEST_TIMEOUT);
    watcher.on(EV.ERROR, (...args) => {
      clearTimeout(timeout);
      reject(...args);
    });
    watcher.on(EV.READY, (...args) => {
      clearTimeout(timeout);
      resolve(...args);
    });
  });
};

async function delay(delayTime?: number) {
  return new Promise<void>((resolve) => {
    const timer = delayTime || USE_SLOW_DELAY || 20;
    setTimeout(resolve, timer);
  });
}

// dir path
function dpath(subPath: string) {
  const subd = (testId && testId.toString()) || '';
  return sp.join(FIXTURES_PATH, subd, subPath);
}
// glob path
function gpath(subPath: string) {
  const subd = (testId && testId.toString()) || '';
  return upath.join(FIXTURES_PATH, subd, subPath);
}
currentDir = dpath('');

function cwatch(
  path: Parameters<typeof chokidar.watch>[0] = currentDir,
  opts?: chokidar.ChokidarOptions
) {
  const wt = chokidar.watch(path, opts);
  WATCHERS.push(wt);
  return wt;
}

function waitFor(spies: Array<SinonSpy | [SinonSpy, number]>) {
  if (spies.length === 0) throw new Error('need at least 1 spy');
  return new Promise<void>((resolve, reject) => {
    let checkTimer: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => {
      clearTimeout(checkTimer);
      reject(new Error('timeout waitFor, passed ms: ' + TEST_TIMEOUT));
    }, TEST_TIMEOUT);
    const isSpyReady = (spy: SinonSpy | [SinonSpy, number]): boolean => {
      if (Array.isArray(spy)) {
        return spy[0].callCount >= spy[1];
      }
      return spy.callCount >= 1;
    };
    const checkSpiesReady = () => {
      clearTimeout(checkTimer);
      if (spies.every(isSpyReady)) {
        clearTimeout(timeout);
        resolve();
      } else {
        checkTimer = setTimeout(checkSpiesReady, 20);
      }
    };
    checkSpiesReady();
  });
}

function waitForEvents(watcher: chokidar.FSWatcher, count: number) {
  return new Promise<string[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout waitForEvents, passed ms: ' + TEST_TIMEOUT));
    }, TEST_TIMEOUT);
    const events: string[] = [];
    const handler = (event: string, path: string) => {
      events.push(`[ALL] ${event}: ${path}`);

      if (events.length === count) {
        watcher.off('all', handler);
        clearTimeout(timeout);
        resolve(events);
      }
    };

    watcher.on('all', handler);
  });
}

const runTests = (baseopts: chokidar.ChokidarOptions) => {
  let macosFswatch = isMacos && !baseopts.usePolling;
  let win32Polling = isWindows && baseopts.usePolling;
  let options: chokidar.ChokidarOptions;
  USE_SLOW_DELAY = macosFswatch ? 100 : undefined;
  baseopts.persistent = true;

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach((key) => {
      (options as Record<PropertyKey, unknown>)[key] =
        baseopts[key as keyof chokidar.ChokidarOptions];
    });
  });

  describe('watch a directory', () => {
    let readySpy: SinonSpy;
    let rawSpy: SinonSpy;
    let watcher: chokidar.FSWatcher;
    let watcher2: chokidar.FSWatcher;
    beforeEach(async () => {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = sspy(function readySpy() {});
      rawSpy = sspy(function rawSpy() {});
      watcher = cwatch(currentDir, options).on(EV.READY, readySpy).on(EV.RAW, rawSpy);
      await waitForWatcher(watcher);
    });
    afterEach(async () => {
      await waitFor([readySpy]);
      await watcher.close();
      equal(readySpy.calledOnce, true);
    });
    it('should produce an instance of chokidar.FSWatcher', () => {
      ok(watcher instanceof chokidar.FSWatcher);
    });
    it('should expose public API methods', () => {
      ok(typeof watcher.on === 'function');
      ok(typeof watcher.emit === 'function');
      ok(typeof watcher.add === 'function');
      ok(typeof watcher.close === 'function');
      ok(typeof watcher.getWatched === 'function');
    });
    it('should emit `add` event when file was added', async () => {
      const testPath = dpath('add.txt');
      const spy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      watcher.on(EV.ADD, spy);
      await delay();
      await write(testPath, time());
      await waitFor([spy]);
      equal(spy.calledOnce, true);
      ok(spy.calledWith(testPath));
      ok(spy.args[0][1]); // stats
      ok(rawSpy.called);
    });
    it('should emit nine `add` events when nine files were added in one directory', async () => {
      const paths: string[] = [];
      for (let i = 1; i <= 9; i++) {
        paths.push(dpath(`add${i}.txt`));
      }

      const spy = sspy();
      watcher.on(EV.ADD, (path) => {
        spy(path);
      });

      await write(paths[0], time());
      await write(paths[1], time());
      await write(paths[2], time());
      await write(paths[3], time());
      await write(paths[4], time());
      await delay(100);

      await write(paths[5], time());
      await write(paths[6], time());

      await delay(150);
      await write(paths[7], time());
      await write(paths[8], time());

      await waitFor([[spy, 4]]);

      await delay(1000);
      await waitFor([[spy, 9]]);
      paths.forEach((path) => {
        ok(spy.calledWith(path));
      });
    });
    it('should emit thirtythree `add` events when thirtythree files were added in nine directories', async () => {
      await watcher.close();

      const test1Path = dpath('add1.txt');
      const testb1Path = dpath('b/add1.txt');
      const testc1Path = dpath('c/add1.txt');
      const testd1Path = dpath('d/add1.txt');
      const teste1Path = dpath('e/add1.txt');
      const testf1Path = dpath('f/add1.txt');
      const testg1Path = dpath('g/add1.txt');
      const testh1Path = dpath('h/add1.txt');
      const testi1Path = dpath('i/add1.txt');
      const test2Path = dpath('add2.txt');
      const testb2Path = dpath('b/add2.txt');
      const testc2Path = dpath('c/add2.txt');
      const test3Path = dpath('add3.txt');
      const testb3Path = dpath('b/add3.txt');
      const testc3Path = dpath('c/add3.txt');
      const test4Path = dpath('add4.txt');
      const testb4Path = dpath('b/add4.txt');
      const testc4Path = dpath('c/add4.txt');
      const test5Path = dpath('add5.txt');
      const testb5Path = dpath('b/add5.txt');
      const testc5Path = dpath('c/add5.txt');
      const test6Path = dpath('add6.txt');
      const testb6Path = dpath('b/add6.txt');
      const testc6Path = dpath('c/add6.txt');
      const test7Path = dpath('add7.txt');
      const testb7Path = dpath('b/add7.txt');
      const testc7Path = dpath('c/add7.txt');
      const test8Path = dpath('add8.txt');
      const testb8Path = dpath('b/add8.txt');
      const testc8Path = dpath('c/add8.txt');
      const test9Path = dpath('add9.txt');
      const testb9Path = dpath('b/add9.txt');
      const testc9Path = dpath('c/add9.txt');
      await mkdir(dpath('b'));
      await mkdir(dpath('c'));
      await mkdir(dpath('d'));
      await mkdir(dpath('e'));
      await mkdir(dpath('f'));
      await mkdir(dpath('g'));
      await mkdir(dpath('h'));
      await mkdir(dpath('i'));

      await delay();

      readySpy.resetHistory();
      watcher2 = cwatch(currentDir, options).on(EV.READY, readySpy).on(EV.RAW, rawSpy);
      const spy = await aspy(watcher2, EV.ADD, null, true);

      const filesToWrite = [
        test1Path,
        test2Path,
        test3Path,
        test4Path,
        test5Path,
        test6Path,
        test7Path,
        test8Path,
        test9Path,
        testb1Path,
        testb2Path,
        testb3Path,
        testb4Path,
        testb5Path,
        testb6Path,
        testb7Path,
        testb8Path,
        testb9Path,
        testc1Path,
        testc2Path,
        testc3Path,
        testc4Path,
        testc5Path,
        testc6Path,
        testc7Path,
        testc8Path,
        testc9Path,
        testd1Path,
        teste1Path,
        testf1Path,
        testg1Path,
        testh1Path,
        testi1Path,
      ];

      let currentCallCount = 0;

      for (const fileToWrite of filesToWrite) {
        await write(fileToWrite, time());
        await waitFor([[spy, ++currentCallCount]]);
      }

      ok(spy.calledWith(test1Path));
      ok(spy.calledWith(test2Path));
      ok(spy.calledWith(test3Path));
      ok(spy.calledWith(test4Path));
      ok(spy.calledWith(test5Path));
      ok(spy.calledWith(test6Path));
      ok(spy.calledWith(test7Path));
      ok(spy.calledWith(test8Path));
      ok(spy.calledWith(test9Path));
      ok(spy.calledWith(testb1Path));
      ok(spy.calledWith(testb2Path));
      ok(spy.calledWith(testb3Path));
      ok(spy.calledWith(testb4Path));
      ok(spy.calledWith(testb5Path));
      ok(spy.calledWith(testb6Path));
      ok(spy.calledWith(testb7Path));
      ok(spy.calledWith(testb8Path));
      ok(spy.calledWith(testb9Path));
      ok(spy.calledWith(testc1Path));
      ok(spy.calledWith(testc2Path));
      ok(spy.calledWith(testc3Path));
      ok(spy.calledWith(testc4Path));
      ok(spy.calledWith(testc5Path));
      ok(spy.calledWith(testc6Path));
      ok(spy.calledWith(testc7Path));
      ok(spy.calledWith(testc8Path));
      ok(spy.calledWith(testc9Path));
      ok(spy.calledWith(testd1Path));
      ok(spy.calledWith(teste1Path));
      ok(spy.calledWith(testf1Path));
      ok(spy.calledWith(testg1Path));
      ok(spy.calledWith(testh1Path));
      ok(spy.calledWith(testi1Path));
    });
    it('should emit `addDir` event when directory was added', async () => {
      const testDir = dpath('subdir');
      const spy = sspy<(p: string, s?: Stats) => void>(function addDirSpy() {});
      watcher.on(EV.ADD_DIR, spy);
      equal(spy.called, false);
      await mkdir(testDir);
      await waitFor([spy]);
      equal(spy.calledOnce, true);
      ok(spy.calledWith(testDir));
      ok(spy.args[0][1]); // stats
      ok(rawSpy.called);
    });
    it('should emit `change` event when file was changed', async () => {
      const testPath = dpath('change.txt');
      const spy = sspy<(p: string, s?: Stats) => void>(function changeSpy() {});
      watcher.on(EV.CHANGE, spy);
      equal(spy.called, false);
      await write(testPath, time());
      await waitFor([spy]);
      ok(spy.calledWith(testPath));
      ok(spy.args[0][1]); // stats
      ok(rawSpy.called);
      equal(spy.calledOnce, true);
    });
    it('should emit `unlink` event when file was removed', async () => {
      const testPath = dpath('unlink.txt');
      const spy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
      watcher.on(EV.UNLINK, spy);
      equal(spy.called, false);
      await unlink(testPath);
      await waitFor([spy]);
      ok(spy.calledWith(testPath));
      equal(!spy.args[0][1], true); // no stats
      ok(rawSpy.called);
      equal(spy.calledOnce, true);
    });
    it('should emit `unlinkDir` event when a directory was removed', async () => {
      const testDir = dpath('subdir');
      const spy = sspy<(p: string, s?: Stats) => void>(function unlinkDirSpy() {});

      await mkdir(testDir);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, spy);

      await rmr(testDir);
      await waitFor([spy]);
      ok(spy.calledWith(testDir));
      equal(!spy.args[0][1], true); // no stats
      ok(rawSpy.called);
      equal(spy.calledOnce, true);
    });
    it('should emit two `unlinkDir` event when two nested directories were removed', async () => {
      const testDir = dpath('subdir');
      const testDir2 = dpath('subdir/subdir2');
      const testDir3 = dpath('subdir/subdir2/subdir3');
      const spy = sspy<(p: string, s?: Stats) => void>(function unlinkDirSpy() {});

      await mkdir(testDir);
      await mkdir(testDir2);
      await mkdir(testDir3);
      await delay(300);

      watcher.on(EV.UNLINK_DIR, spy);

      await rmr(testDir2);
      await waitFor([[spy, 2]]);

      ok(spy.calledWith(testDir2));
      ok(spy.calledWith(testDir3));
      equal(!spy.args[0][1], true); // no stats
      ok(rawSpy.called);
      equal(spy.calledTwice, true);
    });
    it('should emit `unlink` and `add` events when a file is renamed', async () => {
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlink() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function add() {});
      const testPath = dpath('change.txt');
      const newPath = dpath('moved.txt');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy);
      equal(unlinkSpy.called, false);
      equal(addSpy.called, false);

      await delay();
      await rename(testPath, newPath);
      await waitFor([unlinkSpy, addSpy]);
      ok(unlinkSpy.calledWith(testPath));
      equal(!unlinkSpy.args[0][1], true); // no stats
      equal(addSpy.calledOnce, true);
      ok(addSpy.calledWith(newPath));
      ok(addSpy.args[0][1]); // stats
      ok(rawSpy.called);
      if (!macosFswatch) equal(unlinkSpy.calledOnce, true);
    });
    it('should emit `add`, not `change`, when previously deleted file is re-added', async () => {
      if (isWindows) {
        console.warn('test skipped');
        return true;
      }
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlink() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function add() {});
      const changeSpy = sspy<(p: string, s?: Stats) => void>(function change() {});
      const testPath = dpath('add.txt');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy).on(EV.CHANGE, changeSpy);
      await write(testPath, 'hello');
      await waitFor([[addSpy.withArgs(testPath), 1]]);
      equal(unlinkSpy.called, false);
      equal(changeSpy.called, false);
      await unlink(testPath);
      await waitFor([unlinkSpy.withArgs(testPath)]);
      ok(unlinkSpy.calledWith(testPath));

      await delay(100);
      await write(testPath, time());
      await waitFor([[addSpy.withArgs(testPath), 2]]);
      ok(addSpy.calledWith(testPath));
      equal(changeSpy.called, false);
      equal(addSpy.callCount, 2);
    });
    it('should not emit `unlink` for previously moved files', async () => {
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlink() {});
      const testPath = dpath('change.txt');
      const newPath1 = dpath('moved.txt');
      const newPath2 = dpath('moved-again.txt');
      watcher.on(EV.UNLINK, unlinkSpy);
      await rename(testPath, newPath1);

      await delay(300);
      await rename(newPath1, newPath2);
      await waitFor([unlinkSpy.withArgs(newPath1)]);
      equal(unlinkSpy.withArgs(testPath).calledOnce, true);
      equal(unlinkSpy.withArgs(newPath1).calledOnce, true);
      equal(unlinkSpy.withArgs(newPath2).called, false);
    });
    it('should survive ENOENT for missing subdirectories', async () => {
      const testDir = dpath('notadir');
      watcher.add(testDir);
    });
    it('should notice when a file appears in a new directory', async () => {
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const spy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      watcher.on(EV.ADD, spy);
      equal(spy.called, false);
      await mkdir(testDir);
      await write(testPath, time());
      await waitFor([spy]);
      equal(spy.calledOnce, true);
      ok(spy.calledWith(testPath));
      ok(spy.args[0][1]); // stats
      ok(rawSpy.called);
    });
    it('should watch removed and re-added directories', async () => {
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      const parentPath = dpath('subdir2');
      const subPath = dpath('subdir2/subsub');
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD_DIR, addSpy);
      await mkdir(parentPath);

      await delay(win32Polling ? 900 : 300);
      await rmr(parentPath);
      await waitFor([unlinkSpy.withArgs(parentPath)]);
      ok(unlinkSpy.calledWith(parentPath));
      await mkdir(parentPath);

      await delay(win32Polling ? 2200 : 1200);
      await mkdir(subPath);
      await waitFor([[addSpy, 3]]);
      ok(addSpy.calledWith(parentPath));
      ok(addSpy.calledWith(subPath));
    });
    it('should emit `unlinkDir` and `add` when dir is replaced by file', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      const testPath = dpath('dirFile');
      await mkdir(testPath);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD, addSpy);

      await rmr(testPath);
      await waitFor([unlinkSpy]);

      await write(testPath, 'file content');
      await waitFor([addSpy]);

      ok(unlinkSpy.calledWith(testPath));
      ok(addSpy.calledWith(testPath));
    });
    it('should emit `unlink` and `addDir` when file is replaced by dir', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      const testPath = dpath('fileDir');
      await write(testPath, 'file content');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD_DIR, addSpy);

      await delay(300);
      await unlink(testPath);
      await delay(300);
      await mkdir(testPath);

      await waitFor([addSpy, unlinkSpy]);
      ok(unlinkSpy.calledWith(testPath));
      ok(addSpy.calledWith(testPath));
    });
  });
  describe('watch individual files', () => {
    it('should emit `ready` when three files were added', async () => {
      const readySpy = sspy(function readySpy() {});
      const watcher = cwatch(currentDir, options).on(EV.READY, readySpy);
      const path1 = dpath('add1.txt');
      const path2 = dpath('add2.txt');
      const path3 = dpath('add3.txt');

      watcher.add(path1);
      watcher.add(path2);
      watcher.add(path3);

      await waitForWatcher(watcher);
      // callCount is 1 on macOS, 4 on Ubuntu
      ok(readySpy.callCount >= 1);
    });
    it('should detect changes', async () => {
      const testPath = dpath('change.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.CHANGE);
      await write(testPath, time());
      await waitFor([spy]);
      ok(spy.alwaysCalledWith(testPath));
    });
    it('should detect unlinks', async () => {
      const testPath = dpath('unlink.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.UNLINK);

      await delay();
      await unlink(testPath);
      await waitFor([spy]);
      ok(spy.calledWith(testPath));
    });
    it('should detect unlink and re-add', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      const testPath = dpath('unlink.txt');
      const watcher = cwatch([testPath], options).on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      await delay();
      await unlink(testPath);
      await waitFor([unlinkSpy]);
      ok(unlinkSpy.calledWith(testPath));

      await delay();
      await write(testPath, 're-added');
      await waitFor([addSpy]);
      ok(addSpy.calledWith(testPath));
    });

    it('should ignore unwatched siblings', async () => {
      const testPath = dpath('add.txt');
      const siblingPath = dpath('change.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(siblingPath, time());
      await write(testPath, time());
      await waitFor([spy]);
      ok(spy.alwaysCalledWith(EV.ADD, testPath));
    });

    it('should detect safe-edit', async () => {
      const testPath = dpath('change.txt');
      const safePath = dpath('tmp.txt');
      await write(testPath, time());
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(safePath, time());
      await rename(safePath, testPath);
      await delay(300);
      await write(safePath, time());
      await rename(safePath, testPath);
      await delay(300);
      await write(safePath, time());
      await rename(safePath, testPath);
      await delay(300);
      await waitFor([spy]);
      equal(spy.withArgs(EV.CHANGE, testPath).calledThrice, true);
    });

    // PR 682 is failing.
    describe.skip('Skipping gh-682: should detect unlink', () => {
      it('should detect unlink while watching a non-existent second file in another directory', async () => {
        const testPath = dpath('unlink.txt');
        const otherDirPath = dpath('other-dir');
        const otherPath = dpath('other-dir/other.txt');
        await mkdir(otherDirPath);
        const watcher = cwatch([testPath, otherPath], options);
        // intentionally for this test don't write write(otherPath, 'other');
        const spy = await aspy(watcher, EV.UNLINK);

        await delay();
        await unlink(testPath);
        await waitFor([spy]);
        ok(spy.calledWith(testPath));
      });
      it('should detect unlink and re-add while watching a second file', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
        const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        await write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        ok(unlinkSpy.calledWith(testPath));

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        ok(addSpy.calledWith(testPath));
      });
      it('should detect unlink and re-add while watching a non-existent second file in another directory', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
        const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherDirPath = dpath('other-dir');
        const otherPath = dpath('other-dir/other.txt');
        await mkdir(otherDirPath);
        // intentionally for this test don't write write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        ok(unlinkSpy.calledWith(testPath));

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        ok(addSpy.calledWith(testPath));
      });
      it('should detect unlink and re-add while watching a non-existent second file in the same directory', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
        const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        // intentionally for this test don't write write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        ok(unlinkSpy.calledWith(testPath));

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        ok(addSpy.calledWith(testPath));
      });
      it('should detect two unlinks and one re-add', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
        const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        await write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unlink(otherPath);

        await delay();
        await unlink(testPath);
        await waitFor([[unlinkSpy, 2]]);

        await delay();
        ok(unlinkSpy.calledWith(otherPath));
        ok(unlinkSpy.calledWith(testPath));

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        ok(addSpy.calledWith(testPath));
      });
      it('should detect unlink and re-add while watching a second file and a non-existent third file', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sspy<(p: string, s?: Stats) => void>(function unlinkSpy() {});
        const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        const other2Path = dpath('other2.txt');
        await write(otherPath, 'other');
        // intentionally for this test don't write write(other2Path, 'other2');
        const watcher = cwatch([testPath, otherPath, other2Path], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);
        await delay();
        await unlink(testPath);

        await waitFor([unlinkSpy]);
        await delay();
        ok(unlinkSpy.calledWith(testPath));

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        ok(addSpy.calledWith(testPath));
      });
    });
  });
  describe('renamed directory', () => {
    it('should emit `add` for a file in a renamed directory', async () => {
      options.ignoreInitial = true;
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const renamedDir = dpath('subdir-renamed');
      const expectedPath = sp.join(renamedDir, 'add.txt');
      await mkdir(testDir);
      await write(testPath, time());
      const watcher = cwatch(currentDir, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay(1000);
      await rename(testDir, renamedDir);
      await waitFor([spy.withArgs(expectedPath)]);
      ok(spy.calledWith(expectedPath));
    });
  });
  describe('watch non-existent paths', () => {
    it('should watch non-existent file and detect add', async () => {
      const testPath = dpath('add.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay();
      await write(testPath, time());
      await waitFor([spy]);
      ok(spy.calledWith(testPath));
    });
    it('should watch non-existent dir and detect addDir/add', async () => {
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const watcher = cwatch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);
      equal(spy.called, false);

      await delay();
      await mkdir(testDir);
      await waitFor([spy.withArgs(EV.ADD_DIR)]);
      await write(testPath, 'hello');
      await waitFor([spy.withArgs(EV.ADD)]);
      ok(spy.calledWith(EV.ADD_DIR, testDir));
      ok(spy.calledWith(EV.ADD, testPath));
    });
  });
  describe('not watch glob patterns', () => {
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = dpath('nota[glob].txt');
      await write(filePath, 'b');
      await delay();
      const spy = await aspy(cwatch(currentDir, options), EV.ALL);
      ok(spy.calledWith(EV.ADD, filePath));

      await delay();
      await write(filePath, time());
      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      ok(spy.calledWith(EV.CHANGE, filePath));
    });
    it('should treat glob-like directory names as literal directory names when globbing is disabled', async () => {
      const filePath = dpath('nota[glob]/a.txt');
      const watchPath = dpath('nota[glob]');
      const testDir = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/b.txt');
      const matchingFile2 = dpath('notal');
      await mkdir(testDir);
      await write(filePath, 'b');
      await mkdir(matchingDir);
      await write(matchingFile, 'c');
      await write(matchingFile2, 'd');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      ok(spy.calledWith(EV.ADD, filePath));
      equal(spy.calledWith(EV.ADD_DIR, matchingDir), false);
      equal(spy.calledWith(EV.ADD, matchingFile), false);
      equal(spy.calledWith(EV.ADD, matchingFile2), false);
      await delay();
      await write(filePath, time());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      ok(spy.calledWith(EV.CHANGE, filePath));
    });
    it('should treat glob-like filenames as literal filenames', async () => {
      const filePath = dpath('nota[glob]');
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/a.txt');
      const matchingFile2 = dpath('notal');
      await write(filePath, 'b');
      await mkdir(matchingDir);
      await write(matchingFile, 'c');
      await write(matchingFile2, 'd');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      ok(spy.calledWith(EV.ADD, filePath));
      equal(spy.calledWith(EV.ADD_DIR, matchingDir), false);
      equal(spy.calledWith(EV.ADD, matchingFile), false);
      equal(spy.calledWith(EV.ADD, matchingFile2), false);
      await delay();
      await write(filePath, time());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      ok(spy.calledWith(EV.CHANGE, filePath));
    });
  });
  describe('watch symlinks', () => {
    if (isWindows) return true;
    let linkedDir: string;
    beforeEach(async () => {
      linkedDir = sp.resolve(currentDir, '..', `${testId}-link`);
      await symlink(currentDir, linkedDir, isWindows ? 'dir' : undefined);
      await mkdir(dpath('subdir'));
      await write(dpath('subdir/add.txt'), 'b');
    });
    afterEach(async () => {
      await unlink(linkedDir);
    });

    it('should watch symlinked dirs', async () => {
      const dirSpy = sspy<(p: string, s?: Stats) => void>(function dirSpy() {});
      const addSpy = sspy<(p: string, s?: Stats) => void>(function addSpy() {});
      const watcher = cwatch(linkedDir, options).on(EV.ADD_DIR, dirSpy).on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      ok(dirSpy.calledWith(linkedDir));
      ok(addSpy.calledWith(sp.join(linkedDir, 'change.txt')));
      ok(addSpy.calledWith(sp.join(linkedDir, 'unlink.txt')));
    });
    it('should watch symlinked files', async () => {
      const changePath = dpath('change.txt');
      const linkPath = dpath('link.txt');
      await symlink(changePath, linkPath);
      const watcher = cwatch(linkPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, time());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      ok(spy.calledWith(EV.ADD, linkPath));
      ok(spy.calledWith(EV.CHANGE, linkPath));
    });
    it('should follow symlinked files within a normal dir', async () => {
      const changePath = dpath('change.txt');
      const linkPath = dpath('subdir/link.txt');
      await symlink(changePath, linkPath);
      const watcher = cwatch(dpath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, time());
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      ok(spy.calledWith(EV.ADD, linkPath));
      ok(spy.calledWith(EV.CHANGE, linkPath));
    });
    it('should watch paths with a symlinked parent', async () => {
      const testDir = sp.join(linkedDir, 'subdir');
      const testFile = sp.join(testDir, 'add.txt');
      const watcher = cwatch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);

      ok(spy.calledWith(EV.ADD_DIR, testDir));
      ok(spy.calledWith(EV.ADD, testFile));
      await write(dpath('subdir/add.txt'), time());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      ok(spy.calledWith(EV.CHANGE, testFile));
    });
    it('should not recurse indefinitely on circular symlinks', async () => {
      await symlink(currentDir, dpath('subdir/circular'), isWindows ? 'dir' : undefined);
      await new Promise<void>((resolve, reject) => {
        const watcher = cwatch(currentDir, options);
        watcher.on(EV.ERROR, () => {
          resolve();
        });
        watcher.on(EV.READY, () => {
          reject('The watcher becomes ready, although he watches a circular symlink.');
        });
      });
    });
    it('should recognize changes following symlinked dirs', async () => {
      const linkedFilePath = sp.join(linkedDir, 'change.txt');
      const watcher = cwatch(linkedDir, options);
      const spy = await aspy(watcher, EV.CHANGE);
      const wa = spy.withArgs(linkedFilePath);
      await write(dpath('change.txt'), time());
      await waitFor([wa]);
      ok(spy.calledWith(linkedFilePath));
    });
    it('should follow newly created symlinks', async () => {
      options.ignoreInitial = true;
      const watcher = cwatch(currentDir, options);
      const spy = await aspy(watcher, EV.ALL);
      await delay();
      await symlink(dpath('subdir'), dpath('link'), isWindows ? 'dir' : undefined);
      await waitFor([
        spy.withArgs(EV.ADD, dpath('link/add.txt')),
        spy.withArgs(EV.ADD_DIR, dpath('link')),
      ]);
      ok(spy.calledWith(EV.ADD_DIR, dpath('link')));
      ok(spy.calledWith(EV.ADD, dpath('link/add.txt')));
    });
    it('should watch symlinks as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const watcher = cwatch(linkedDir, options);
      const spy = await aspy(watcher, EV.ALL);
      equal(spy.calledWith(EV.ADD_DIR), false);
      ok(spy.calledWith(EV.ADD, linkedDir));
      equal(spy.calledOnce, true);
    });
    it('should survive ENOENT for missing symlinks when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const targetDir = dpath('subdir/nonexistent');
      await mkdir(targetDir);
      await symlink(targetDir, dpath('subdir/broken'), isWindows ? 'dir' : undefined);
      await rmr(targetDir);
      await delay();

      const watcher = cwatch(dpath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      equal(spy.calledTwice, true);
      ok(spy.calledWith(EV.ADD_DIR, dpath('subdir')));
      ok(spy.calledWith(EV.ADD, dpath('subdir/add.txt')));
    });
    it('should watch symlinks within a watched dir as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      // Create symlink in linkPath
      const linkPath = dpath('link');
      await symlink(dpath('subdir'), linkPath);
      const spy = await aspy(cwatch(currentDir, options), EV.ALL);
      await delay(300);
      setTimeout(
        async () => {
          await write(dpath('subdir/add.txt'), time());
          await unlink(linkPath);
          await symlink(dpath('subdir/add.txt'), linkPath);
        },
        options.usePolling ? 1200 : 300
      );

      await delay(300);
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      equal(spy.calledWith(EV.ADD_DIR, linkPath), false);
      equal(spy.calledWith(EV.ADD, dpath('link/add.txt')), false);
      ok(spy.calledWith(EV.ADD, linkPath));
      ok(spy.calledWith(EV.CHANGE, linkPath));
    });
    it('should not reuse watcher when following a symlink to elsewhere', async () => {
      const linkedPath = dpath('outside');
      const linkedFilePath = sp.join(linkedPath, 'text.txt');
      const linkPath = dpath('subdir/subsub');
      await mkdir(linkedPath);
      await write(linkedFilePath, 'b');
      await symlink(linkedPath, linkPath);
      const watcher2 = cwatch(dpath('subdir'), options);
      await waitForWatcher(watcher2);

      await delay(options.usePolling ? 900 : undefined);
      const watchedPath = dpath('subdir/subsub/text.txt');
      const watcher = cwatch(watchedPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(linkedFilePath, time());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      ok(spy.calledWith(EV.CHANGE, watchedPath));
    });
    it('should emit ready event even when broken symlinks are encountered', async () => {
      const targetDir = dpath('subdir/nonexistent');
      await mkdir(targetDir);
      await symlink(targetDir, dpath('subdir/broken'), isWindows ? 'dir' : undefined);
      await rmr(targetDir);
      const readySpy = sspy(function readySpy() {});
      const watcher = cwatch(dpath('subdir'), options).on(EV.READY, readySpy);
      await waitForWatcher(watcher);
      equal(readySpy.calledOnce, true);
    });
  });
  describe('watch arrays of paths/globs', () => {
    it('should watch all paths in an array', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await mkdir(testDir);
      const watcher = cwatch([testDir, testPath], options);
      const spy = await aspy(watcher, EV.ALL);
      ok(spy.calledWith(EV.ADD, testPath));
      ok(spy.calledWith(EV.ADD_DIR, testDir));
      equal(spy.calledWith(EV.ADD, dpath('unlink.txt')), false);
      await write(testPath, time());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      ok(spy.calledWith(EV.CHANGE, testPath));
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await mkdir(testDir);
      const watcher = cwatch([[testDir], [testPath]] as unknown as string[], options);
      const spy = await aspy(watcher, EV.ALL);
      ok(spy.calledWith(EV.ADD, testPath));
      ok(spy.calledWith(EV.ADD_DIR, testDir));
      equal(spy.calledWith(EV.ADD, dpath('unlink.txt')), false);
      await write(testPath, time());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      ok(spy.calledWith(EV.CHANGE, testPath));
    });
    it('should throw if provided any non-string paths', () => {
      throws(cwatch.bind(null, [[currentDir], /notastring/] as unknown as string[], options), {
        name: /^TypeError$/,
        message: /non-string/i,
      });
    });
  });
  describe('watch options', () => {
    describe('ignoreInitial', () => {
      describe('false', () => {
        beforeEach(() => {
          options.ignoreInitial = false;
        });
        it('should emit `add` events for preexisting files', async () => {
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD);
          equal(spy.calledTwice, true);
        });
        it('should emit `addDir` event for watched dir', async () => {
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          equal(spy.calledOnce, true);
          ok(spy.calledWith(currentDir));
        });
        it('should emit `addDir` events for preexisting dirs', async () => {
          await mkdir(dpath('subdir'));
          await mkdir(dpath('subdir/subsub'));
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          ok(spy.calledWith(currentDir));
          ok(spy.calledWith(dpath('subdir')));
          ok(spy.calledWith(dpath('subdir/subsub')));
          equal(spy.calledThrice, true);
        });
      });
      describe('true', () => {
        beforeEach(() => {
          options.ignoreInitial = true;
        });
        it('should ignore initial add events', async () => {
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD);
          await delay();
          equal(spy.called, false);
        });
        it('should ignore add events on a subsequent .add()', async () => {
          const watcher = cwatch(dpath('subdir'), options);
          const spy = await aspy(watcher, EV.ADD);
          watcher.add(currentDir);
          await delay(1000);
          equal(spy.called, false);
        });
        it('should notice when a file appears in an empty directory', async () => {
          const testDir = dpath('subdir');
          const testPath = dpath('subdir/add.txt');
          const spy = await aspy(cwatch(currentDir, options), EV.ADD);
          equal(spy.called, false);
          await mkdir(testDir);
          await write(testPath, time());
          await waitFor([spy]);
          equal(spy.calledOnce, true);
          ok(spy.calledWith(testPath));
        });
        it('should emit a change on a preexisting file as a change', async () => {
          const testPath = dpath('change.txt');
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          equal(spy.called, false);
          await write(testPath, time());
          await waitFor([spy.withArgs(EV.CHANGE, testPath)]);
          ok(spy.calledWith(EV.CHANGE, testPath));
          equal(spy.calledWith(EV.ADD), false);
        });
        it('should not emit for preexisting dirs when depth is 0', async () => {
          options.depth = 0;
          const testPath = dpath('add.txt');
          await mkdir(dpath('subdir'));

          await delay(200);
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          await write(testPath, time());
          await waitFor([spy]);

          await delay(200);
          ok(spy.calledWith(EV.ADD, testPath));
          equal(spy.calledWith(EV.ADD_DIR), false);
        });
      });
    });
    describe('ignored', () => {
      it('should check ignore after stating', async () => {
        options.ignored = (path, stats) => {
          if (upath.normalizeSafe(path) === upath.normalizeSafe(testDir) || !stats) return false;
          return stats.isDirectory();
        };
        const testDir = dpath('subdir');
        await mkdir(testDir);
        await write(sp.join(testDir, 'add.txt'), '');
        await mkdir(sp.join(testDir, 'subsub'));
        await write(sp.join(testDir, 'subsub', 'ab.txt'), '');
        const watcher = cwatch(testDir, options);
        const spy = await aspy(watcher, EV.ADD);
        equal(spy.calledOnce, true);
        ok(spy.calledWith(sp.join(testDir, 'add.txt')));
      });
      it('should not choke on an ignored watch path', async () => {
        options.ignored = () => {
          return true;
        };
        await waitForWatcher(cwatch(currentDir, options));
      });
      it('should ignore the contents of ignored dirs', async () => {
        const testDir = dpath('subdir');
        const testFile = sp.join(testDir, 'add.txt');
        options.ignored = testDir;
        await mkdir(testDir);
        await write(testFile, 'b');
        const watcher = cwatch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);

        await delay();
        await write(testFile, time());

        await delay(300);
        equal(spy.calledWith(EV.ADD_DIR, testDir), false);
        equal(spy.calledWith(EV.ADD, testFile), false);
        equal(spy.calledWith(EV.CHANGE, testFile), false);
      });
      it('should allow regex/fn ignores', async () => {
        options.cwd = currentDir;
        options.ignored = /add/;

        await write(dpath('add.txt'), 'b');
        const watcher = cwatch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);

        await delay();
        await write(dpath('add.txt'), time());
        await write(dpath('change.txt'), time());

        await waitFor([spy.withArgs(EV.CHANGE, 'change.txt')]);
        equal(spy.calledWith(EV.ADD, 'add.txt'), false);
        equal(spy.calledWith(EV.CHANGE, 'add.txt'), false);
        ok(spy.calledWith(EV.ADD, 'change.txt'));
        ok(spy.calledWith(EV.CHANGE, 'change.txt'));
      });
    });
    describe('depth', () => {
      beforeEach(async () => {
        await mkdir(dpath('subdir'));
        await write(dpath('subdir/add.txt'), 'b');
        await delay();
        await mkdir(dpath('subdir/subsub'));
        await write(dpath('subdir/subsub/ab.txt'), 'b');
        await delay();
      });
      it('should not recurse if depth is 0', async () => {
        options.depth = 0;
        const watcher = cwatch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);
        await write(dpath('subdir/add.txt'), time());
        await waitFor([[spy, 4]]);
        ok(spy.calledWith(EV.ADD_DIR, currentDir));
        ok(spy.calledWith(EV.ADD_DIR, dpath('subdir')));
        ok(spy.calledWith(EV.ADD, dpath('change.txt')));
        ok(spy.calledWith(EV.ADD, dpath('unlink.txt')));
        equal(spy.calledWith(EV.CHANGE), false);
        if (!macosFswatch) equal(spy.callCount, 4);
      });
      it('should recurse to specified depth', async () => {
        options.depth = 1;
        const addPath = dpath('subdir/add.txt');
        const changePath = dpath('change.txt');
        const ignoredPath = dpath('subdir/subsub/ab.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await delay();
        await write(dpath('change.txt'), time());
        await write(addPath, time());
        await write(ignoredPath, time());
        await waitFor([spy.withArgs(EV.CHANGE, addPath), spy.withArgs(EV.CHANGE, changePath)]);
        ok(spy.calledWith(EV.ADD_DIR, dpath('subdir/subsub')));
        ok(spy.calledWith(EV.CHANGE, changePath));
        ok(spy.calledWith(EV.CHANGE, addPath));
        equal(spy.calledWith(EV.ADD, ignoredPath), false);
        equal(spy.calledWith(EV.CHANGE, ignoredPath), false);
        if (!macosFswatch) equal(spy.callCount, 8);
      });
      it('should respect depth setting when following symlinks', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        await symlink(dpath('subdir'), dpath('link'), isWindows ? 'dir' : undefined);
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        ok(spy.calledWith(EV.ADD_DIR, dpath('link')));
        ok(spy.calledWith(EV.ADD_DIR, dpath('link/subsub')));
        ok(spy.calledWith(EV.ADD, dpath('link/add.txt')));
        equal(spy.calledWith(EV.ADD, dpath('link/subsub/ab.txt')), false);
      });
      it('should respect depth setting when following a new symlink', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        const linkPath = dpath('link');
        const dirPath = dpath('link/subsub');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await symlink(dpath('subdir'), linkPath, isWindows ? 'dir' : undefined);
        await waitFor([[spy, 3], spy.withArgs(EV.ADD_DIR, dirPath)]);
        ok(spy.calledWith(EV.ADD_DIR, linkPath));
        ok(spy.calledWith(EV.ADD_DIR, dirPath));
        ok(spy.calledWith(EV.ADD, dpath('link/add.txt')));
        equal(spy.calledThrice, true);
      });
      it('should correctly handle dir events when depth is 0', async () => {
        options.depth = 0;
        const subdir2 = dpath('subdir2');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        const addSpy = spy.withArgs(EV.ADD_DIR);
        const unlinkSpy = spy.withArgs(EV.UNLINK_DIR);
        ok(spy.calledWith(EV.ADD_DIR, currentDir));
        ok(spy.calledWith(EV.ADD_DIR, dpath('subdir')));
        await mkdir(subdir2);
        await waitFor([[addSpy, 3]]);
        equal(addSpy.calledThrice, true);

        await rmr(subdir2);
        await waitFor([unlinkSpy]);
        await delay();
        ok(unlinkSpy.calledWith(EV.UNLINK_DIR, subdir2));
        equal(unlinkSpy.calledOnce, true);
      });
    });
    describe('atomic', () => {
      beforeEach(() => {
        options.atomic = true;
        options.ignoreInitial = true;
      });
      it('should ignore vim/emacs/Sublime swapfiles', async () => {
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(dpath('.change.txt.swp'), 'a'); // vim
        await write(dpath('add.txt~'), 'a'); // vim/emacs
        await write(dpath('.subl5f4.tmp'), 'a'); // sublime
        await delay(300);
        await write(dpath('.change.txt.swp'), 'c');
        await write(dpath('add.txt~'), 'c');
        await write(dpath('.subl5f4.tmp'), 'c');
        await delay(300);
        await unlink(dpath('.change.txt.swp'));
        await unlink(dpath('add.txt~'));
        await unlink(dpath('.subl5f4.tmp'));
        await delay(300);
        equal(spy.called, false);
      });
      it('should ignore stale tilde files', async () => {
        options.ignoreInitial = false;
        await write(dpath('old.txt~'), 'a');
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        equal(spy.calledWith(dpath('old.txt')), false);
        equal(spy.calledWith(dpath('old.txt~')), false);
      });
    });
    describe('cwd', () => {
      it('should emit relative paths based on cwd', async () => {
        options.cwd = currentDir;
        const watcher = cwatch('.', options);
        const spy = await aspy(watcher, EV.ALL);
        await unlink(dpath('unlink.txt'));
        await write(dpath('change.txt'), time());
        await waitFor([spy.withArgs(EV.UNLINK)]);
        ok(spy.calledWith(EV.ADD, 'change.txt'));
        ok(spy.calledWith(EV.ADD, 'unlink.txt'));
        ok(spy.calledWith(EV.CHANGE, 'change.txt'));
        ok(spy.calledWith(EV.UNLINK, 'unlink.txt'));
      });
      it('should emit `addDir` with alwaysStat for renamed directory', async () => {
        options.cwd = currentDir;
        options.alwaysStat = true;
        options.ignoreInitial = true;
        const spy = sspy();
        const testDir = dpath('subdir');
        const renamedDir = dpath('subdir-renamed');

        await mkdir(testDir);
        const watcher = cwatch('.', options);

        await new Promise<void>((resolve) => {
          setTimeout(async () => {
            watcher.on(EV.ADD_DIR, spy);
            await rename(testDir, renamedDir);
            resolve();
          }, 1000);
        });

        await waitFor([spy]);
        equal(spy.calledOnce, true);
        ok(spy.calledWith('subdir-renamed'));
        ok(spy.args[0][1]); // stats
      });
      it('should allow separate watchers to have different cwds', async () => {
        options.cwd = currentDir;
        const options2: chokidar.ChokidarOptions = {};
        Object.keys(options).forEach((key) => {
          (options2 as Record<PropertyKey, unknown>)[key] =
            options[key as keyof chokidar.ChokidarOptions];
        });
        options2.cwd = dpath('subdir');
        const watcher = cwatch(gpath('.'), options);
        const watcherEvents = waitForEvents(watcher, 5);
        const spy1 = await aspy(watcher, EV.ALL);

        await delay();
        const watcher2 = cwatch(currentDir, options2);
        const watcher2Events = waitForEvents(watcher2, 5);
        const spy2 = await aspy(watcher2, EV.ALL);

        await unlink(dpath('unlink.txt'));
        await write(dpath('change.txt'), time());
        await Promise.all([watcherEvents, watcher2Events]);
        ok(spy1.calledWith(EV.CHANGE, 'change.txt'));
        ok(spy1.calledWith(EV.UNLINK, 'unlink.txt'));
        ok(spy2.calledWith(EV.ADD, sp.join('..', 'change.txt')));
        ok(spy2.calledWith(EV.ADD, sp.join('..', 'unlink.txt')));
        ok(spy2.calledWith(EV.CHANGE, sp.join('..', 'change.txt')));
        ok(spy2.calledWith(EV.UNLINK, sp.join('..', 'unlink.txt')));
      });
      it('should ignore files even with cwd', async () => {
        options.cwd = currentDir;
        options.ignored = ['ignored-option.txt', 'ignored.txt'];
        const files = ['.'];
        await write(dpath('change.txt'), 'hello');
        await write(dpath('ignored.txt'), 'ignored');
        await write(dpath('ignored-option.txt'), 'ignored option');
        const watcher = cwatch(files, options);

        const spy = await aspy(watcher, EV.ALL);
        await write(dpath('ignored.txt'), time());
        await write(dpath('ignored-option.txt'), time());
        await unlink(dpath('ignored.txt'));
        await unlink(dpath('ignored-option.txt'));
        await delay();
        await write(dpath('change.txt'), EV.CHANGE);
        await waitFor([spy.withArgs(EV.CHANGE, 'change.txt')]);
        ok(spy.calledWith(EV.ADD, 'change.txt'));
        equal(spy.calledWith(EV.ADD, 'ignored.txt'), false);
        equal(spy.calledWith(EV.ADD, 'ignored-option.txt'), false);
        equal(spy.calledWith(EV.CHANGE, 'ignored.txt'), false);
        equal(spy.calledWith(EV.CHANGE, 'ignored-option.txt'), false);
        equal(spy.calledWith(EV.UNLINK, 'ignored.txt'), false);
        equal(spy.calledWith(EV.UNLINK, 'ignored-option.txt'), false);
        ok(spy.calledWith(EV.CHANGE, 'change.txt'));
      });
    });
    describe('ignorePermissionErrors', () => {
      let filePath: string;
      beforeEach(async () => {
        filePath = dpath('add.txt');
        const PERM_R = 0o200;
        await write(filePath, 'b', { mode: PERM_R });
        await delay();
      });
      describe('false', () => {
        beforeEach(() => {
          options.ignorePermissionErrors = false;
          // chokidar_watch();
        });
        it('should not watch files without read permissions', async () => {
          if (isWindows) return true;
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          equal(spy.calledWith(EV.ADD, filePath), false);
          await write(filePath, time());

          await delay(200);
          equal(spy.calledWith(EV.CHANGE, filePath), false);
        });
      });
      describe('true', () => {
        beforeEach(() => {
          options.ignorePermissionErrors = true;
        });
        it('should watch unreadable files if possible', async () => {
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          ok(spy.calledWith(EV.ADD, filePath));
        });
        it('should not choke on non-existent files', async () => {
          const watcher = cwatch(dpath('nope.txt'), options);
          await waitForWatcher(watcher);
        });
      });
    });
    describe('awaitWriteFinish', () => {
      beforeEach(() => {
        options.awaitWriteFinish = { stabilityThreshold: 500 };
        options.ignoreInitial = true;
      });
      it('should use default options if none given', () => {
        options.awaitWriteFinish = true;
        const watcher = cwatch(currentDir, options);
        equal((watcher.options.awaitWriteFinish as chokidar.AWF).pollInterval, 100);
        equal((watcher.options.awaitWriteFinish as chokidar.AWF).stabilityThreshold, 2000);
      });
      it('should not emit add event before a file is fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(200);
        equal(spy.calledWith(EV.ADD), false);
      });
      it('should wait for the file to be fully written before emitting the add event', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');

        await delay(300);
        equal(spy.called, false);
        await waitFor([spy]);
        ok(spy.calledWith(EV.ADD, testPath));
      });
      it('should emit with the final stats', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello ');

        await delay(300);
        appendFile(testPath, 'world!');

        await waitFor([spy]);
        ok(spy.calledWith(EV.ADD, testPath));
        equal(spy.args[0][2].size, 12);
      });
      it('should not emit change event while a file has not been fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(100);
        await write(testPath, 'edit');
        await delay(200);
        equal(spy.calledWith(EV.CHANGE, testPath), false);
      });
      it('should not emit change event before an existing file is fully updated', async () => {
        const testPath = dpath('change.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(300);
        equal(spy.calledWith(EV.CHANGE, testPath), false);
      });
      it('should wait for an existing file to be fully updated before emitting the change event', async () => {
        const testPath = dpath('change.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        write(testPath, 'hello');

        await delay(300);
        equal(spy.called, false);
        await waitFor([spy]);
        ok(spy.calledWith(EV.CHANGE, testPath));
      });
      it('should emit change event after the file is fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await delay();
        await write(testPath, 'hello');

        await waitFor([spy]);
        ok(spy.calledWith(EV.ADD, testPath));
        await write(testPath, 'edit');
        await waitFor([spy.withArgs(EV.CHANGE)]);
        ok(spy.calledWith(EV.CHANGE, testPath));
      });
      it('should not raise any event for a file that was deleted before fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(400);
        await unlink(testPath);
        await delay(400);
        equal(spy.calledWith(sinonmatch.string, testPath), false);
      });
      it('should be compatible with the cwd option', async () => {
        const testPath = dpath('subdir/add.txt');
        const filename = sp.basename(testPath);
        options.cwd = sp.dirname(testPath);
        await mkdir(options.cwd);

        await delay(200);
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);

        await delay(400);
        await write(testPath, 'hello');

        await waitFor([spy.withArgs(EV.ADD)]);
        ok(spy.calledWith(EV.ADD, filename));
      });
      it('should still emit initial add events', async () => {
        options.ignoreInitial = false;
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        ok(spy.calledWith(EV.ADD));
        ok(spy.calledWith(EV.ADD_DIR));
      });
      it('should emit an unlink event when a file is updated and deleted just after that', async () => {
        const testPath = dpath('subdir/add.txt');
        const filename = sp.basename(testPath);
        options.cwd = sp.dirname(testPath);
        await mkdir(options.cwd);
        await delay();
        await write(testPath, 'hello');
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'edit');
        await delay();
        await unlink(testPath);
        await waitFor([spy.withArgs(EV.UNLINK)]);
        ok(spy.calledWith(EV.UNLINK, filename));
        equal(spy.calledWith(EV.CHANGE, filename), false);
      });
    });
  });
  describe('getWatched', () => {
    it('should return the watched paths', async () => {
      const expected: Record<string, string[]> = {};
      expected[sp.dirname(currentDir)] = [testId.toString()];
      expected[currentDir] = ['change.txt', 'unlink.txt'];
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);
      deepEqual(watcher.getWatched(), expected);
    });
    it('should set keys relative to cwd & include added paths', async () => {
      options.cwd = currentDir;
      const expected = {
        '.': ['change.txt', 'subdir', 'unlink.txt'],
        '..': [testId.toString()],
        subdir: [],
      };
      await mkdir(dpath('subdir'));
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);
      deepEqual(watcher.getWatched(), expected);
    });
  });
  describe('unwatch', () => {
    beforeEach(async () => {
      options.ignoreInitial = true;
      await mkdir(dpath('subdir'));
      await delay();
    });
    it('should stop watching unwatched paths', async () => {
      const watchPaths = [dpath('subdir'), dpath('change.txt')];
      const watcher = cwatch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      watcher.unwatch(dpath('subdir'));

      await delay();
      await write(dpath('subdir/add.txt'), time());
      await write(dpath('change.txt'), time());
      await waitFor([spy]);

      await delay(300);
      ok(spy.calledWith(EV.CHANGE, dpath('change.txt')));
      equal(spy.calledWith(EV.ADD), false);
      if (!macosFswatch) equal(spy.calledOnce, true);
    });
    it('should ignore unwatched paths that are a subset of watched paths', async () => {
      const subdirRel = upath.relative(process.cwd(), dpath('subdir'));
      const unlinkFile = dpath('unlink.txt');
      const addFile = dpath('subdir/add.txt');
      const changedFile = dpath('change.txt');
      const watcher = cwatch(currentDir, options);
      const spy = await aspy(watcher, EV.ALL);

      // test with both relative and absolute paths
      watcher.unwatch([subdirRel, gpath('unlink.txt')]);

      await delay();
      await unlink(unlinkFile);
      await write(addFile, time());
      await write(changedFile, time());
      await waitFor([spy.withArgs(EV.CHANGE)]);

      await delay(300);
      ok(spy.calledWith(EV.CHANGE, changedFile));
      equal(spy.calledWith(EV.ADD, addFile), false);
      equal(spy.calledWith(EV.UNLINK, unlinkFile), false);
      if (!macosFswatch) equal(spy.calledOnce, true);
    });
    it('should unwatch relative paths', async () => {
      const fixturesDir = sp.relative(process.cwd(), currentDir);
      const subdir = sp.join(fixturesDir, 'subdir');
      const changeFile = sp.join(fixturesDir, 'change.txt');
      const watchPaths = [subdir, changeFile];
      const watcher = cwatch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      watcher.unwatch(subdir);
      await write(dpath('subdir/add.txt'), time());
      await write(dpath('change.txt'), time());
      await waitFor([spy]);

      await delay(300);
      ok(spy.calledWith(EV.CHANGE, changeFile));
      equal(spy.calledWith(EV.ADD), false);
      if (!macosFswatch) equal(spy.calledOnce, true);
    });
    it.skip('should watch paths that were unwatched and added again', async () => {
      const spy = sspy();
      const watchPaths = [dpath('change.txt')];
      console.log('watching', watchPaths);
      const watcher = cwatch(watchPaths, options).on(EV.ALL, console.log.bind(console));
      await waitForWatcher(watcher);
      await delay();
      watcher.unwatch(dpath('change.txt'));
      await delay();
      watcher.on(EV.ALL, spy).add(dpath('change.txt'));

      await delay();
      await write(dpath('change.txt'), time());
      console.log('a');
      await waitFor([spy]);
      console.log('b');
      ok(spy.calledWith(EV.CHANGE, dpath('change.txt')));
      if (!macosFswatch) equal(spy.calledOnce, true);
    });
    it('should unwatch paths that are relative to options.cwd', async () => {
      options.cwd = currentDir;
      const watcher = cwatch('.', options);
      const spy = await aspy(watcher, EV.ALL);
      watcher.unwatch(['subdir', dpath('unlink.txt')]);

      await delay();
      await unlink(dpath('unlink.txt'));
      await write(dpath('subdir/add.txt'), time());
      await write(dpath('change.txt'), time());
      await waitFor([spy]);

      await delay(300);
      ok(spy.calledWith(EV.CHANGE, 'change.txt'));
      equal(spy.calledWith(EV.ADD), false);
      equal(spy.calledWith(EV.UNLINK), false);
      if (!macosFswatch) equal(spy.calledOnce, true);
    });
  });
  describe('env variable option override', () => {
    describe('CHOKIDAR_USEPOLLING', () => {
      afterEach(() => {
        delete process.env.CHOKIDAR_USEPOLLING;
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to true', async () => {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = 'true';
        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        equal(watcher.options.usePolling, true);
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to 1', async () => {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = '1';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        equal(watcher.options.usePolling, true);
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to false', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        equal(watcher.options.usePolling, false);
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to 0', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        equal(watcher.options.usePolling, false);
      });

      it('should not attenuate options.usePolling when CHOKIDAR_USEPOLLING is set to an arbitrary value', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'foo';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        equal(watcher.options.usePolling, true);
      });
    });
    if (options && options.usePolling) {
      describe('CHOKIDAR_INTERVAL', () => {
        afterEach(() => {
          delete process.env.CHOKIDAR_INTERVAL;
        });
        it('should make options.interval = CHOKIDAR_INTERVAL when it is set', async () => {
          options.interval = 100;
          process.env.CHOKIDAR_INTERVAL = '1500';

          const watcher = cwatch(currentDir, options);
          await waitForWatcher(watcher);
          equal(watcher.options.interval, 1500);
        });
      });
    }
  });
  describe('reproduction of bug in issue #1040', () => {
    it('should detect change on symlink folders when consolidateThreshhold is reached', async () => {
      const CURR = sp.join(FIXTURES_PATH, testId.toString());
      const fixturesPathRel = sp.join(CURR, 'test-case-1040');
      const linkPath = sp.join(fixturesPathRel, 'symlinkFolder');
      const packagesPath = sp.join(fixturesPathRel, 'packages');
      await mkdir(fixturesPathRel, { recursive: true });
      await mkdir(linkPath);
      await mkdir(packagesPath);

      // Init chokidar
      const watcher = cwatch([]);

      // Add more than 10 folders to cap consolidateThreshhold
      for (let i = 0; i < 20; i += 1) {
        const folderPath = sp.join(packagesPath, `folder${i}`);
        await mkdir(folderPath);
        const filePath = sp.join(folderPath, `file${i}.js`);
        await write(sp.resolve(filePath), 'file content');
        const symlinkPath = sp.join(linkPath, `folder${i}`);
        await symlink(sp.resolve(folderPath), symlinkPath, isWindows ? 'dir' : undefined);
        watcher.add(sp.resolve(sp.join(symlinkPath, `file${i}.js`)));
      }

      // Wait to be sure that we have no other event than the update file
      await delay(300);

      const eventsWaiter = waitForEvents(watcher, 1);

      // Update a random generated file to fire an event
      const randomFilePath = sp.join(packagesPath, 'folder17', 'file17.js');
      await write(sp.resolve(randomFilePath), 'file content changer zeri ezhriez');

      // Wait chokidar watch
      await delay(300);

      const events = await eventsWaiter;

      equal(events.length, 1);
    });
  });
  describe('reproduction of bug in issue #1024', () => {
    it('should detect changes to folders, even if they were deleted before', async () => {
      const id = testId.toString();
      const absoluteWatchedDir = sp.join(FIXTURES_PATH, id, 'test');
      const relativeWatcherDir = sp.join(id, 'test');
      const watcher = cwatch(relativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = sp.join(absoluteWatchedDir, 'dir');
        const testSubDirFile = sp.join(absoluteWatchedDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await mkdir(absoluteWatchedDir);
        await mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rm will be equalize
        await delay(300);
        await rmr(testSubDir);
        // The following delay is essential otherwise the call of rm and mkdir will be equalize
        await delay(300);
        await mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        deepEqual(events, [
          `[ALL] addDir: ${sp.join(id, 'test')}`,
          `[ALL] addDir: ${sp.join(id, 'test', 'dir')}`,
          `[ALL] unlinkDir: ${sp.join(id, 'test', 'dir')}`,
          `[ALL] addDir: ${sp.join(id, 'test', 'dir')}`,
          `[ALL] add: ${sp.join(id, 'test', 'dir', 'file')}`,
        ]);
      } finally {
        watcher.close();
      }
    });

    it('should detect changes to symlink folders, even if they were deleted before', async () => {
      const id = testId.toString();
      const relativeWatcherDir = sp.join(id, 'test');
      const linkedRelativeWatcherDir = sp.join(id, 'test-link');
      await symlink(
        sp.resolve(relativeWatcherDir),
        linkedRelativeWatcherDir,
        isWindows ? 'dir' : undefined
      );
      await delay();
      const watcher = cwatch(linkedRelativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = sp.join(relativeWatcherDir, 'dir');
        const testSubDirFile = sp.join(relativeWatcherDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await mkdir(relativeWatcherDir);
        await mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rm will be equalize
        await delay(300);
        await rmr(testSubDir);
        // The following delay is essential otherwise the call of rm and mkdir will be equalize
        await delay(300);
        await mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        deepEqual(events, [
          `[ALL] addDir: ${sp.join(id, 'test-link')}`,
          `[ALL] addDir: ${sp.join(id, 'test-link', 'dir')}`,
          `[ALL] unlinkDir: ${sp.join(id, 'test-link', 'dir')}`,
          `[ALL] addDir: ${sp.join(id, 'test-link', 'dir')}`,
          `[ALL] add: ${sp.join(id, 'test-link', 'dir', 'file')}`,
        ]);
      } finally {
        watcher.close();
      }
    });
  });

  describe('close', () => {
    it('should ignore further events on close', async () => {
      const spy = sspy();
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);

      watcher.on(EV.ALL, spy);
      await watcher.close();

      await write(dpath('add.txt'), time());
      await write(dpath('add.txt'), 'hello');
      await delay(300);
      await unlink(dpath('add.txt'));

      equal(spy.called, false);
    });
    it('should not ignore further events on close with existing watchers', async () => {
      const spy = sspy();
      const watcher1 = cwatch(currentDir);
      const watcher2 = cwatch(currentDir);
      await Promise.all([waitForWatcher(watcher1), waitForWatcher(watcher2)]);

      // The EV_ADD event should be called on the second watcher even if the first watcher is closed
      watcher2.on(EV.ADD, spy);
      await watcher1.close();

      await write(dpath('add.txt'), 'hello');
      // Ensures EV_ADD is called. Immediately removing the file causes it to be skipped
      await delay(200);
      await unlink(dpath('add.txt'));

      ok(spy.calledWith(sinonmatch('add.txt')));
    });
    it('should not prevent the process from exiting', async () => {
      function rmSlashes(str: string) {
        return str.replace(/\\/g, '\\\\');
      }
      const _dirname = fileURLToPath(new URL('.', imetaurl)); // Will contain trailing slash
      const chokidarPath = rmSlashes(pathToFileURL(sp.join(_dirname, 'index.js')).href);

      const scriptFile = dpath('script.js');
      const scriptContent = `
      (async () => {
        const chokidar = await import("${chokidarPath}");
        const watcher = chokidar.watch("${rmSlashes(scriptFile)}");
        watcher.on("ready", () => {
          watcher.close();
          process.stdout.write("closed");
        });
      })();`;
      await write(scriptFile, scriptContent);
      const obj = await exec(`node ${scriptFile}`);
      const { stdout } = obj;
      equal(stdout.toString(), 'closed');
    });
    it('should always return the same promise', async () => {
      const watcher = cwatch(currentDir, options);
      const closePromise = watcher.close();
      ok(closePromise instanceof Promise);
      equal(watcher.close(), closePromise);
      await closePromise;
    });
  });
};

describe('chokidar', async () => {
  beforeEach(() => {
    testId++;
    currentDir = dpath('');
  });

  afterEach(async () => {
    const promises = WATCHERS.map((w) => w.close());
    await Promise.all(promises);
    await rmr(currentDir);
  });

  it('should expose public API methods', () => {
    ok(typeof chokidar.FSWatcher === 'function');
    ok(typeof chokidar.watch === 'function');
  });

  if (!isIBMi) {
    describe('fs.watch (non-polling)', runTests.bind(this, { usePolling: false }));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, { usePolling: true, interval: 10 }));
});
async function main() {
  const initialPath = process.cwd();
  try {
    await rmr(FIXTURES_PATH);
    await mkdir(FIXTURES_PATH, { recursive: true });
  } catch (error) {}
  process.chdir(FIXTURES_PATH);

  // Create many directories before tests.
  // Creating them in `beforeEach` increases chance of random failures.
  const _filename = fileURLToPath(new URL('', imetaurl));
  const _content = await read(_filename, 'utf-8');
  const _only = _content.match(/\sit\.only\(/g);
  const itCount = (_only && _only.length) || _content.match(/\sit\(/g)?.length;
  const testCount = (itCount ?? 0) * 3;
  while (testId++ < testCount) {
    await mkdir(dpath(''));
    await write(dpath('change.txt'), 'b');
    await write(dpath('unlink.txt'), 'b');
  }
  testId = 0;
  await it.run(true);

  try {
    await rmr(FIXTURES_PATH);
  } catch (error) {
    console.error('test clean-up error', error);
  }
  process.chdir(initialPath);
}
main();
