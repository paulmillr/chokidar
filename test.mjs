import fs from 'node:fs';
import sysPath from 'node:path';
import {describe, it, before, after, beforeEach, afterEach} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import childProcess from 'node:child_process';
import chai from 'chai';
import {rimraf} from 'rimraf';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import upath from 'upath';

import chokidar from './lib/index.js';
import * as EV from './lib/events.js';
import { isWindows, isMacos, isIBMi } from './lib/constants.js';

import { URL } from 'url'; // in Browser, the URL in native accessible on window

const __filename = fileURLToPath(new URL('', import.meta.url));
// Will contain trailing slash
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const {expect} = chai;
chai.use(sinonChai);
chai.should();

const exec = promisify(childProcess.exec);
const write = promisify(fs.writeFile);
const fs_symlink = promisify(fs.symlink);
const fs_rename = promisify(fs.rename);
const fs_mkdir = promisify(fs.mkdir);
const fs_rmdir = promisify(fs.rmdir);
const fs_unlink = promisify(fs.unlink);

const FIXTURES_PATH_REL = 'test-fixtures';
const FIXTURES_PATH = sysPath.join(__dirname, FIXTURES_PATH_REL);
const allWatchers = [];
const PERM_ARR = 0o755; // rwe, r+e, r+e
const TEST_TIMEOUT = 8000;
let subdirId = 0;
let options;
let currentDir;
let slowerDelay;

// spyOnReady
const aspy = (watcher, eventName, spy = null, noStat = false) => {
  if (typeof eventName !== 'string') {
    throw new TypeError('aspy: eventName must be a String');
  }
  if (spy == null) spy = sinon.spy();
  return new Promise((resolve, reject) => {
    const handler = noStat ?
      (eventName === EV.ALL ?
      (event, path) => spy(event, path) :
      (path) => spy(path)) :
      spy;
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
    watcher.on(eventName, handler);
  });
};

const waitForWatcher = (watcher) => {
  return new Promise((resolve, reject) => {
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

const delay = async (time) => {
  return new Promise((resolve) => {
    const timer = time || slowerDelay || 20;
    setTimeout(resolve, timer);
  });
};

const getFixturePath = (subPath) => {
  const subd = subdirId && subdirId.toString() || '';
  return sysPath.join(FIXTURES_PATH, subd, subPath);
};
const getGlobPath = (subPath) => {
  const subd = subdirId && subdirId.toString() || '';
  return upath.join(FIXTURES_PATH, subd, subPath);
};
currentDir = getFixturePath('');

const chokidar_watch = (path = currentDir, opts = options) => {
  const wt = chokidar.watch(path, opts);
  allWatchers.push(wt);
  return wt;
};

const waitFor = async (spies) => {
  if (spies.length === 0) throw new TypeError('SPies zero');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout'));
    }, TEST_TIMEOUT);
    const isSpyReady = (spy) => {
      if (Array.isArray(spy)) {
        return spy[0].callCount >= spy[1];
      }
      return spy.callCount >= 1;
    };
    const checkSpiesReady = () => {
      if (spies.every(isSpyReady)) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(checkSpiesReady, 20);
      }
    };
    checkSpiesReady();
  });
};

const waitForEvents = (watcher, count) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout'));
    }, TEST_TIMEOUT);
    const events = [];
    const handler = (event, path) => {
      events.push(`[ALL] ${event}: ${path}`)

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

const runTests = (baseopts) => {
  let macosFswatch;
  let win32Polling;

  baseopts.persistent = true;

  before(() => {
    // flags for bypassing special-case test failures on CI
    macosFswatch = isMacos && !baseopts.usePolling;
    win32Polling = isWindows && baseopts.usePolling;
    slowerDelay = macosFswatch ? 100 : undefined;
  });

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach((key) => {
      options[key] = baseopts[key];
    });
  });

  describe('watch a directory', () => {
    let readySpy, rawSpy, watcher, watcher2;
    beforeEach(async () => {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = sinon.spy(function readySpy(){});
      rawSpy = sinon.spy(function rawSpy(){});
      watcher = chokidar_watch().on(EV.READY, readySpy).on(EV.RAW, rawSpy);
      await waitForWatcher(watcher);
    });
    afterEach(async () => {
      await waitFor([readySpy]);
      await watcher.close();
      readySpy.should.have.been.calledOnce;
      readySpy = undefined;
      rawSpy = undefined;
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
      const testPath = getFixturePath('add.txt');
      const spy = sinon.spy(function addSpy(){});
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
        paths.push(getFixturePath(`add${i}.txt`));
      }

      const spy = sinon.spy();
      watcher.on(EV.ADD, (path) => {
        spy(path);
      });

      write(paths[0], dateNow());
      write(paths[1], dateNow());
      write(paths[2], dateNow());
      write(paths[3], dateNow());
      write(paths[4], dateNow());
      await delay(100);

      write(paths[5], dateNow());
      write(paths[6], dateNow());

      await delay(150);
      write(paths[7], dateNow());
      write(paths[8], dateNow());

      await waitFor([[spy, 4]]);

      await delay(1000);
      await waitFor([[spy, 9]]);
      paths.forEach(path => {
        spy.should.have.been.calledWith(path);
      });
    });
    it('should emit thirtythree `add` events when thirtythree files were added in nine directories', async () => {
      await watcher.close();

      const test1Path = getFixturePath('add1.txt');
      const testb1Path = getFixturePath('b/add1.txt');
      const testc1Path = getFixturePath('c/add1.txt');
      const testd1Path = getFixturePath('d/add1.txt');
      const teste1Path = getFixturePath('e/add1.txt');
      const testf1Path = getFixturePath('f/add1.txt');
      const testg1Path = getFixturePath('g/add1.txt');
      const testh1Path = getFixturePath('h/add1.txt');
      const testi1Path = getFixturePath('i/add1.txt');
      const test2Path = getFixturePath('add2.txt');
      const testb2Path = getFixturePath('b/add2.txt');
      const testc2Path = getFixturePath('c/add2.txt');
      const test3Path = getFixturePath('add3.txt');
      const testb3Path = getFixturePath('b/add3.txt');
      const testc3Path = getFixturePath('c/add3.txt');
      const test4Path = getFixturePath('add4.txt');
      const testb4Path = getFixturePath('b/add4.txt');
      const testc4Path = getFixturePath('c/add4.txt');
      const test5Path = getFixturePath('add5.txt');
      const testb5Path = getFixturePath('b/add5.txt');
      const testc5Path = getFixturePath('c/add5.txt');
      const test6Path = getFixturePath('add6.txt');
      const testb6Path = getFixturePath('b/add6.txt');
      const testc6Path = getFixturePath('c/add6.txt');
      const test7Path = getFixturePath('add7.txt');
      const testb7Path = getFixturePath('b/add7.txt');
      const testc7Path = getFixturePath('c/add7.txt');
      const test8Path = getFixturePath('add8.txt');
      const testb8Path = getFixturePath('b/add8.txt');
      const testc8Path = getFixturePath('c/add8.txt');
      const test9Path = getFixturePath('add9.txt');
      const testb9Path = getFixturePath('b/add9.txt');
      const testc9Path = getFixturePath('c/add9.txt');
      fs.mkdirSync(getFixturePath('b'), PERM_ARR);
      fs.mkdirSync(getFixturePath('c'), PERM_ARR);
      fs.mkdirSync(getFixturePath('d'), PERM_ARR);
      fs.mkdirSync(getFixturePath('e'), PERM_ARR);
      fs.mkdirSync(getFixturePath('f'), PERM_ARR);
      fs.mkdirSync(getFixturePath('g'), PERM_ARR);
      fs.mkdirSync(getFixturePath('h'), PERM_ARR);
      fs.mkdirSync(getFixturePath('i'), PERM_ARR);

      await delay();

      readySpy.resetHistory();
      watcher2 = chokidar_watch().on(EV.READY, readySpy).on(EV.RAW, rawSpy);
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
        testi1Path
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
      const testDir = getFixturePath('subdir');
      const spy = sinon.spy(function addDirSpy(){});
      watcher.on(EV.ADD_DIR, spy);
      spy.should.not.have.been.called;
      await fs_mkdir(testDir, PERM_ARR);
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testDir);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should emit `change` event when file was changed', async () => {
      const testPath = getFixturePath('change.txt');
      const spy = sinon.spy(function changeSpy(){});
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
      const testPath = getFixturePath('unlink.txt');
      const spy = sinon.spy(function unlinkSpy(){});
      watcher.on(EV.UNLINK, spy);
      spy.should.not.have.been.called;
      await fs_unlink(testPath);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit `unlinkDir` event when a directory was removed', async () => {
      const testDir = getFixturePath('subdir');
      const spy = sinon.spy(function unlinkDirSpy(){});

      await fs_mkdir(testDir, PERM_ARR);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, spy);

      await fs_rmdir(testDir);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testDir);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit two `unlinkDir` event when two nested directories were removed', async () => {
      const testDir = getFixturePath('subdir');
      const testDir2 = getFixturePath('subdir/subdir2');
      const testDir3 = getFixturePath('subdir/subdir2/subdir3');
      const spy = sinon.spy(function unlinkDirSpy(){});

      await fs_mkdir(testDir, PERM_ARR);
      await fs_mkdir(testDir2, PERM_ARR);
      await fs_mkdir(testDir3, PERM_ARR);
      await delay(300);

      watcher.on(EV.UNLINK_DIR, spy);

      await rimraf(testDir2);
      await waitFor([[spy, 2]]);

      spy.should.have.been.calledWith(testDir2);
      spy.should.have.been.calledWith(testDir3);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledTwice;
    });
    it('should emit `unlink` and `add` events when a file is renamed', async () => {
      const unlinkSpy = sinon.spy(function unlink(){});
      const addSpy = sinon.spy(function add(){});
      const testPath = getFixturePath('change.txt');
      const newPath = getFixturePath('moved.txt');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy);
      unlinkSpy.should.not.have.been.called;
      addSpy.should.not.have.been.called;

      await delay();
      await fs_rename(testPath, newPath);
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
      const unlinkSpy = sinon.spy(function unlink(){});
      const addSpy = sinon.spy(function add(){});
      const changeSpy = sinon.spy(function change(){});
      const testPath = getFixturePath('add.txt');
      watcher
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy)
        .on(EV.CHANGE, changeSpy);
      await write(testPath, 'hello');
      await waitFor([[addSpy.withArgs(testPath), 1]]);
      unlinkSpy.should.not.have.been.called;
      changeSpy.should.not.have.been.called;
      await fs_unlink(testPath);
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
      const unlinkSpy = sinon.spy(function unlink(){});
      const testPath = getFixturePath('change.txt');
      const newPath1 = getFixturePath('moved.txt');
      const newPath2 = getFixturePath('moved-again.txt');
      watcher.on(EV.UNLINK, unlinkSpy);
      await fs_rename(testPath, newPath1);

      await delay(300);
      await fs_rename(newPath1, newPath2);
      await waitFor([unlinkSpy.withArgs(newPath1)]);
      unlinkSpy.withArgs(testPath).should.have.been.calledOnce;
      unlinkSpy.withArgs(newPath1).should.have.been.calledOnce;
      unlinkSpy.withArgs(newPath2).should.not.have.been.called;
    });
    it('should survive ENOENT for missing subdirectories', async () => {
      const testDir = getFixturePath('notadir');
      watcher.add(testDir);
    });
    it('should notice when a file appears in a new directory', async () => {
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      const spy = sinon.spy(function addSpy(){});
      watcher.on(EV.ADD, spy);
      spy.should.not.have.been.called;
      await fs_mkdir(testDir, PERM_ARR);
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should watch removed and re-added directories', async () => {
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const parentPath = getFixturePath('subdir2');
      const subPath = getFixturePath('subdir2/subsub');
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD_DIR, addSpy);
      await fs_mkdir(parentPath, PERM_ARR);

      await delay(win32Polling ? 900 : 300);
      await fs_rmdir(parentPath);
      await waitFor([unlinkSpy.withArgs(parentPath)]);
      unlinkSpy.should.have.been.calledWith(parentPath);
      await fs_mkdir(parentPath, PERM_ARR);

      await delay(win32Polling ? 2200 : 1200);
      await fs_mkdir(subPath, PERM_ARR);
      await waitFor([[addSpy, 3]]);
      addSpy.should.have.been.calledWith(parentPath);
      addSpy.should.have.been.calledWith(subPath);
    });
    it('should emit `unlinkDir` and `add` when dir is replaced by file', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = getFixturePath('dirFile');
      await fs_mkdir(testPath, PERM_ARR);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD, addSpy);

      await fs_rmdir(testPath);
      await waitFor([unlinkSpy]);

      await write(testPath, 'file content');
      await waitFor([addSpy]);

      unlinkSpy.should.have.been.calledWith(testPath);
      addSpy.should.have.been.calledWith(testPath);
    });
    it('should emit `unlink` and `addDir` when file is replaced by dir', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = getFixturePath('fileDir');
      await write(testPath, 'file content');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD_DIR, addSpy);

      await delay(300);
      await fs_unlink(testPath);
      await delay(300);
      await fs_mkdir(testPath, PERM_ARR);

      await waitFor([addSpy, unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);
      addSpy.should.have.been.calledWith(testPath);
    });
  });
  describe('watch individual files', () => {
    it('should emit `ready` when three files were added', async () => {
      const readySpy = sinon.spy(function readySpy(){});
      const watcher = chokidar_watch().on(EV.READY, readySpy);
      const path1 = getFixturePath('add1.txt');
      const path2 = getFixturePath('add2.txt');
      const path3 = getFixturePath('add3.txt');

      watcher.add(path1);
      watcher.add(path2);
      watcher.add(path3);

      await waitForWatcher(watcher);
      // callCount is 1 on macOS, 4 on Ubuntu
      readySpy.callCount.should.be.greaterThanOrEqual(1);
    });
    it('should detect changes', async () => {
      const testPath = getFixturePath('change.txt');
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV.CHANGE);
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(testPath);
    });
    it('should detect unlinks', async () => {
      const testPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV.UNLINK);

      await delay();
      await fs_unlink(testPath);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should detect unlink and re-add', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch([testPath], options)
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      await delay();
      await fs_unlink(testPath);
      await waitFor([unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);

      await delay();
      await write(testPath, 're-added');
      await waitFor([addSpy]);
      addSpy.should.have.been.calledWith(testPath);
    });

    it('should ignore unwatched siblings', async () => {
      const testPath = getFixturePath('add.txt');
      const siblingPath = getFixturePath('change.txt');
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(siblingPath, dateNow());
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(EV.ADD, testPath);
    });

    it('should detect safe-edit', async () => {
      const testPath = getFixturePath('change.txt');
      const safePath = getFixturePath('tmp.txt');
      await write(testPath, dateNow());
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(safePath, dateNow());
      await fs_rename(safePath, testPath);
      await delay(300);
      await write(safePath, dateNow());
      await fs_rename(safePath, testPath);
      await delay(300);
      await write(safePath, dateNow());
      await fs_rename(safePath, testPath);
      await delay(300);
      await waitFor([spy]);
      spy.withArgs(EV.CHANGE, testPath).should.have.been.calledThrice;
    });


    // PR 682 is failing.
    describe.skip('Skipping gh-682: should detect unlink', () => {
      it('should detect unlink while watching a non-existent second file in another directory', async () => {
        const testPath = getFixturePath('unlink.txt');
        const otherDirPath = getFixturePath('other-dir');
        const otherPath = getFixturePath('other-dir/other.txt');
        fs.mkdirSync(otherDirPath, PERM_ARR);
        const watcher = chokidar_watch([testPath, otherPath], options);
        // intentionally for this test don't write fs.writeFileSync(otherPath, 'other');
        const spy = await aspy(watcher, EV.UNLINK);

        await delay();
        await fs_unlink(testPath);
        await waitFor([spy]);
        spy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a second file', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy(){});
        const addSpy = sinon.spy(function addSpy(){});
        const testPath = getFixturePath('unlink.txt');
        const otherPath = getFixturePath('other.txt');
        fs.writeFileSync(otherPath, 'other');
        const watcher = chokidar_watch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fs_unlink(testPath);
        await waitFor([unlinkSpy]);

        await delay();
        unlinkSpy.should.have.been.calledWith(testPath);

        await delay();
        write(testPath, 're-added');
        await waitFor([addSpy]);
        addSpy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a non-existent second file in another directory', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy(){});
        const addSpy = sinon.spy(function addSpy(){});
        const testPath = getFixturePath('unlink.txt');
        const otherDirPath = getFixturePath('other-dir');
        const otherPath = getFixturePath('other-dir/other.txt');
        fs.mkdirSync(otherDirPath, PERM_ARR);
        // intentionally for this test don't write fs.writeFileSync(otherPath, 'other');
        const watcher = chokidar_watch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fs_unlink(testPath);
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
        const unlinkSpy = sinon.spy(function unlinkSpy(){});
        const addSpy = sinon.spy(function addSpy(){});
        const testPath = getFixturePath('unlink.txt');
        const otherPath = getFixturePath('other.txt');
        // intentionally for this test don't write fs.writeFileSync(otherPath, 'other');
        const watcher = chokidar_watch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fs_unlink(testPath);
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
        const unlinkSpy = sinon.spy(function unlinkSpy(){});
        const addSpy = sinon.spy(function addSpy(){});
        const testPath = getFixturePath('unlink.txt');
        const otherPath = getFixturePath('other.txt');
        fs.writeFileSync(otherPath, 'other');
        const watcher = chokidar_watch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await fs_unlink(otherPath);

        await delay();
        await fs_unlink(testPath);
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
        const unlinkSpy = sinon.spy(function unlinkSpy(){});
        const addSpy = sinon.spy(function addSpy(){});
        const testPath = getFixturePath('unlink.txt');
        const otherPath = getFixturePath('other.txt');
        const other2Path = getFixturePath('other2.txt');
        fs.writeFileSync(otherPath, 'other');
        // intentionally for this test don't write fs.writeFileSync(other2Path, 'other2');
        const watcher = chokidar_watch([testPath, otherPath, other2Path], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);
        await delay();
        await fs_unlink(testPath);

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
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      const renamedDir = getFixturePath('subdir-renamed');
      const expectedPath = sysPath.join(renamedDir, 'add.txt');
      await fs_mkdir(testDir, PERM_ARR);
      await write(testPath, dateNow());
      const watcher = chokidar_watch(currentDir, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay(1000);
      await fs_rename(testDir, renamedDir);
      await waitFor([spy.withArgs(expectedPath)]);
      spy.should.have.been.calledWith(expectedPath);
    });
  });
  describe('watch non-existent paths', () => {
    it('should watch non-existent file and detect add', async () => {
      const testPath = getFixturePath('add.txt');
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay();
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should watch non-existent dir and detect addDir/add', async () => {
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      const watcher = chokidar_watch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.not.have.been.called;

      await delay();
      await fs_mkdir(testDir, PERM_ARR);
      await waitFor([spy.withArgs(EV.ADD_DIR)]);
      await write(testPath, 'hello');
      await waitFor([spy.withArgs(EV.ADD)]);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV.ADD, testPath);
    });
  });
  describe('not watch glob patterns', () => {
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = getFixturePath('nota[glob].txt');
      await write(filePath, 'b');
      await delay();
      const spy = await aspy(chokidar_watch(), EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, filePath);

      await delay();
      await write(filePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like directory names as literal directory names when globbing is disabled', async () => {
      options.disableGlobbing = true;
      const filePath = getFixturePath('nota[glob]/a.txt');
      const watchPath = getFixturePath('nota[glob]');
      const testDir = getFixturePath('nota[glob]');
      const matchingDir = getFixturePath('notag');
      const matchingFile = getFixturePath('notag/b.txt');
      const matchingFile2 = getFixturePath('notal');
      fs.mkdirSync(testDir, PERM_ARR);
      fs.writeFileSync(filePath, 'b');
      fs.mkdirSync(matchingDir, PERM_ARR);
      fs.writeFileSync(matchingFile, 'c');
      fs.writeFileSync(matchingFile2, 'd');
      const watcher = chokidar_watch(watchPath, options);
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
      options.disableGlobbing = true;
      const filePath = getFixturePath('nota[glob]');
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = getFixturePath('nota[glob]');
      const matchingDir = getFixturePath('notag');
      const matchingFile = getFixturePath('notag/a.txt');
      const matchingFile2 = getFixturePath('notal');
      fs.writeFileSync(filePath, 'b');
      fs.mkdirSync(matchingDir, PERM_ARR);
      fs.writeFileSync(matchingFile, 'c');
      fs.writeFileSync(matchingFile2, 'd');
      const watcher = chokidar_watch(watchPath, options);
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
    let linkedDir;
    beforeEach(async () => {
      linkedDir = sysPath.resolve(currentDir, '..', `${subdirId}-link`);
      await fs_symlink(currentDir, linkedDir, isWindows ? 'dir' : null);
      await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
      await write(getFixturePath('subdir/add.txt'), 'b');
      return true;
    });
    afterEach(async () => {
      await fs_unlink(linkedDir);
      return true;
    });

    it('should watch symlinked dirs', async () => {
      const dirSpy = sinon.spy(function dirSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const watcher = chokidar_watch(linkedDir, options)
        .on(EV.ADD_DIR, dirSpy)
        .on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      dirSpy.should.have.been.calledWith(linkedDir);
      addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'change.txt'));
      addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'unlink.txt'));
    });
    it('should watch symlinked files', async () => {
      const changePath = getFixturePath('change.txt');
      const linkPath = getFixturePath('link.txt');
      fs.symlinkSync(changePath, linkPath);
      const watcher = chokidar_watch(linkPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should follow symlinked files within a normal dir', async () => {
      const changePath = getFixturePath('change.txt');
      const linkPath = getFixturePath('subdir/link.txt');
      fs.symlinkSync(changePath, linkPath);
      const watcher = chokidar_watch(getFixturePath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should watch paths with a symlinked parent', async () => {
      const testDir = sysPath.join(linkedDir, 'subdir');
      const testFile = sysPath.join(testDir, 'add.txt');
      const watcher = chokidar_watch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV.ADD, testFile);
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testFile);
    });
    it('should not recurse indefinitely on circular symlinks', async () => {
      await fs_symlink(currentDir, getFixturePath('subdir/circular'), isWindows ? 'dir' : null);
      return new Promise((resolve, reject) => {
        const watcher = chokidar_watch();
        watcher.on(EV.ERROR, resolve());
        watcher.on(EV.READY, reject('The watcher becomes ready, although he watches a circular symlink.'));
      })
    });
    it('should recognize changes following symlinked dirs', async () => {
      const linkedFilePath = sysPath.join(linkedDir, 'change.txt');
      const watcher = chokidar_watch(linkedDir, options);
      const spy = await aspy(watcher, EV.CHANGE);
      const wa = spy.withArgs(linkedFilePath);
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([wa]);
      spy.should.have.been.calledWith(linkedFilePath);
    });
    it('should follow newly created symlinks', async () => {
      options.ignoreInitial = true;
      const watcher = chokidar_watch();
      const spy = await aspy(watcher, EV.ALL);
      await delay();
      await fs_symlink(getFixturePath('subdir'), getFixturePath('link'), isWindows ? 'dir' : null);
      await waitFor([
        spy.withArgs(EV.ADD, getFixturePath('link/add.txt')),
        spy.withArgs(EV.ADD_DIR, getFixturePath('link'))
      ]);
      spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('link'));
      spy.should.have.been.calledWith(EV.ADD, getFixturePath('link/add.txt'));
    });
    it('should watch symlinks as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const watcher = chokidar_watch(linkedDir, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.not.have.been.calledWith(EV.ADD_DIR);
      spy.should.have.been.calledWith(EV.ADD, linkedDir);
      spy.should.have.been.calledOnce;
    });
    it('should survive ENOENT for missing symlinks when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const targetDir = getFixturePath('subdir/nonexistent');
      await fs_mkdir(targetDir);
      await fs_symlink(targetDir, getFixturePath('subdir/broken'), isWindows ? 'dir' : null);
      await fs_rmdir(targetDir);
      await delay();

      const watcher = chokidar_watch(getFixturePath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('subdir'));
      spy.should.have.been.calledWith(EV.ADD, getFixturePath('subdir/add.txt'));
    });
    it('should watch symlinks within a watched dir as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      // Create symlink in linkPath
      const linkPath = getFixturePath('link');
      fs.symlinkSync(getFixturePath('subdir'), linkPath);
      const spy = await aspy(chokidar_watch(), EV.ALL);
      await delay(300);
      setTimeout(() => {
        fs.writeFileSync(getFixturePath('subdir/add.txt'), dateNow());
        fs.unlinkSync(linkPath);
        fs.symlinkSync(getFixturePath('subdir/add.txt'), linkPath);
      }, options.usePolling ? 1200 : 300);

      await delay(300);
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, linkPath);
      spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('link/add.txt'));
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should not reuse watcher when following a symlink to elsewhere', async () => {
      const linkedPath = getFixturePath('outside');
      const linkedFilePath = sysPath.join(linkedPath, 'text.txt');
      const linkPath = getFixturePath('subdir/subsub');
      fs.mkdirSync(linkedPath, PERM_ARR);
      fs.writeFileSync(linkedFilePath, 'b');
      fs.symlinkSync(linkedPath, linkPath);
      const watcher2 = chokidar_watch(getFixturePath('subdir'), options);
      await waitForWatcher(watcher2);

      await delay(options.usePolling ? 900 : undefined);
      const watchedPath = getFixturePath('subdir/subsub/text.txt');
      const watcher = chokidar_watch(watchedPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(linkedFilePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, watchedPath);
    });
    it('should emit ready event even when broken symlinks are encountered', async () => {
      const targetDir = getFixturePath('subdir/nonexistent');
      await fs_mkdir(targetDir);
      await fs_symlink(targetDir, getFixturePath('subdir/broken'), isWindows ? 'dir' : null);
      await fs_rmdir(targetDir);
      const readySpy = sinon.spy(function readySpy(){});
      const watcher = chokidar_watch(getFixturePath('subdir'), options)
          .on(EV.READY, readySpy);
      await waitForWatcher(watcher);
      readySpy.should.have.been.calledOnce;
    });
  });
  describe('watch arrays of paths/globs', () => {
    it('should watch all paths in an array', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir);
      const watcher = chokidar_watch([testDir, testPath], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      await fs_mkdir(testDir);
      const watcher = chokidar_watch([[testDir], [testPath]], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should throw if provided any non-string paths', () => {
      expect(chokidar_watch.bind(null, [[currentDir], /notastring/]))
        .to.throw(TypeError, /non-string/i);
    });
  });
  describe('watch options', () => {
    describe('ignoreInitial', () => {
      describe('false', () => {
        beforeEach(() => { options.ignoreInitial = false; });
        it('should emit `add` events for preexisting files', async () => {
          const watcher = chokidar_watch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD);
          spy.should.have.been.calledTwice;
        });
        it('should emit `addDir` event for watched dir', async () => {
          const watcher = chokidar_watch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(currentDir);
        });
        it('should emit `addDir` events for preexisting dirs', async () => {
          await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
          await fs_mkdir(getFixturePath('subdir/subsub'), PERM_ARR);
          const watcher = chokidar_watch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          spy.should.have.been.calledWith(currentDir);
          spy.should.have.been.calledWith(getFixturePath('subdir'));
          spy.should.have.been.calledWith(getFixturePath('subdir/subsub'));
          spy.should.have.been.calledThrice;
        });
      });
      describe('true', () => {
        beforeEach(() => { options.ignoreInitial = true; });
        it('should ignore initial add events', async () => {
          const watcher = chokidar_watch();
          const spy = await aspy(watcher, EV.ADD);
          await delay();
          spy.should.not.have.been.called;
        });
        it('should ignore add events on a subsequent .add()', async () => {
          const watcher = chokidar_watch(getFixturePath('subdir'), options);
          const spy = await aspy(watcher, EV.ADD);
          watcher.add(currentDir);
          await delay(1000);
          spy.should.not.have.been.called;
        });
        it('should notice when a file appears in an empty directory', async () => {
          const testDir = getFixturePath('subdir');
          const testPath = getFixturePath('subdir/add.txt');
          const spy = await aspy(chokidar_watch(), EV.ADD);
          spy.should.not.have.been.called;
          await fs_mkdir(testDir, PERM_ARR);
          await write(testPath, dateNow());
          await waitFor([spy]);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
        });
        it('should emit a change on a preexisting file as a change', async () => {
          const testPath = getFixturePath('change.txt');
          const spy = await aspy(chokidar_watch(), EV.ALL);
          spy.should.not.have.been.called;
          await write(testPath, dateNow());
          await waitFor([spy.withArgs(EV.CHANGE, testPath)]);
          spy.should.have.been.calledWith(EV.CHANGE, testPath);
          spy.should.not.have.been.calledWith(EV.ADD);
        });
        it('should not emit for preexisting dirs when depth is 0', async () => {
          options.depth = 0;
          const testPath = getFixturePath('add.txt');
          await fs_mkdir(getFixturePath('subdir'), PERM_ARR);

          await delay(200);
          const spy = await aspy(chokidar_watch(), EV.ALL);
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
        const testDir = getFixturePath('subdir');
        fs.mkdirSync(testDir, PERM_ARR);
        fs.writeFileSync(sysPath.join(testDir, 'add.txt'), '');
        fs.mkdirSync(sysPath.join(testDir, 'subsub'), PERM_ARR);
        fs.writeFileSync(sysPath.join(testDir, 'subsub', 'ab.txt'), '');
        const watcher = chokidar_watch(testDir, options);
        const spy = await aspy(watcher, EV.ADD);
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith(sysPath.join(testDir, 'add.txt'));
      });
      it('should not choke on an ignored watch path', async () => {
        options.ignored = () => { return true; };
        await waitForWatcher(chokidar_watch());
      });
      it('should ignore the contents of ignored dirs', async () => {
        const testDir = getFixturePath('subdir');
        const testFile = sysPath.join(testDir, 'add.txt');
        options.ignored = testDir;
        fs.mkdirSync(testDir, PERM_ARR);
        fs.writeFileSync(testFile, 'b');
        const watcher = chokidar_watch(currentDir, options);
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

        fs.writeFileSync(getFixturePath('add.txt'), 'b');
        const watcher = chokidar_watch(currentDir, options);
        const spy = await aspy(watcher, EV.ALL);

        await delay();
        await write(getFixturePath('add.txt'), dateNow());
        await write(getFixturePath('change.txt'), dateNow());

        await waitFor([spy.withArgs(EV.CHANGE, 'change.txt')]);
        spy.should.not.have.been.calledWith(EV.ADD, 'add.txt');
        spy.should.not.have.been.calledWith(EV.CHANGE, 'add.txt');
        spy.should.have.been.calledWith(EV.ADD, 'change.txt');
        spy.should.have.been.calledWith(EV.CHANGE, 'change.txt');
      });
    });
    describe('depth', () => {
      beforeEach(async () => {
        await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
        await write(getFixturePath('subdir/add.txt'), 'b');
        await delay();
        await fs_mkdir(getFixturePath('subdir/subsub'), PERM_ARR);
        await write(getFixturePath('subdir/subsub/ab.txt'), 'b');
        await delay();
      });
      it('should not recurse if depth is 0', async () => {
        options.depth = 0;
        const watcher = chokidar_watch();
        const spy = await aspy(watcher, EV.ALL);
        await write(getFixturePath('subdir/add.txt'), dateNow());
        await waitFor([[spy, 4]]);
        spy.should.have.been.calledWith(EV.ADD_DIR, currentDir);
        spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('subdir'));
        spy.should.have.been.calledWith(EV.ADD, getFixturePath('change.txt'));
        spy.should.have.been.calledWith(EV.ADD, getFixturePath('unlink.txt'));
        spy.should.not.have.been.calledWith(EV.CHANGE);
        if (!macosFswatch) spy.callCount.should.equal(4);
      });
      it('should recurse to specified depth', async () => {
        options.depth = 1;
        const addPath = getFixturePath('subdir/add.txt');
        const changePath = getFixturePath('change.txt');
        const ignoredPath = getFixturePath('subdir/subsub/ab.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await delay();
        await write(getFixturePath('change.txt'), dateNow());
        await write(addPath, dateNow());
        await write(ignoredPath, dateNow());
        await waitFor([spy.withArgs(EV.CHANGE, addPath), spy.withArgs(EV.CHANGE, changePath)]);
        spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('subdir/subsub'));
        spy.should.have.been.calledWith(EV.CHANGE, changePath);
        spy.should.have.been.calledWith(EV.CHANGE, addPath);
        spy.should.not.have.been.calledWith(EV.ADD, ignoredPath);
        spy.should.not.have.been.calledWith(EV.CHANGE, ignoredPath);
        if (!macosFswatch) spy.callCount.should.equal(8);
      });
      it('should respect depth setting when following symlinks', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        await fs_symlink(getFixturePath('subdir'), getFixturePath('link'), isWindows ? 'dir' : null);
        await delay();
        const spy = await aspy(chokidar_watch(), EV.ALL);
        spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('link'));
        spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('link/subsub'));
        spy.should.have.been.calledWith(EV.ADD, getFixturePath('link/add.txt'));
        spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('link/subsub/ab.txt'));
      });
      it('should respect depth setting when following a new symlink', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        const linkPath = getFixturePath('link');
        const dirPath = getFixturePath('link/subsub');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await fs_symlink(getFixturePath('subdir'), linkPath, isWindows ? 'dir' : null);
        await waitFor([[spy, 3], spy.withArgs(EV.ADD_DIR, dirPath)]);
        spy.should.have.been.calledWith(EV.ADD_DIR, linkPath);
        spy.should.have.been.calledWith(EV.ADD_DIR, dirPath);
        spy.should.have.been.calledWith(EV.ADD, getFixturePath('link/add.txt'));
        spy.should.have.been.calledThrice;
      });
      it('should correctly handle dir events when depth is 0', async () => {
        options.depth = 0;
        const subdir2 = getFixturePath('subdir2');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        const addSpy = spy.withArgs(EV.ADD_DIR);
        const unlinkSpy = spy.withArgs(EV.UNLINK_DIR);
        spy.should.have.been.calledWith(EV.ADD_DIR, currentDir);
        spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('subdir'));
        await fs_mkdir(subdir2, PERM_ARR);
        await waitFor([[addSpy, 3]]);
        addSpy.should.have.been.calledThrice;

        await fs_rmdir(subdir2);
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
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(getFixturePath('.change.txt.swp'), 'a'); // vim
        await write(getFixturePath('add.txt~'), 'a'); // vim/emacs
        await write(getFixturePath('.subl5f4.tmp'), 'a'); // sublime
        await delay(300);
        await write(getFixturePath('.change.txt.swp'), 'c');
        await write(getFixturePath('add.txt~'), 'c');
        await write(getFixturePath('.subl5f4.tmp'), 'c');
        await delay(300);
        await fs_unlink(getFixturePath('.change.txt.swp'));
        await fs_unlink(getFixturePath('add.txt~'));
        await fs_unlink(getFixturePath('.subl5f4.tmp'));
        await delay(300);
        spy.should.not.have.been.called;
      });
      it('should ignore stale tilde files', async () => {
        options.ignoreInitial = false;
        await write(getFixturePath('old.txt~'), 'a');
        await delay();
        const spy = await aspy(chokidar_watch(), EV.ALL);
        spy.should.not.have.been.calledWith(getFixturePath('old.txt'));
        spy.should.not.have.been.calledWith(getFixturePath('old.txt~'));
      });
    });
    describe('cwd', () => {
      it('should emit relative paths based on cwd', async () => {
        options.cwd = currentDir;
        const watcher = chokidar_watch('.', options);
        const spy = await aspy(watcher, EV.ALL);
        await fs_unlink(getFixturePath('unlink.txt'));
        await write(getFixturePath('change.txt'), dateNow());
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
        const testDir = getFixturePath('subdir');
        const renamedDir = getFixturePath('subdir-renamed');

        await fs_mkdir(testDir, PERM_ARR);
        const watcher = chokidar_watch('.', options);

        setTimeout(() => {
          watcher.on(EV.ADD_DIR, spy);
          fs_rename(testDir, renamedDir);
        }, 1000);

        await waitFor([spy]);
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith('subdir-renamed');
        expect(spy.args[0][1]).to.be.ok; // stats
      });
      it('should allow separate watchers to have different cwds', async () => {
        options.cwd = currentDir;
        const options2 = {};
        Object.keys(options).forEach((key) => {
          options2[key] = options[key];
        });
        options2.cwd = getFixturePath('subdir');
        const watcher = chokidar_watch(getGlobPath('.'), options);
        const watcherEvents = waitForEvents(watcher, 3);
        const spy1 = await aspy(watcher, EV.ALL);

        await delay();
        const watcher2 = chokidar_watch(currentDir, options2);
        const watcher2Events = waitForEvents(watcher2, 5);
        const spy2 = await aspy(watcher2, EV.ALL);

        await fs_unlink(getFixturePath('unlink.txt'));
        await write(getFixturePath('change.txt'), dateNow());
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
        const files = [
          '.'
        ];
        fs.writeFileSync(getFixturePath('change.txt'), 'hello');
        fs.writeFileSync(getFixturePath('ignored.txt'), 'ignored');
        fs.writeFileSync(getFixturePath('ignored-option.txt'), 'ignored option');
        const watcher = chokidar_watch(files, options);

        const spy = await aspy(watcher, EV.ALL);
        fs.writeFileSync(getFixturePath('ignored.txt'), dateNow());
        fs.writeFileSync(getFixturePath('ignored-option.txt'), dateNow());
        await fs_unlink(getFixturePath('ignored.txt'));
        await fs_unlink(getFixturePath('ignored-option.txt'));
        await delay();
        await write(getFixturePath('change.txt'), EV.CHANGE);
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
      let filePath;
      beforeEach(async () => {
        filePath = getFixturePath('add.txt');
        await write(filePath, 'b', {mode: 128});
        await delay();
      });
      describe('false', () => {
        beforeEach(() => {
          options.ignorePermissionErrors = false;
          // chokidar_watch();
        });
        it('should not watch files without read permissions', async () => {
          if (isWindows) return true;
          const spy = await aspy(chokidar_watch(), EV.ALL);
          spy.should.not.have.been.calledWith(EV.ADD, filePath);
          await write(filePath, dateNow());

          await delay(200);
          spy.should.not.have.been.calledWith(EV.CHANGE, filePath);
        });
      });
      describe('true', () => {
        beforeEach(() => { options.ignorePermissionErrors = true; });
        it('should watch unreadable files if possible', async () => {
          const spy = await aspy(chokidar_watch(), EV.ALL);
          spy.should.have.been.calledWith(EV.ADD, filePath);
        });
        it('should not choke on non-existent files', async () => {
          const watcher = chokidar_watch(getFixturePath('nope.txt'), options);
          await waitForWatcher(watcher);
        });
      });
    });
    describe('awaitWriteFinish', () => {
      beforeEach(() => {
        options.awaitWriteFinish = {stabilityThreshold: 500};
        options.ignoreInitial = true;
      });
      it('should use default options if none given', () => {
        options.awaitWriteFinish = true;
        const watcher = chokidar_watch();
        expect(watcher.options.awaitWriteFinish.pollInterval).to.equal(100);
        expect(watcher.options.awaitWriteFinish.stabilityThreshold).to.equal(2000);
      });
      it('should not emit add event before a file is fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'hello');
        await delay(200);
        spy.should.not.have.been.calledWith(EV.ADD);
      });
      it('should wait for the file to be fully written before emitting the add event', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'hello');

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.ADD, testPath);
      });
      it('should emit with the final stats', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'hello ');

        await delay(300);
        fs.appendFileSync(testPath, 'world!');

        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.ADD, testPath);
        expect(spy.args[0][2].size).to.equal(12);
      });
      it('should not emit change event while a file has not been fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'hello');
        await delay(100);
        await write(testPath, 'edit');
        await delay(200);
        spy.should.not.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should not emit change event before an existing file is fully updated', async () => {
        const testPath = getFixturePath('change.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'hello');
        await delay(300);
        spy.should.not.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should wait for an existing file to be fully updated before emitting the change event', async () => {
        const testPath = getFixturePath('change.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        fs.writeFile(testPath, 'hello', () => {});

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should emit change event after the file is fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await delay();
        await write(testPath, 'hello');

        await waitFor([spy]);
        spy.should.have.been.calledWith(EV.ADD, testPath);
        await write(testPath, 'edit');
        await waitFor([spy.withArgs(EV.CHANGE)]);
        spy.should.have.been.calledWith(EV.CHANGE, testPath);
      });
      it('should not raise any event for a file that was deleted before fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'hello');
        await delay(400);
        await fs_unlink(testPath);
        await delay(400);
        spy.should.not.have.been.calledWith(sinon.match.string, testPath);
      });
      it('should be compatible with the cwd option', async () => {
        const testPath = getFixturePath('subdir/add.txt');
        const filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        await fs_mkdir(options.cwd);

        await delay(200);
        const spy = await aspy(chokidar_watch(), EV.ALL);

        await delay(400);
        await write(testPath, 'hello');

        await waitFor([spy.withArgs(EV.ADD)]);
        spy.should.have.been.calledWith(EV.ADD, filename);
      });
      it('should still emit initial add events', async () => {
        options.ignoreInitial = false;
        const spy = await aspy(chokidar_watch(), EV.ALL);
        spy.should.have.been.calledWith(EV.ADD);
        spy.should.have.been.calledWith(EV.ADD_DIR);
      });
      it('should emit an unlink event when a file is updated and deleted just after that', async () => {
        const testPath = getFixturePath('subdir/add.txt');
        const filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        await fs_mkdir(options.cwd);
        await delay();
        await write(testPath, 'hello');
        await delay();
        const spy = await aspy(chokidar_watch(), EV.ALL);
        await write(testPath, 'edit');
        await delay();
        await fs_unlink(testPath);
        await waitFor([spy.withArgs(EV.UNLINK)]);
        spy.should.have.been.calledWith(EV.UNLINK, filename);
        spy.should.not.have.been.calledWith(EV.CHANGE, filename);
      });
      describe('race condition', () => {
        function w(fn, to) {
          return setTimeout.bind(null, fn, to || slowerDelay || 50);
        }
        function simpleCb(err) { if (err) throw err; }

        // Reproduces bug https://github.com/paulmillr/chokidar/issues/546, which was causing an
        // uncaught exception. The race condition is likelier to happen when stat() is slow.
        const _realStat = fs.stat;
        beforeEach(() => {
          options.awaitWriteFinish = {pollInterval: 50, stabilityThreshold: 50};
          options.ignoreInitial = true;

          // Stub fs.stat() to take a while to return.
          sinon.stub(fs, 'stat').callsFake((path, cb) => {
            _realStat(path, w(cb, 250));
          });
        });

        afterEach(() => {
          // Restore fs.stat() back to normal.
          sinon.restore();
        });

        function _waitFor(spies, fn) {
          function isSpyReady(spy) {
            return Array.isArray(spy) ? spy[0].callCount >= spy[1] : spy.callCount;
          }
          // eslint-disable-next-line prefer-const
          let intrvl;
          // eslint-disable-next-line prefer-const
          let to;
          function finish() {
            clearInterval(intrvl);
            clearTimeout(to);
            fn();
            fn = Function.prototype;
          }
          intrvl = setInterval(() => {
            if (spies.every(isSpyReady)) finish();
          }, 5);
          to = setTimeout(finish, 3500);
        }

        it('should handle unlink that happens while waiting for stat to return', (done) => {
          const spy = sinon.spy();
          const testPath = getFixturePath('add.txt');
          chokidar_watch()
          .on(EV.ALL, spy)
          .on(EV.READY, () => {
            fs.writeFile(testPath, 'hello', simpleCb);
            _waitFor([spy], () => {
              spy.should.have.been.calledWith(EV.ADD, testPath);
              fs.stat.resetHistory();
              fs.writeFile(testPath, 'edit', simpleCb);
              w(() => {
                // There will be a stat() call after we notice the change, plus pollInterval.
                // After waiting a bit less, wait specifically for that stat() call.
                fs.stat.resetHistory();
                _waitFor([fs.stat], () => {
                  // Once stat call is made, it will take some time to return. Meanwhile, unlink
                  // the file and wait for that to be noticed.
                  fs.unlink(testPath, simpleCb);
                  _waitFor([spy.withArgs(EV.UNLINK)], w(() => {
                    // Wait a while after unlink to ensure stat() had time to return. That's where
                    // an uncaught exception used to happen.
                    spy.should.have.been.calledWith(EV.UNLINK, testPath);
                    spy.should.not.have.been.calledWith(EV.CHANGE);
                    done();
                  }, 400));
                });
              }, 40)();
            });
          });
        });
      });
    });
  });
  describe('getWatched', () => {
    it('should return the watched paths', async () => {
      const expected = {};
      expected[sysPath.dirname(currentDir)] = [subdirId.toString()];
      expected[currentDir] = ['change.txt', 'unlink.txt'];
      const watcher = chokidar_watch();
      await waitForWatcher(watcher);
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
    it('should set keys relative to cwd & include added paths', async () => {
      options.cwd = currentDir;
      const expected = {
        '.': ['change.txt', 'subdir', 'unlink.txt'],
        '..': [subdirId.toString()],
        'subdir': []
      };
      await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
      const watcher = chokidar_watch();
      await waitForWatcher(watcher);
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
  });
  describe('unwatch', () => {
    beforeEach(async () => {
      options.ignoreInitial = true;
      await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
      await delay();
    });
    it('should stop watching unwatched paths', async () => {
      const watchPaths = [getFixturePath('subdir'), getFixturePath('change.txt')];
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      watcher.unwatch(getFixturePath('subdir'));

      await delay();
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV.CHANGE, getFixturePath('change.txt'));
      spy.should.not.have.been.calledWith(EV.ADD);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should ignore unwatched paths that are a subset of watched paths', async () => {
      const subdirRel = upath.relative(process.cwd(), getFixturePath('subdir'));
      const unlinkFile = getFixturePath('unlink.txt');
      const addFile = getFixturePath('subdir/add.txt');
      const changedFile = getFixturePath('change.txt');
      const watcher = chokidar_watch(currentDir, options);
      const spy = await aspy(watcher, EV.ALL);

      // test with both relative and absolute paths
      watcher.unwatch([subdirRel, getGlobPath('unlink.txt')]);

      await delay();
      await fs_unlink(unlinkFile);
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
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      watcher.unwatch(subdir);
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV.CHANGE, changeFile);
      spy.should.not.have.been.calledWith(EV.ADD);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should watch paths that were unwatched and added again', async () => {
      const spy = sinon.spy();
      const watchPaths = [getFixturePath('change.txt')];
      const watcher = chokidar_watch(watchPaths, options);
      await waitForWatcher(watcher);

      await delay();
      watcher.unwatch(getFixturePath('change.txt'));

      await delay();
      watcher.on(EV.ALL, spy).add(getFixturePath('change.txt'));

      await delay();
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(EV.CHANGE, getFixturePath('change.txt'));
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch paths that are relative to options.cwd', async () => {
      options.cwd = currentDir;
      const watcher = chokidar_watch('.', options);
      const spy = await aspy(watcher, EV.ALL);
      watcher.unwatch(['subdir', getFixturePath('unlink.txt')]);

      await delay();
      await fs_unlink(getFixturePath('unlink.txt'));
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await write(getFixturePath('change.txt'), dateNow());
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
        const watcher = chokidar_watch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to 1', async () => {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = '1';

        const watcher = chokidar_watch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to false', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        const watcher = chokidar_watch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.false;
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to 0', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        const watcher = chokidar_watch(currentDir, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.false;
      });

      it('should not attenuate options.usePolling when CHOKIDAR_USEPOLLING is set to an arbitrary value', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'foo';

        const watcher = chokidar_watch(currentDir, options);
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

          const watcher = chokidar_watch(currentDir, options);
          await waitForWatcher(watcher);
          watcher.options.interval.should.be.equal(1500);
        });
      });
    }
  });
  describe('reproduction of bug in issue #1040', () => {
    it('should detect change on symlink folders when consolidateThreshhold is reach', async () => {
      const id = subdirId.toString();

      const fixturesPathRel = sysPath.join(FIXTURES_PATH_REL, id, 'test-case-1040');
      const linkPath = sysPath.join(fixturesPathRel, 'symlinkFolder');
      const packagesPath = sysPath.join(fixturesPathRel, 'packages');
      await fs_mkdir(fixturesPathRel);
      await fs_mkdir(linkPath);
      await fs_mkdir(packagesPath);

      // Init chokidar
      const watcher = chokidar.watch([]);

      // Add more than 10 folders to cap consolidateThreshhold
      for (let i = 0 ; i < 20 ; i += 1) {
        const folderPath = sysPath.join(packagesPath, `folder${i}`);
        await fs_mkdir(folderPath);
        const filePath = sysPath.join(folderPath, `file${i}.js`);
        await write(sysPath.resolve(filePath), 'file content');
        const symlinkPath = sysPath.join(linkPath, `folder${i}`);
        await fs_symlink(sysPath.resolve(folderPath), symlinkPath, isWindows ? 'dir' : null);
        watcher.add(sysPath.resolve(sysPath.join(symlinkPath, `file${i}.js`)));
      }

      // Wait to be sure that we have no other event than the update file
      await delay(300);

      const eventsWaiter = waitForEvents(watcher, 1);

      // Update a random generated file to fire an event
      const randomFilePath = sysPath.join(fixturesPathRel, 'packages', 'folder17', 'file17.js');
      await write(sysPath.resolve(randomFilePath), 'file content changer zeri ezhriez');

      // Wait chokidar watch
      await delay(300);

      const events = await eventsWaiter;

      expect(events.length).to.equal(1);
    })
  });
  describe('reproduction of bug in issue #1024', () => {
    it('should detect changes to folders, even if they were deleted before', async () => {
      const id = subdirId.toString();
      const relativeWatcherDir = sysPath.join(FIXTURES_PATH_REL, id, 'test');
      const watcher = chokidar.watch(relativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = sysPath.join(relativeWatcherDir, 'dir');
        const testSubDirFile = sysPath.join(relativeWatcherDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await fs_mkdir(relativeWatcherDir);
        await fs_mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rmdir will be equalize
        await delay(300);
        await fs_rmdir(testSubDir);
        // The following delay is essential otherwise the call of rmdir and mkdir will be equalize
        await delay(300);
        await fs_mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        chai.assert.deepStrictEqual(events, [
          `[ALL] addDir: ${sysPath.join('test-fixtures', id, 'test')}`,
          `[ALL] addDir: ${sysPath.join('test-fixtures', id, 'test', 'dir')}`,
          `[ALL] unlinkDir: ${sysPath.join('test-fixtures', id, 'test', 'dir')}`,
          `[ALL] addDir: ${sysPath.join('test-fixtures', id, 'test', 'dir')}`,
          `[ALL] add: ${sysPath.join('test-fixtures', id, 'test', 'dir', 'file')}`,
        ]);
      } finally {
        watcher.close();
      }
    });

    it('should detect changes to symlink folders, even if they were deleted before', async () => {
      const id = subdirId.toString();
      const relativeWatcherDir = sysPath.join(FIXTURES_PATH_REL, id, 'test');
      const linkedRelativeWatcherDir = sysPath.join(FIXTURES_PATH_REL, id, 'test-link');
      await fs_symlink(
        sysPath.resolve(relativeWatcherDir),
        linkedRelativeWatcherDir,
        isWindows ? 'dir' : null
      );
      await delay();
      const watcher = chokidar.watch(linkedRelativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = sysPath.join(relativeWatcherDir, 'dir');
        const testSubDirFile = sysPath.join(relativeWatcherDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await fs_mkdir(relativeWatcherDir);
        await fs_mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rmdir will be equalize
        await delay(300);
        await fs_rmdir(testSubDir);
        // The following delay is essential otherwise the call of rmdir and mkdir will be equalize
        await delay(300);
        await fs_mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        chai.assert.deepStrictEqual(events, [
          `[ALL] addDir: ${sysPath.join('test-fixtures', id, 'test-link')}`,
          `[ALL] addDir: ${sysPath.join('test-fixtures', id, 'test-link', 'dir')}`,
          `[ALL] unlinkDir: ${sysPath.join('test-fixtures', id, 'test-link', 'dir')}`,
          `[ALL] addDir: ${sysPath.join('test-fixtures', id, 'test-link', 'dir')}`,
          `[ALL] add: ${sysPath.join('test-fixtures', id, 'test-link', 'dir', 'file')}`,
        ]);
      } finally {
        watcher.close();
      }
    });
  });

  describe('close', () => {
    it('should ignore further events on close', async () => {
      const spy = sinon.spy();
      const watcher = chokidar_watch(currentDir, options);
      await waitForWatcher(watcher);

      watcher.on(EV.ALL, spy);
      await watcher.close();

      await write(getFixturePath('add.txt'), dateNow());
      await write(getFixturePath('add.txt'), 'hello');
      await delay(300);
      await fs_unlink(getFixturePath('add.txt'));

      spy.should.not.have.been.called;
    });
    it('should not ignore further events on close with existing watchers', async () => {
      const spy = sinon.spy();
      const watcher1 = chokidar_watch(currentDir);
      const watcher2 = chokidar_watch(currentDir);
      await Promise.all([
        waitForWatcher(watcher1),
        waitForWatcher(watcher2)
      ]);

      // The EV_ADD event should be called on the second watcher even if the first watcher is closed
      watcher2.on(EV.ADD, spy);
      await watcher1.close();

      await write(getFixturePath('add.txt'), 'hello');
      // Ensures EV_ADD is called. Immediately removing the file causes it to be skipped
      await delay(200);
      await fs_unlink(getFixturePath('add.txt'));

      spy.should.have.been.calledWith(sinon.match('add.txt'));
    });
    it('should not prevent the process from exiting', async () => {
      const scriptFile = getFixturePath('script.js');
      const chokidarPath = pathToFileURL(sysPath.join(__dirname, 'lib/index.js'))
        .href
        .replace(/\\/g, '\\\\');
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
      const {stdout} = obj;
      expect(stdout.toString()).to.equal('closed');
    });
    it('should always return the same promise', async () => {
      const watcher = chokidar_watch(currentDir, options);
      const closePromise = watcher.close();
      expect(closePromise).to.be.a('promise');
      expect(watcher.close()).to.be.equal(closePromise);
      await closePromise;
    });
  });
};

describe('chokidar', async () => {
  before(async () => {
    await rimraf(FIXTURES_PATH);
    const _content = fs.readFileSync(__filename, 'utf-8');
    const _only = _content.match(/\sit\.only\(/g);
    const itCount = _only && _only.length || _content.match(/\sit\(/g).length;
    const testCount = itCount * 3;
    fs.mkdirSync(currentDir, PERM_ARR);
    while (subdirId++ < testCount) {
      currentDir = getFixturePath('');
      fs.mkdirSync(currentDir, PERM_ARR);
      fs.writeFileSync(sysPath.join(currentDir, 'change.txt'), 'b');
      fs.writeFileSync(sysPath.join(currentDir, 'unlink.txt'), 'b');
    }
    subdirId = 0;
  });

  after(async () => {
    await rimraf(FIXTURES_PATH);
  });

  beforeEach(() => {
    subdirId++;
    currentDir = getFixturePath('');
  });

  afterEach(async () => {
    let watcher;
    while ((watcher = allWatchers.pop())) {
      await watcher.close();
    }
  });

  it('should expose public API methods', () => {
    chokidar.FSWatcher.should.be.a('function');
    chokidar.watch.should.be.a('function');
  });

  if (!isIBMi) {
    describe('fs.watch (non-polling)', runTests.bind(this, {usePolling: false}));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, {usePolling: true, interval: 10}));
});
