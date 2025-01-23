import * as fs from 'node:fs'; // fs.stat is mocked below, so can't import INDIVIDUAL methods
import * as fsp from 'node:fs/promises';
import { writeFile as write, readFile as read, rm } from 'node:fs/promises';
import * as sysPath from 'node:path';
import { describe, it, beforeEach, afterEach } from 'micro-should';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';
import { exec as cexec } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as chai from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import upath from 'upath';

import * as chokidar from './index.js';
import { EVENTS as EV, isWindows, isMacos, isIBMi } from './handler.js';

const TEST_TIMEOUT = 32000; // ms

const { expect } = chai;
chai.use(sinonChai);
chai.should();

const exec = promisify(cexec);

const imetaurl = import.meta.url;
const __filename = fileURLToPath(new URL('', imetaurl));
const __dirname = fileURLToPath(new URL('.', imetaurl)); // Will contain trailing slash
const initialPath = process.cwd();
const FIXTURES_PATH = sysPath.join(tmpdir(), 'chokidar-' + Date.now());

const WATCHERS: chokidar.FSWatcher[] = [];
const PERM = 0o755; // rwe, r+e, r+e
let testId = 0;
let currentDir: string;
let slowerDelay: number | undefined;

// spyOnReady
const aspy = (
  watcher: chokidar.FSWatcher,
  eventName: string,
  spy: sinon.SinonSpy | null = null,
  noStat: boolean = false
): Promise<sinon.SinonSpy> => {
  if (typeof eventName !== 'string') {
    throw new TypeError('aspy: eventName must be a String');
  }
  if (spy == null) spy = sinon.spy();
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

const delay = async (time?: number) => {
  return new Promise<void>((resolve) => {
    const timer = time || slowerDelay || 20;
    setTimeout(resolve, timer);
  });
};

// dir path
const dpath = (subPath: string) => {
  const subd = (testId && testId.toString()) || '';
  return sysPath.join(FIXTURES_PATH, subd, subPath);
};
// glob path
const gpath = (subPath: string) => {
  const subd = (testId && testId.toString()) || '';
  return upath.join(FIXTURES_PATH, subd, subPath);
};
currentDir = dpath('');

const cwatch = (
  path: Parameters<typeof chokidar.watch>[0] = currentDir,
  opts?: chokidar.ChokidarOptions
) => {
  const wt = chokidar.watch(path, opts);
  WATCHERS.push(wt);
  return wt;
};

const waitFor = (spies: Array<sinon.SinonSpy | [sinon.SinonSpy, number]>) => {
  if (spies.length === 0) throw new Error('need at least 1 spy');
  return new Promise<void>((resolve, reject) => {
    let checkTimer: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => {
      clearTimeout(checkTimer);
      reject(new Error('timeout waitFor, passed ms: ' + TEST_TIMEOUT));
    }, TEST_TIMEOUT);
    const isSpyReady = (spy: sinon.SinonSpy | [sinon.SinonSpy, number]): boolean => {
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
};

const waitForEvents = (watcher: chokidar.FSWatcher, count: number) => {
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
};

const dateNow = () => Date.now().toString();

const runTests = (baseopts: chokidar.ChokidarOptions) => {
  let macosFswatch = isMacos && !baseopts.usePolling;
  let win32Polling = isWindows && baseopts.usePolling;
  let options: chokidar.ChokidarOptions;
  slowerDelay = macosFswatch ? 100 : undefined;
  baseopts.persistent = true;

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach((key) => {
      (options as Record<PropertyKey, unknown>)[key] =
        baseopts[key as keyof chokidar.ChokidarOptions];
    });
  });

  describe('watch a directory', () => {
    let readySpy: sinon.SinonSpy;
    let rawSpy: sinon.SinonSpy;
    let watcher: chokidar.FSWatcher;
    let watcher2: chokidar.FSWatcher;
    beforeEach(async () => {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = sinon.spy(function readySpy() {});
      rawSpy = sinon.spy(function rawSpy() {});
      watcher = cwatch(currentDir, options).on(EV.READY, readySpy).on(EV.RAW, rawSpy);
      await waitForWatcher(watcher);
    });
    afterEach(async () => {
      await waitFor([readySpy]);
      await watcher.close();
      readySpy.should.have.been.calledOnce;
    });
    it('should produce an instance of chokidar.FSWatcher', () => {
      watcher.should.be.an.instanceof(chokidar.FSWatcher);
    });
    it('should expose public API methods', () => {
      watcher.on.should.be.a('function');
      watcher.emit.should.be.a('function');
      watcher.add.should.be.a('function');
      watcher.close.should.be.a('function');
      watcher.getWatched.should.be.a('function');
    });
    it('should emit `add` event when file was added', async () => {
      const testPath = dpath('add.txt');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function addSpy() {});
      watcher.on(EV.ADD, spy);
      await delay();
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should emit nine `add` events when nine files were added in one directory', async () => {
      const paths = [];
      for (let i = 1; i <= 9; i++) {
        paths.push(dpath(`add${i}.txt`));
      }

      const spy = sinon.spy();
      watcher.on(EV.ADD, (path) => {
        spy(path);
      });

      await write(paths[0], dateNow());
      await write(paths[1], dateNow());
      await write(paths[2], dateNow());
      await write(paths[3], dateNow());
      await write(paths[4], dateNow());
      await delay(100);

      await write(paths[5], dateNow());
      await write(paths[6], dateNow());

      await delay(150);
      await write(paths[7], dateNow());
      await write(paths[8], dateNow());

      await waitFor([[spy, 4]]);

      await delay(1000);
      await waitFor([[spy, 9]]);
      paths.forEach((path) => {
        spy.should.have.been.calledWith(path);
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
      await fsp.mkdir(dpath('b'), PERM);
      await fsp.mkdir(dpath('c'), PERM);
      await fsp.mkdir(dpath('d'), PERM);
      await fsp.mkdir(dpath('e'), PERM);
      await fsp.mkdir(dpath('f'), PERM);
      await fsp.mkdir(dpath('g'), PERM);
      await fsp.mkdir(dpath('h'), PERM);
      await fsp.mkdir(dpath('i'), PERM);

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
        await write(fileToWrite, dateNow());
        await waitFor([[spy, ++currentCallCount]]);
      }

      spy.should.have.been.calledWith(test1Path);
      spy.should.have.been.calledWith(test2Path);
      spy.should.have.been.calledWith(test3Path);
      spy.should.have.been.calledWith(test4Path);
      spy.should.have.been.calledWith(test5Path);
      spy.should.have.been.calledWith(test6Path);
      spy.should.have.been.calledWith(test7Path);
      spy.should.have.been.calledWith(test8Path);
      spy.should.have.been.calledWith(test9Path);
      spy.should.have.been.calledWith(testb1Path);
      spy.should.have.been.calledWith(testb2Path);
      spy.should.have.been.calledWith(testb3Path);
      spy.should.have.been.calledWith(testb4Path);
      spy.should.have.been.calledWith(testb5Path);
      spy.should.have.been.calledWith(testb6Path);
      spy.should.have.been.calledWith(testb7Path);
      spy.should.have.been.calledWith(testb8Path);
      spy.should.have.been.calledWith(testb9Path);
      spy.should.have.been.calledWith(testc1Path);
      spy.should.have.been.calledWith(testc2Path);
      spy.should.have.been.calledWith(testc3Path);
      spy.should.have.been.calledWith(testc4Path);
      spy.should.have.been.calledWith(testc5Path);
      spy.should.have.been.calledWith(testc6Path);
      spy.should.have.been.calledWith(testc7Path);
      spy.should.have.been.calledWith(testc8Path);
      spy.should.have.been.calledWith(testc9Path);
      spy.should.have.been.calledWith(testd1Path);
      spy.should.have.been.calledWith(teste1Path);
      spy.should.have.been.calledWith(testf1Path);
      spy.should.have.been.calledWith(testg1Path);
      spy.should.have.been.calledWith(testh1Path);
      spy.should.have.been.calledWith(testi1Path);
    });
    it('should emit `addDir` event when directory was added', async () => {
      const testDir = dpath('subdir');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function addDirSpy() {});
      watcher.on(EV.ADD_DIR, spy);
      spy.should.not.have.been.called;
      await fsp.mkdir(testDir, PERM);
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testDir);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should emit `change` event when file was changed', async () => {
      const testPath = dpath('change.txt');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function changeSpy() {});
      watcher.on(EV.CHANGE, spy);
      spy.should.not.have.been.called;
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit `unlink` event when file was removed', async () => {
      const testPath = dpath('unlink.txt');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlinkSpy() {});
      watcher.on(EV.UNLINK, spy);
      spy.should.not.have.been.called;
      await fsp.unlink(testPath);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit `unlinkDir` event when a directory was removed', async () => {
      const testDir = dpath('subdir');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlinkDirSpy() {});

      await fsp.mkdir(testDir, PERM);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, spy);

      await fsp.rmdir(testDir);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testDir);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit two `unlinkDir` event when two nested directories were removed', async () => {
      const testDir = dpath('subdir');
      const testDir2 = dpath('subdir/subdir2');
      const testDir3 = dpath('subdir/subdir2/subdir3');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlinkDirSpy() {});

      await fsp.mkdir(testDir, PERM);
      await fsp.mkdir(testDir2, PERM);
      await fsp.mkdir(testDir3, PERM);
      await delay(300);

      watcher.on(EV.UNLINK_DIR, spy);

      await rm(testDir2, { recursive: true });
      await waitFor([[spy, 2]]);

      spy.should.have.been.calledWith(testDir2);
      spy.should.have.been.calledWith(testDir3);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledTwice;
    });
    it('should emit `unlink` and `add` events when a file is renamed', async () => {
      const unlinkSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlink() {});
      const addSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function add() {});
      const testPath = dpath('change.txt');
      const newPath = dpath('moved.txt');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy);
      unlinkSpy.should.not.have.been.called;
      addSpy.should.not.have.been.called;

      await delay();
      await fsp.rename(testPath, newPath);
      await waitFor([unlinkSpy, addSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);
      expect(unlinkSpy.args[0][1]).to.not.be.ok; // no stats
      addSpy.should.have.been.calledOnce;
      addSpy.should.have.been.calledWith(newPath);
      expect(addSpy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
      if (!macosFswatch) unlinkSpy.should.have.been.calledOnce;
    });
    it('should emit `add`, not `change`, when previously deleted file is re-added', async () => {
      if (isWindows) {
        console.warn('test skipped');
        return true;
      }
      const unlinkSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlink() {});
      const addSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function add() {});
      const changeSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function change() {});
      const testPath = dpath('add.txt');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy).on(EV.CHANGE, changeSpy);
      await write(testPath, 'hello');
      await waitFor([[addSpy.withArgs(testPath), 1]]);
      unlinkSpy.should.not.have.been.called;
      changeSpy.should.not.have.been.called;
      await fsp.unlink(testPath);
      await waitFor([unlinkSpy.withArgs(testPath)]);
      unlinkSpy.should.have.been.calledWith(testPath);

      await delay(100);
      await write(testPath, dateNow());
      await waitFor([[addSpy.withArgs(testPath), 2]]);
      addSpy.should.have.been.calledWith(testPath);
      changeSpy.should.not.have.been.called;
      expect(addSpy.callCount).to.equal(2);
    });
    it('should not emit `unlink` for previously moved files', async () => {
      const unlinkSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlink() {});
      const testPath = dpath('change.txt');
      const newPath1 = dpath('moved.txt');
      const newPath2 = dpath('moved-again.txt');
      watcher.on(EV.UNLINK, unlinkSpy);
      await fsp.rename(testPath, newPath1);

      await delay(300);
      await fsp.rename(newPath1, newPath2);
      await waitFor([unlinkSpy.withArgs(newPath1)]);
      unlinkSpy.withArgs(testPath).should.have.been.calledOnce;
      unlinkSpy.withArgs(newPath1).should.have.been.calledOnce;
      unlinkSpy.withArgs(newPath2).should.not.have.been.called;
    });
    it('should survive ENOENT for missing subdirectories', async () => {
      const testDir = dpath('notadir');
      watcher.add(testDir);
    });
    it('should notice when a file appears in a new directory', async () => {
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const spy = sinon.spy<(p: string, s?: fs.Stats) => void>(function addSpy() {});
      watcher.on(EV.ADD, spy);
      spy.should.not.have.been.called;
      await fsp.mkdir(testDir, PERM);
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should watch removed and re-added directories', async () => {
      const unlinkSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlinkSpy() {});
      const addSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function addSpy() {});
      const parentPath = dpath('subdir2');
      const subPath = dpath('subdir2/subsub');
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD_DIR, addSpy);
      await fsp.mkdir(parentPath, PERM);

      await delay(win32Polling ? 900 : 300);
      await fsp.rmdir(parentPath);
      await waitFor([unlinkSpy.withArgs(parentPath)]);
      unlinkSpy.should.have.been.calledWith(parentPath);
      await fsp.mkdir(parentPath, PERM);

      await delay(win32Polling ? 2200 : 1200);
      await fsp.mkdir(subPath, PERM);
      await waitFor([[addSpy, 3]]);
      addSpy.should.have.been.calledWith(parentPath);
      addSpy.should.have.been.calledWith(subPath);
    });
    it('should emit `unlinkDir` and `add` when dir is replaced by file', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlinkSpy() {});
      const addSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function addSpy() {});
      const testPath = dpath('dirFile');
      await fsp.mkdir(testPath, PERM);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD, addSpy);

      await fsp.rmdir(testPath);
      await waitFor([unlinkSpy]);

      await write(testPath, 'file content');
      await waitFor([addSpy]);

      unlinkSpy.should.have.been.calledWith(testPath);
      addSpy.should.have.been.calledWith(testPath);
    });
    it('should emit `unlink` and `addDir` when file is replaced by dir', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy() {});
      const addSpy = sinon.spy(function addSpy() {});
      const testPath = dpath('fileDir');
      await write(testPath, 'file content');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD_DIR, addSpy);

      await delay(300);
      await fsp.unlink(testPath);
      await delay(300);
      await fsp.mkdir(testPath, PERM);

      await waitFor([addSpy, unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);
      addSpy.should.have.been.calledWith(testPath);
    });
  });
  describe('watch individual files', () => {
    it('should emit `ready` when three files were added', async () => {
      const readySpy = sinon.spy(function readySpy() {});
      const watcher = cwatch(currentDir, options).on(EV.READY, readySpy);
      const path1 = dpath('add1.txt');
      const path2 = dpath('add2.txt');
      const path3 = dpath('add3.txt');

      watcher.add(path1);
      watcher.add(path2);
      watcher.add(path3);

      await waitForWatcher(watcher);
      // callCount is 1 on macOS, 4 on Ubuntu
      readySpy.callCount.should.be.greaterThanOrEqual(1);
    });
    it('should detect changes', async () => {
      const testPath = dpath('change.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.CHANGE);
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(testPath);
    });
    it('should detect unlinks', async () => {
      const testPath = dpath('unlink.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.UNLINK);

      await delay();
      await fsp.unlink(testPath);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should detect unlink and re-add', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function unlinkSpy() {});
      const addSpy = sinon.spy<(p: string, s?: fs.Stats) => void>(function addSpy() {});
      const testPath = dpath('unlink.txt');
      const watcher = cwatch([testPath], options).on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      await delay();
      await fsp.unlink(testPath);
      await waitFor([unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);

      await delay();
      await write(testPath, 're-added');
      await waitFor([addSpy]);
      addSpy.should.have.been.calledWith(testPath);
    });

    it('should ignore unwatched siblings', async () => {
      const testPath = dpath('add.txt');
      const siblingPath = dpath('change.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(siblingPath, dateNow());
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(EV.ADD, testPath);
    });

    it('should detect safe-edit', async () => {
      const testPath = dpath('change.txt');
      const safePath = dpath('tmp.txt');
      await write(testPath, dateNow());
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(safePath, dateNow());
      await fsp.rename(safePath, testPath);
      await delay(300);
      await write(safePath, dateNow());
      await fsp.rename(safePath, testPath);
      await delay(300);
      await write(safePath, dateNow());
      await fsp.rename(safePath, testPath);
      await delay(300);
      await waitFor([spy]);
      spy.withArgs(EV.CHANGE, testPath).should.have.been.calledThrice;
    });

    // PR 682 is failing.
    describe.skip('Skipping gh-682: should detect unlink', () => {
      it('should detect unlink while watching a non-existent second file in another directory', async () => {
        const testPath = dpath('unlink.txt');
        const otherDirPath = dpath('other-dir');
        const otherPath = dpath('other-dir/other.txt');
        await fsp.mkdir(otherDirPath, PERM);
        const watcher = cwatch([testPath, otherPath], options);
        // intentionally for this test don't write write(otherPath, 'other');
        const spy = await aspy(watcher, EV.UNLINK);

        await delay();
        await fsp.unlink(testPath);
        await waitFor([spy]);
        spy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a second file', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy() {});
        const addSpy = sinon.spy(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        await write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fsp.unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        unlinkSpy.should.have.been.calledWith(testPath);

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        addSpy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a non-existent second file in another directory', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy() {});
        const addSpy = sinon.spy(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherDirPath = dpath('other-dir');
        const otherPath = dpath('other-dir/other.txt');
        await fsp.mkdir(otherDirPath, PERM);
        // intentionally for this test don't write write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fsp.unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        unlinkSpy.should.have.been.calledWith(testPath);

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        addSpy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a non-existent second file in the same directory', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy() {});
        const addSpy = sinon.spy(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        // intentionally for this test don't write write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fsp.unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        unlinkSpy.should.have.been.calledWith(testPath);

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        addSpy.should.have.been.calledWith(testPath);
      });
      it('should detect two unlinks and one re-add', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy() {});
        const addSpy = sinon.spy(function addSpy() {});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        await write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fsp.unlink(otherPath);

        await delay();
        await fsp.unlink(testPath);
        await waitFor([[unlinkSpy, 2]]);

        await delay();
        unlinkSpy.should.have.been.calledWith(otherPath);
        unlinkSpy.should.have.been.calledWith(testPath);

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        addSpy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a second file and a non-existent third file', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy() {});
        const addSpy = sinon.spy(function addSpy() {});
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
        await fsp.unlink(testPath);

        await waitFor([unlinkSpy]);
        await delay();
        unlinkSpy.should.have.been.calledWith(testPath);

        await delay();
        await write(testPath, 're-added');
        await waitFor([addSpy]);
        addSpy.should.have.been.calledWith(testPath);
      });
    });
  });
  describe('renamed directory', () => {
    it('should emit `add` for a file in a renamed directory', async () => {
      options.ignoreInitial = true;
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const renamedDir = dpath('subdir-renamed');
      const expectedPath = sysPath.join(renamedDir, 'add.txt');
      await fsp.mkdir(testDir, PERM);
      await write(testPath, dateNow());
      const watcher = cwatch(currentDir, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay(1000);
      await fsp.rename(testDir, renamedDir);
      await waitFor([spy.withArgs(expectedPath)]);
      spy.should.have.been.calledWith(expectedPath);
    });
  });
  describe('watch non-existent paths', () => {
    it('should watch non-existent file and detect add', async () => {
      const testPath = dpath('add.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay();
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should watch non-existent dir and detect addDir/add', async () => {
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const watcher = cwatch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.not.have.been.called;

      await delay();
      await fsp.mkdir(testDir, PERM);
      await waitFor([spy.withArgs(EV.ADD_DIR)]);
      await write(testPath, 'hello');
      await waitFor([spy.withArgs(EV.ADD)]);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV.ADD, testPath);
    });
  });
  describe('not watch glob patterns', () => {
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = dpath('nota[glob].txt');
      await write(filePath, 'b');
      await delay();
      const spy = await aspy(cwatch(currentDir, options), EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, filePath);

      await delay();
      await write(filePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like directory names as literal directory names when globbing is disabled', async () => {
      const filePath = dpath('nota[glob]/a.txt');
      const watchPath = dpath('nota[glob]');
      const testDir = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/b.txt');
      const matchingFile2 = dpath('notal');
      await fsp.mkdir(testDir, PERM);
      await write(filePath, 'b');
      await fsp.mkdir(matchingDir, PERM);
      await write(matchingFile, 'c');
      await write(matchingFile2, 'd');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, filePath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile2);
      await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like filenames as literal filenames', async () => {
      const filePath = dpath('nota[glob]');
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/a.txt');
      const matchingFile2 = dpath('notal');
      await write(filePath, 'b');
      await fsp.mkdir(matchingDir, PERM);
      await write(matchingFile, 'c');
      await write(matchingFile2, 'd');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, filePath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile2);
      await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
  });
  describe('watch symlinks', () => {
    if (isWindows) return true;
    let linkedDir: string;
    beforeEach(async () => {
      linkedDir = sysPath.resolve(currentDir, '..', `${testId}-link`);
      await fsp.symlink(currentDir, linkedDir, isWindows ? 'dir' : null);
      await fsp.mkdir(dpath('subdir'), PERM);
      await write(dpath('subdir/add.txt'), 'b');
    });
    afterEach(async () => {
      await fsp.unlink(linkedDir);
    });

    it('should watch symlinked dirs', async () => {
      const dirSpy = sinon.spy(function dirSpy() {});
      const addSpy = sinon.spy(function addSpy() {});
      const watcher = cwatch(linkedDir, options).on(EV.ADD_DIR, dirSpy).on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      dirSpy.should.have.been.calledWith(linkedDir);
      addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'change.txt'));
      addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'unlink.txt'));
    });
    it('should watch symlinked files', async () => {
      const changePath = dpath('change.txt');
      const linkPath = dpath('link.txt');
      await fsp.symlink(changePath, linkPath);
      const watcher = cwatch(linkPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should follow symlinked files within a normal dir', async () => {
      const changePath = dpath('change.txt');
      const linkPath = dpath('subdir/link.txt');
      await fsp.symlink(changePath, linkPath);
      const watcher = cwatch(dpath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should watch paths with a symlinked parent', async () => {
      const testDir = sysPath.join(linkedDir, 'subdir');
      const testFile = sysPath.join(testDir, 'add.txt');
      const watcher = cwatch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV.ADD, testFile);
      await write(dpath('subdir/add.txt'), dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testFile);
    });
    it('should not recurse indefinitely on circular symlinks', async () => {
      await fsp.symlink(currentDir, dpath('subdir/circular'), isWindows ? 'dir' : null);
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
      const linkedFilePath = sysPath.join(linkedDir, 'change.txt');
      const watcher = cwatch(linkedDir, options);
      const spy = await aspy(watcher, EV.CHANGE);
      const wa = spy.withArgs(linkedFilePath);
      await write(dpath('change.txt'), dateNow());
      await waitFor([wa]);
      spy.should.have.been.calledWith(linkedFilePath);
    });
    it('should follow newly created symlinks', async () => {
      options.ignoreInitial = true;
      const watcher = cwatch(currentDir, options);
      const spy = await aspy(watcher, EV.ALL);
      await delay();
      await fsp.symlink(dpath('subdir'), dpath('link'), isWindows ? 'dir' : null);
      await waitFor([
        spy.withArgs(EV.ADD, dpath('link/add.txt')),
        spy.withArgs(EV.ADD_DIR, dpath('link')),
      ]);
      spy.should.have.been.calledWith(EV.ADD_DIR, dpath('link'));
      spy.should.have.been.calledWith(EV.ADD, dpath('link/add.txt'));
    });
    it('should watch symlinks as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const watcher = cwatch(linkedDir, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.not.have.been.calledWith(EV.ADD_DIR);
      spy.should.have.been.calledWith(EV.ADD, linkedDir);
      spy.should.have.been.calledOnce;
    });
    it('should survive ENOENT for missing symlinks when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const targetDir = dpath('subdir/nonexistent');
      await fsp.mkdir(targetDir);
      await fsp.symlink(targetDir, dpath('subdir/broken'), isWindows ? 'dir' : null);
      await fsp.rmdir(targetDir);
      await delay();

      const watcher = cwatch(dpath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV.ADD_DIR, dpath('subdir'));
      spy.should.have.been.calledWith(EV.ADD, dpath('subdir/add.txt'));
    });
    it('should watch symlinks within a watched dir as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      // Create symlink in linkPath
      const linkPath = dpath('link');
      await fsp.symlink(dpath('subdir'), linkPath);
      const spy = await aspy(cwatch(currentDir, options), EV.ALL);
      await delay(300);
      setTimeout(
        () => {
          fs.writeFileSync(dpath('subdir/add.txt'), dateNow());
          fs.unlinkSync(linkPath);
          fs.symlinkSync(dpath('subdir/add.txt'), linkPath);
        },
        options.usePolling ? 1200 : 300
      );

      await delay(300);
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, linkPath);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('link/add.txt'));
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should not reuse watcher when following a symlink to elsewhere', async () => {
      const linkedPath = dpath('outside');
      const linkedFilePath = sysPath.join(linkedPath, 'text.txt');
      const linkPath = dpath('subdir/subsub');
      await fsp.mkdir(linkedPath, PERM);
      await write(linkedFilePath, 'b');
      await fsp.symlink(linkedPath, linkPath);
      const watcher2 = cwatch(dpath('subdir'), options);
      await waitForWatcher(watcher2);

      await delay(options.usePolling ? 900 : undefined);
      const watchedPath = dpath('subdir/subsub/text.txt');
      const watcher = cwatch(watchedPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(linkedFilePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, watchedPath);
    });
    it('should emit ready event even when broken symlinks are encountered', async () => {
      const targetDir = dpath('subdir/nonexistent');
      await fsp.mkdir(targetDir);
      await fsp.symlink(targetDir, dpath('subdir/broken'), isWindows ? 'dir' : null);
      await fsp.rmdir(targetDir);
      const readySpy = sinon.spy(function readySpy() {});
      const watcher = cwatch(dpath('subdir'), options).on(EV.READY, readySpy);
      await waitForWatcher(watcher);
      readySpy.should.have.been.calledOnce;
    });
  });
  describe('watch arrays of paths/globs', () => {
    it('should watch all paths in an array', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await fsp.mkdir(testDir);
      const watcher = cwatch([testDir, testPath], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await fsp.mkdir(testDir);
      const watcher = cwatch([[testDir], [testPath]] as unknown as string[], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should throw if provided any non-string paths', () => {
      expect(
        cwatch.bind(null, [[currentDir], /notastring/] as unknown as string[], options)
      ).to.throw(TypeError, /non-string/i);
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
          spy.should.have.been.calledTwice;
        });
        it('should emit `addDir` event for watched dir', async () => {
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(currentDir);
        });
        it('should emit `addDir` events for preexisting dirs', async () => {
          await fsp.mkdir(dpath('subdir'), PERM);
          await fsp.mkdir(dpath('subdir/subsub'), PERM);
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          spy.should.have.been.calledWith(currentDir);
          spy.should.have.been.calledWith(dpath('subdir'));
          spy.should.have.been.calledWith(dpath('subdir/subsub'));
          spy.should.have.been.calledThrice;
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
          spy.should.not.have.been.called;
        });
        it('should ignore add events on a subsequent .add()', async () => {
          const watcher = cwatch(dpath('subdir'), options);
          const spy = await aspy(watcher, EV.ADD);
          watcher.add(currentDir);
          await delay(1000);
          spy.should.not.have.been.called;
        });
        it('should notice when a file appears in an empty directory', async () => {
          const testDir = dpath('subdir');
          const testPath = dpath('subdir/add.txt');
          const spy = await aspy(cwatch(currentDir, options), EV.ADD);
          spy.should.not.have.been.called;
          await fsp.mkdir(testDir, PERM);
          await write(testPath, dateNow());
          await waitFor([spy]);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
        });
        it('should emit a change on a preexisting file as a change', async () => {
          const testPath = dpath('change.txt');
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          spy.should.not.have.been.called;
          await write(testPath, dateNow());
          await waitFor([spy.withArgs(EV.CHANGE, testPath)]);
          spy.should.have.been.calledWith(EV.CHANGE, testPath);
          spy.should.not.have.been.calledWith(EV.ADD);
        });
        it('should not emit for preexisting dirs when depth is 0', async () => {
          options.depth = 0;
          const testPath = dpath('add.txt');
          await fsp.mkdir(dpath('subdir'), PERM);

          await delay(200);
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          await write(testPath, dateNow());
          await waitFor([spy]);

          await delay(200);
          spy.should.have.been.calledWith(EV.ADD, testPath);
          spy.should.not.have.been.calledWith(EV.ADD_DIR);
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
        await fsp.mkdir(testDir, PERM);
        await write(sysPath.join(testDir, 'add.txt'), '');
        await fsp.mkdir(sysPath.join(testDir, 'subsub'), PERM);
        await write(sysPath.join(testDir, 'subsub', 'ab.txt'), '');
        const watcher = cwatch(testDir, options);
        const spy = await aspy(watcher, EV.ADD);
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith(sysPath.join(testDir, 'add.txt'));
      });
      it('should not choke on an ignored watch path', async () => {
        options.ignored = () => {
          return true;
        };
        await waitForWatcher(cwatch(currentDir, options));
      });
      it('should ignore the contents of ignored dirs', async () => {
        const testDir = dpath('subdir');
        const testFile = sysPath.join(testDir, 'add.txt');
        options.ignored = testDir;
        await fsp.mkdir(testDir, PERM);
        await write(testFile, 'b');
        const watcher = cwatch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);

        await delay();
        await write(testFile, dateNow());

        await delay(300);
        spy.should.not.have.been.calledWith(EV.ADD_DIR, testDir);
        spy.should.not.have.been.calledWith(EV.ADD, testFile);
        spy.should.not.have.been.calledWith(EV.CHANGE, testFile);
      });
      it('should allow regex/fn ignores', async () => {
        options.cwd = currentDir;
        options.ignored = /add/;

        await write(dpath('add.txt'), 'b');
        const watcher = cwatch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);

        await delay();
        await write(dpath('add.txt'), dateNow());
        await write(dpath('change.txt'), dateNow());

        await waitFor([spy.withArgs(EV.CHANGE, 'change.txt')]);
        spy.should.not.have.been.calledWith(EV.ADD, 'add.txt');
        spy.should.not.have.been.calledWith(EV.CHANGE, 'add.txt');
        spy.should.have.been.calledWith(EV.ADD, 'change.txt');
        spy.should.have.been.calledWith(EV.CHANGE, 'change.txt');
      });
    });
    describe('depth', () => {
      beforeEach(async () => {
        await fsp.mkdir(dpath('subdir'), PERM);
        await write(dpath('subdir/add.txt'), 'b');
        await delay();
        await fsp.mkdir(dpath('subdir/subsub'), PERM);
        await write(dpath('subdir/subsub/ab.txt'), 'b');
        await delay();
      });
      it('should not recurse if depth is 0', async () => {
        options.depth = 0;
        const watcher = cwatch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);
        await write(dpath('subdir/add.txt'), dateNow());
        await waitFor([[spy, 4]]);
        spy.should.have.been.calledWith(EV.ADD_DIR, currentDir);
        spy.should.have.been.calledWith(EV.ADD_DIR, dpath('subdir'));
        spy.should.have.been.calledWith(EV.ADD, dpath('change.txt'));
        spy.should.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
        spy.should.not.have.been.calledWith(EV.CHANGE);
        if (!macosFswatch) spy.callCount.should.equal(4);
      });
      it('should recurse to specified depth', async () => {
        options.depth = 1;
        const addPath = dpath('subdir/add.txt');
        const changePath = dpath('change.txt');
        const ignoredPath = dpath('subdir/subsub/ab.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await delay();
        await write(dpath('change.txt'), dateNow());
        await write(addPath, dateNow());
        await write(ignoredPath, dateNow());
        await waitFor([spy.withArgs(EV.CHANGE, addPath), spy.withArgs(EV.CHANGE, changePath)]);
        spy.should.have.been.calledWith(EV.ADD_DIR, dpath('subdir/subsub'));
        spy.should.have.been.calledWith(EV.CHANGE, changePath);
        spy.should.have.been.calledWith(EV.CHANGE, addPath);
        spy.should.not.have.been.calledWith(EV.ADD, ignoredPath);
        spy.should.not.have.been.calledWith(EV.CHANGE, ignoredPath);
        if (!macosFswatch) spy.callCount.should.equal(8);
      });
      it('should respect depth setting when following symlinks', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        await fsp.symlink(dpath('subdir'), dpath('link'), isWindows ? 'dir' : null);
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        spy.should.have.been.calledWith(EV.ADD_DIR, dpath('link'));
        spy.should.have.been.calledWith(EV.ADD_DIR, dpath('link/subsub'));
        spy.should.have.been.calledWith(EV.ADD, dpath('link/add.txt'));
        spy.should.not.have.been.calledWith(EV.ADD, dpath('link/subsub/ab.txt'));
      });
      it('should respect depth setting when following a new symlink', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        const linkPath = dpath('link');
        const dirPath = dpath('link/subsub');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await fsp.symlink(dpath('subdir'), linkPath, isWindows ? 'dir' : null);
        await waitFor([[spy, 3], spy.withArgs(EV.ADD_DIR, dirPath)]);
        spy.should.have.been.calledWith(EV.ADD_DIR, linkPath);
        spy.should.have.been.calledWith(EV.ADD_DIR, dirPath);
        spy.should.have.been.calledWith(EV.ADD, dpath('link/add.txt'));
        spy.should.have.been.calledThrice;
      });
      it('should correctly handle dir events when depth is 0', async () => {
        options.depth = 0;
        const subdir2 = dpath('subdir2');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        const addSpy = spy.withArgs(EV.ADD_DIR);
        const unlinkSpy = spy.withArgs(EV.UNLINK_DIR);
        spy.should.have.been.calledWith(EV.ADD_DIR, currentDir);
        spy.should.have.been.calledWith(EV.ADD_DIR, dpath('subdir'));
        await fsp.mkdir(subdir2, PERM);
        await waitFor([[addSpy, 3]]);
        addSpy.should.have.been.calledThrice;

        await fsp.rmdir(subdir2);
        await waitFor([unlinkSpy]);
        await delay();
        unlinkSpy.should.have.been.calledWith(EV.UNLINK_DIR, subdir2);
        unlinkSpy.should.have.been.calledOnce;
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
        await fsp.unlink(dpath('.change.txt.swp'));
        await fsp.unlink(dpath('add.txt~'));
        await fsp.unlink(dpath('.subl5f4.tmp'));
        await delay(300);
        spy.should.not.have.been.called;
      });
      it('should ignore stale tilde files', async () => {
        options.ignoreInitial = false;
        await write(dpath('old.txt~'), 'a');
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        spy.should.not.have.been.calledWith(dpath('old.txt'));
        spy.should.not.have.been.calledWith(dpath('old.txt~'));
      });
    });
    describe('cwd', () => {
      it('should emit relative paths based on cwd', async () => {
        options.cwd = currentDir;
        const watcher = cwatch('.', options);
        const spy = await aspy(watcher, EV.ALL);
        await fsp.unlink(dpath('unlink.txt'));
        await write(dpath('change.txt'), dateNow());
        await waitFor([spy.withArgs(EV.UNLINK)]);
        spy.should.have.been.calledWith(EV.ADD, 'change.txt');
        spy.should.have.been.calledWith(EV.ADD, 'unlink.txt');
        spy.should.have.been.calledWith(EV.CHANGE, 'change.txt');
        spy.should.have.been.calledWith(EV.UNLINK, 'unlink.txt');
      });
      it('should emit `addDir` with alwaysStat for renamed directory', async () => {
        options.cwd = currentDir;
        options.alwaysStat = true;
        options.ignoreInitial = true;
        const spy = sinon.spy();
        const testDir = dpath('subdir');
        const renamedDir = dpath('subdir-renamed');

        await fsp.mkdir(testDir, PERM);
        const watcher = cwatch('.', options);

        await new Promise<void>((resolve) => {
          setTimeout(async () => {
            watcher.on(EV.ADD_DIR, spy);
            await fsp.rename(testDir, renamedDir);
            resolve();
          }, 1000);
        });

        await waitFor([spy]);
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith('subdir-renamed');
        expect(spy.args[0][1]).to.be.ok; // stats
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
        const watcherEvents = waitForEvents(watcher, 3);
        const spy1 = await aspy(watcher, EV.ALL);

        await delay();
        const watcher2 = cwatch(currentDir, options2);
        const watcher2Events = waitForEvents(watcher2, 5);
        const spy2 = await aspy(watcher2, EV.ALL);

        await fsp.unlink(dpath('unlink.txt'));
        await write(dpath('change.txt'), dateNow());
        await Promise.all([watcherEvents, watcher2Events]);
        spy1.should.have.been.calledWith(EV.CHANGE, 'change.txt');
        spy1.should.have.been.calledWith(EV.UNLINK, 'unlink.txt');
        spy2.should.have.been.calledWith(EV.ADD, sysPath.join('..', 'change.txt'));
        spy2.should.have.been.calledWith(EV.ADD, sysPath.join('..', 'unlink.txt'));
        spy2.should.have.been.calledWith(EV.CHANGE, sysPath.join('..', 'change.txt'));
        spy2.should.have.been.calledWith(EV.UNLINK, sysPath.join('..', 'unlink.txt'));
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
        await write(dpath('ignored.txt'), dateNow());
        await write(dpath('ignored-option.txt'), dateNow());
        await fsp.unlink(dpath('ignored.txt'));
        await fsp.unlink(dpath('ignored-option.txt'));
        await delay();
        await write(dpath('change.txt'), EV.CHANGE);
        await waitFor([spy.withArgs(EV.CHANGE, 'change.txt')]);
        spy.should.have.been.calledWith(EV.ADD, 'change.txt');
        spy.should.not.have.been.calledWith(EV.ADD, 'ignored.txt');
        spy.should.not.have.been.calledWith(EV.ADD, 'ignored-option.txt');
        spy.should.not.have.been.calledWith(EV.CHANGE, 'ignored.txt');
        spy.should.not.have.been.calledWith(EV.CHANGE, 'ignored-option.txt');
        spy.should.not.have.been.calledWith(EV.UNLINK, 'ignored.txt');
        spy.should.not.have.been.calledWith(EV.UNLINK, 'ignored-option.txt');
        spy.should.have.been.calledWith(EV.CHANGE, 'change.txt');
      });
    });
    describe('ignorePermissionErrors', () => {
      let filePath: string;
      beforeEach(async () => {
        filePath = dpath('add.txt');
        await write(filePath, 'b', { mode: 128 });
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
          spy.should.not.have.been.calledWith(EV.ADD, filePath);
          await write(filePath, dateNow());

          await delay(200);
          spy.should.not.have.been.calledWith(EV.CHANGE, filePath);
        });
      });
      describe('true', () => {
        beforeEach(() => {
          options.ignorePermissionErrors = true;
        });
        it('should watch unreadable files if possible', async () => {
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          spy.should.have.been.calledWith(EV.ADD, filePath);
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
        expect((watcher.options.awaitWriteFinish as chokidar.AWF).pollInterval).to.equal(100);
        expect((watcher.options.awaitWriteFinish as chokidar.AWF).stabilityThreshold).to.equal(
          2000
        );
      });
      it('should not emit add event before a file is fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(200);
        spy.should.not.have.been.calledWith(EV.ADD);
      });
      it('should wait for the file to be fully written before emitting the add event', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.ADD, testPath);
      });
      it('should emit with the final stats', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello ');

        await delay(300);
        fs.appendFileSync(testPath, 'world!');

        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.ADD, testPath);
        expect(spy.args[0][2].size).to.equal(12);
      });
      it('should not emit change event while a file has not been fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(100);
        await write(testPath, 'edit');
        await delay(200);
        spy.should.not.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should not emit change event before an existing file is fully updated', async () => {
        const testPath = dpath('change.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(300);
        spy.should.not.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should wait for an existing file to be fully updated before emitting the change event', async () => {
        const testPath = dpath('change.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        fs.writeFile(testPath, 'hello', () => {});

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should emit change event after the file is fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await delay();
        await write(testPath, 'hello');

        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.ADD, testPath);
        await write(testPath, 'edit');
        await waitFor([spy.withArgs(EV.CHANGE)]);
        spy.should.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should not raise any event for a file that was deleted before fully written', async () => {
        const testPath = dpath('add.txt');
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'hello');
        await delay(400);
        await fsp.unlink(testPath);
        await delay(400);
        spy.should.not.have.been.calledWith(sinon.match.string, testPath);
      });
      it('should be compatible with the cwd option', async () => {
        const testPath = dpath('subdir/add.txt');
        const filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        await fsp.mkdir(options.cwd);

        await delay(200);
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);

        await delay(400);
        await write(testPath, 'hello');

        await waitFor([spy.withArgs(EV.ADD)]);
        spy.should.have.been.calledWith(EV.ADD, filename);
      });
      it('should still emit initial add events', async () => {
        options.ignoreInitial = false;
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        spy.should.have.been.calledWith(EV.ADD);
        spy.should.have.been.calledWith(EV.ADD_DIR);
      });
      it('should emit an unlink event when a file is updated and deleted just after that', async () => {
        const testPath = dpath('subdir/add.txt');
        const filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        await fsp.mkdir(options.cwd);
        await delay();
        await write(testPath, 'hello');
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'edit');
        await delay();
        await fsp.unlink(testPath);
        await waitFor([spy.withArgs(EV.UNLINK)]);
        spy.should.have.been.calledWith(EV.UNLINK, filename);
        spy.should.not.have.been.calledWith(EV.CHANGE, filename);
      });
    });
  });
  describe('getWatched', () => {
    it('should return the watched paths', async () => {
      const expected: Record<string, string[]> = {};
      expected[sysPath.dirname(currentDir)] = [testId.toString()];
      expected[currentDir] = ['change.txt', 'unlink.txt'];
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
    it('should set keys relative to cwd & include added paths', async () => {
      options.cwd = currentDir;
      const expected = {
        '.': ['change.txt', 'subdir', 'unlink.txt'],
        '..': [testId.toString()],
        subdir: [],
      };
      await fsp.mkdir(dpath('subdir'), PERM);
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
  });
  describe('unwatch', () => {
    beforeEach(async () => {
      options.ignoreInitial = true;
      await fsp.mkdir(dpath('subdir'), PERM);
      await delay();
    });
    it('should stop watching unwatched paths', async () => {
      const watchPaths = [dpath('subdir'), dpath('change.txt')];
      const watcher = cwatch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      watcher.unwatch(dpath('subdir'));

      await delay();
      await write(dpath('subdir/add.txt'), dateNow());
      await write(dpath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV.CHANGE, dpath('change.txt'));
      spy.should.not.have.been.calledWith(EV.ADD);
      if (!macosFswatch) spy.should.have.been.calledOnce;
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
      await fsp.unlink(unlinkFile);
      await write(addFile, dateNow());
      await write(changedFile, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);

      await delay(300);
      spy.should.have.been.calledWith(EV.CHANGE, changedFile);
      spy.should.not.have.been.calledWith(EV.ADD, addFile);
      spy.should.not.have.been.calledWith(EV.UNLINK, unlinkFile);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch relative paths', async () => {
      const fixturesDir = sysPath.relative(process.cwd(), currentDir);
      const subdir = sysPath.join(fixturesDir, 'subdir');
      const changeFile = sysPath.join(fixturesDir, 'change.txt');
      const watchPaths = [subdir, changeFile];
      const watcher = cwatch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      watcher.unwatch(subdir);
      await write(dpath('subdir/add.txt'), dateNow());
      await write(dpath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV.CHANGE, changeFile);
      spy.should.not.have.been.calledWith(EV.ADD);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it.skip('should watch paths that were unwatched and added again', async () => {
      const spy = sinon.spy();
      const watchPaths = [dpath('change.txt')];
      console.log('watching', watchPaths);
      const watcher = cwatch(watchPaths, options).on(EV.ALL, console.log.bind(console));
      await waitForWatcher(watcher);
      await delay();
      watcher.unwatch(dpath('change.txt'));
      await delay();
      watcher.on(EV.ALL, spy).add(dpath('change.txt'));

      await delay();
      await write(dpath('change.txt'), dateNow());
      console.log('a');
      await waitFor([spy]);
      console.log('b');
      spy.should.have.been.calledWith(EV.CHANGE, dpath('change.txt'));
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch paths that are relative to options.cwd', async () => {
      options.cwd = currentDir;
      const watcher = cwatch('.', options);
      const spy = await aspy(watcher, EV.ALL);
      watcher.unwatch(['subdir', dpath('unlink.txt')]);

      await delay();
      await fsp.unlink(dpath('unlink.txt'));
      await write(dpath('subdir/add.txt'), dateNow());
      await write(dpath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV.CHANGE, 'change.txt');
      spy.should.not.have.been.calledWith(EV.ADD);
      spy.should.not.have.been.calledWith(EV.UNLINK);
      if (!macosFswatch) spy.should.have.been.calledOnce;
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
        watcher.options.usePolling.should.be.true;
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to 1', async () => {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = '1';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to false', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.false;
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to 0', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.false;
      });

      it('should not attenuate options.usePolling when CHOKIDAR_USEPOLLING is set to an arbitrary value', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'foo';

        const watcher = cwatch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
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
          watcher.options.interval.should.be.equal(1500);
        });
      });
    }
  });
  describe('reproduction of bug in issue #1040', () => {
    it('should detect change on symlink folders when consolidateThreshhold is reached', async () => {
      const CURR = sysPath.join(FIXTURES_PATH, testId.toString());
      const fixturesPathRel = sysPath.join(CURR, 'test-case-1040');
      const linkPath = sysPath.join(fixturesPathRel, 'symlinkFolder');
      const packagesPath = sysPath.join(fixturesPathRel, 'packages');
      await fsp.mkdir(fixturesPathRel, { recursive: true });
      await fsp.mkdir(linkPath);
      await fsp.mkdir(packagesPath);

      // Init chokidar
      const watcher = cwatch([]);

      // Add more than 10 folders to cap consolidateThreshhold
      for (let i = 0; i < 20; i += 1) {
        const folderPath = sysPath.join(packagesPath, `folder${i}`);
        await fsp.mkdir(folderPath);
        const filePath = sysPath.join(folderPath, `file${i}.js`);
        await write(sysPath.resolve(filePath), 'file content');
        const symlinkPath = sysPath.join(linkPath, `folder${i}`);
        await fsp.symlink(sysPath.resolve(folderPath), symlinkPath, isWindows ? 'dir' : null);
        watcher.add(sysPath.resolve(sysPath.join(symlinkPath, `file${i}.js`)));
      }

      // Wait to be sure that we have no other event than the update file
      await delay(300);

      const eventsWaiter = waitForEvents(watcher, 1);

      // Update a random generated file to fire an event
      const randomFilePath = sysPath.join(packagesPath, 'folder17', 'file17.js');
      await write(sysPath.resolve(randomFilePath), 'file content changer zeri ezhriez');

      // Wait chokidar watch
      await delay(300);

      const events = await eventsWaiter;

      expect(events.length).to.equal(1);
    });
  });
  describe('reproduction of bug in issue #1024', () => {
    it('should detect changes to folders, even if they were deleted before', async () => {
      const id = testId.toString();
      const absoluteWatchedDir = sysPath.join(FIXTURES_PATH, id, 'test');
      const relativeWatcherDir = sysPath.join(id, 'test');
      const watcher = cwatch(relativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = sysPath.join(absoluteWatchedDir, 'dir');
        const testSubDirFile = sysPath.join(absoluteWatchedDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await fsp.mkdir(absoluteWatchedDir);
        await fsp.mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rmdir will be equalize
        await delay(300);
        await fsp.rmdir(testSubDir);
        // The following delay is essential otherwise the call of rmdir and mkdir will be equalize
        await delay(300);
        await fsp.mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        chai.assert.deepStrictEqual(events, [
          `[ALL] addDir: ${sysPath.join(id, 'test')}`,
          `[ALL] addDir: ${sysPath.join(id, 'test', 'dir')}`,
          `[ALL] unlinkDir: ${sysPath.join(id, 'test', 'dir')}`,
          `[ALL] addDir: ${sysPath.join(id, 'test', 'dir')}`,
          `[ALL] add: ${sysPath.join(id, 'test', 'dir', 'file')}`,
        ]);
      } finally {
        watcher.close();
      }
    });

    it('should detect changes to symlink folders, even if they were deleted before', async () => {
      const id = testId.toString();
      const relativeWatcherDir = sysPath.join(id, 'test');
      const linkedRelativeWatcherDir = sysPath.join(id, 'test-link');
      await fsp.symlink(
        sysPath.resolve(relativeWatcherDir),
        linkedRelativeWatcherDir,
        isWindows ? 'dir' : null
      );
      await delay();
      const watcher = cwatch(linkedRelativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = sysPath.join(relativeWatcherDir, 'dir');
        const testSubDirFile = sysPath.join(relativeWatcherDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await fsp.mkdir(relativeWatcherDir);
        await fsp.mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rmdir will be equalize
        await delay(300);
        await fsp.rmdir(testSubDir);
        // The following delay is essential otherwise the call of rmdir and mkdir will be equalize
        await delay(300);
        await fsp.mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        chai.assert.deepStrictEqual(events, [
          `[ALL] addDir: ${sysPath.join(id, 'test-link')}`,
          `[ALL] addDir: ${sysPath.join(id, 'test-link', 'dir')}`,
          `[ALL] unlinkDir: ${sysPath.join(id, 'test-link', 'dir')}`,
          `[ALL] addDir: ${sysPath.join(id, 'test-link', 'dir')}`,
          `[ALL] add: ${sysPath.join(id, 'test-link', 'dir', 'file')}`,
        ]);
      } finally {
        watcher.close();
      }
    });
  });

  describe('close', () => {
    it('should ignore further events on close', async () => {
      const spy = sinon.spy();
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);

      watcher.on(EV.ALL, spy);
      await watcher.close();

      await write(dpath('add.txt'), dateNow());
      await write(dpath('add.txt'), 'hello');
      await delay(300);
      await fsp.unlink(dpath('add.txt'));

      spy.should.not.have.been.called;
    });
    it('should not ignore further events on close with existing watchers', async () => {
      const spy = sinon.spy();
      const watcher1 = cwatch(currentDir);
      const watcher2 = cwatch(currentDir);
      await Promise.all([waitForWatcher(watcher1), waitForWatcher(watcher2)]);

      // The EV_ADD event should be called on the second watcher even if the first watcher is closed
      watcher2.on(EV.ADD, spy);
      await watcher1.close();

      await write(dpath('add.txt'), 'hello');
      // Ensures EV_ADD is called. Immediately removing the file causes it to be skipped
      await delay(200);
      await fsp.unlink(dpath('add.txt'));

      spy.should.have.been.calledWith(sinon.match('add.txt'));
    });
    it('should not prevent the process from exiting', async () => {
      const scriptFile = dpath('script.js');
      const chokidarPath = pathToFileURL(sysPath.join(__dirname, 'esm/index.js')).href.replace(
        /\\/g,
        '\\\\'
      );
      const scriptContent = `
      (async () => {
        const chokidar = await import("${chokidarPath}");
        const watcher = chokidar.watch("${scriptFile.replace(/\\/g, '\\\\')}");
        watcher.on("ready", () => {
          watcher.close();
          process.stdout.write("closed");
        });
      })();`;
      await write(scriptFile, scriptContent);
      const obj = await exec(`node ${scriptFile}`);
      const { stdout } = obj;
      expect(stdout.toString()).to.equal('closed');
    });
    it('should always return the same promise', async () => {
      const watcher = cwatch(currentDir, options);
      const closePromise = watcher.close();
      expect(closePromise).to.be.a('promise');
      expect(watcher.close()).to.be.equal(closePromise);
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
    await rm(currentDir, { recursive: true });
  });

  it('should expose public API methods', () => {
    chokidar.FSWatcher.should.be.a('function');
    chokidar.watch.should.be.a('function');
  });

  if (!isIBMi) {
    describe('fs.watch (non-polling)', runTests.bind(this, { usePolling: false }));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, { usePolling: true, interval: 10 }));
});
async function main() {
  try {
    await rm(FIXTURES_PATH, { recursive: true, force: true });
    await fsp.mkdir(FIXTURES_PATH, { recursive: true, mode: PERM });
  } catch (error) {}
  process.chdir(FIXTURES_PATH);
  // Create many directories before tests.
  // Creating them in `beforeEach` increases chance of random failures.
  const _content = await read(__filename, 'utf-8');
  const _only = _content.match(/\sit\.only\(/g);
  const itCount = (_only && _only.length) || _content.match(/\sit\(/g)?.length;
  const testCount = (itCount ?? 0) * 3;
  while (testId++ < testCount) {
    await fsp.mkdir(dpath(''), PERM);
    await write(dpath('change.txt'), 'b');
    await write(dpath('unlink.txt'), 'b');
  }
  testId = 0;

  await it.run(true);

  try {
    await rm(FIXTURES_PATH, { recursive: true, force: true });
  } catch (error) {}
  process.chdir(initialPath);
}
main();
