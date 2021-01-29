/* eslint-env mocha */

'use strict';

const fs = require('fs');
const sysPath = require('path');
const {promisify} = require('util');
const childProcess = require('child_process');
const chai = require('chai');
const rimraf = require('rimraf');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const upath = require('upath');

const {isWindows, isMacos, isIBMi, EV_ALL, EV_READY, EV_ADD, EV_CHANGE, EV_ADD_DIR, EV_UNLINK, EV_UNLINK_DIR, EV_RAW, EV_ERROR}
    = require('./lib/constants');
const chokidar = require('.');

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
const pRimraf = promisify(rimraf);

const FIXTURES_PATH_REL = 'test-fixtures';
const FIXTURES_PATH = sysPath.join(__dirname, FIXTURES_PATH_REL);
const allWatchers = [];
const PERM_ARR = 0o755; // rwe, r+e, r+e
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
      (eventName === EV_ALL ?
      (event, path) => spy(event, path) :
      (path) => spy(path)) :
      spy;
    watcher.on(EV_ERROR, reject);
    watcher.on(EV_READY, () => resolve(spy));
    watcher.on(eventName, handler);
  });
};

const waitForWatcher = (watcher) => {
  return new Promise((resolve, reject) => {
    watcher.on(EV_ERROR, reject);
    watcher.on(EV_READY, resolve);
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
  return new Promise((resolve) => {
    const isSpyReady = (spy) => {
      if (Array.isArray(spy)) {
        return spy[0].callCount >= spy[1];
      }
      return spy.callCount >= 1;
    };
    let intrvl, timeo;
    function finish() {
      clearInterval(intrvl);
      clearTimeout(timeo);
      resolve();
    }
    intrvl = setInterval(() => {
      process.nextTick(() => {
        if (spies.every(isSpyReady)) finish();
      });
    }, 20);
    timeo = setTimeout(finish, 5000);
  });
};

const dateNow = () => Date.now().toString();

const runTests = (baseopts) => {
  let macosFswatch;
  let win32Polling;

  baseopts.persistent = true;

  before(() => {
    // flags for bypassing special-case test failures on CI
    macosFswatch = isMacos && !baseopts.usePolling && !baseopts.useFsEvents;
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
    beforeEach(() => {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = sinon.spy(function readySpy(){});
      rawSpy = sinon.spy(function rawSpy(){});
      watcher = chokidar_watch().on(EV_READY, readySpy).on(EV_RAW, rawSpy);
    });
    afterEach(async () => {
      await waitFor([readySpy]);
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
      const spy = await aspy(watcher, EV_ADD);
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
      watcher.on(EV_ADD, (path) => {
        spy(path);
      });

      await waitForWatcher(watcher);

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

      watcher2 = chokidar_watch().on(EV_READY, readySpy).on(EV_RAW, rawSpy);
      const spy = await aspy(watcher2, EV_ADD, null, true);

      await write(test1Path, dateNow());
      await write(test2Path, dateNow());
      await write(test3Path, dateNow());
      await write(test4Path, dateNow());
      await write(test5Path, dateNow());

      await delay(200);
      await write(test6Path, dateNow());
      await write(test7Path, dateNow());
      await write(test8Path, dateNow());
      await write(test9Path, dateNow());

      await delay(200);
      await write(testb1Path, dateNow());
      await write(testb2Path, dateNow());
      await write(testb3Path, dateNow());
      await write(testb4Path, dateNow());
      await write(testb5Path, dateNow());

      await delay(200);
      await write(testb6Path, dateNow());
      await write(testb7Path, dateNow());
      await write(testb8Path, dateNow());
      await write(testb9Path, dateNow());

      await delay(200);
      await write(testc1Path, dateNow());
      await write(testc2Path, dateNow());
      await write(testc3Path, dateNow());
      await write(testc4Path, dateNow());
      await write(testc5Path, dateNow());

      await delay(150);
      await write(testc6Path, dateNow());
      await write(testc7Path, dateNow());
      await write(testc8Path, dateNow());
      await write(testc9Path, dateNow());
      await write(testd1Path, dateNow());
      await write(teste1Path, dateNow());
      await write(testf1Path, dateNow());

      await delay(100);
      await write(testg1Path, dateNow());
      await write(testh1Path, dateNow());
      await write(testi1Path, dateNow());

      await delay(300);
      await waitFor([[spy, 11]]);
      await waitFor([[spy, 22]]);

      await delay(1000);
      await waitFor([[spy, 33]]);

      spy.should.have.been.calledWith(test1Path);
      spy.should.have.been.calledWith(test2Path);
      spy.should.have.been.calledWith(test3Path);
      spy.should.have.been.calledWith(test4Path);
      spy.should.have.been.calledWith(test5Path);
      spy.should.have.been.calledWith(test6Path);

      await delay(100);
      spy.should.have.been.calledWith(test7Path);
      spy.should.have.been.calledWith(test8Path);
      spy.should.have.been.calledWith(test9Path);
      spy.should.have.been.calledWith(testb1Path);
      spy.should.have.been.calledWith(testb2Path);
      spy.should.have.been.calledWith(testb3Path);
      spy.should.have.been.calledWith(testb4Path);
      spy.should.have.been.calledWith(testb5Path);
      spy.should.have.been.calledWith(testb6Path);
      await delay(100);

      spy.should.have.been.calledWith(testb7Path);
      spy.should.have.been.calledWith(testb8Path);
      spy.should.have.been.calledWith(testb9Path);
      spy.should.have.been.calledWith(testc1Path);
      spy.should.have.been.calledWith(testc2Path);
      spy.should.have.been.calledWith(testc3Path);
      spy.should.have.been.calledWith(testc4Path);

      await delay(100);
      spy.should.have.been.calledWith(testc5Path);
      spy.should.have.been.calledWith(testc6Path);
      spy.should.have.been.calledWith(testc7Path);
      spy.should.have.been.calledWith(testc8Path);
      spy.should.have.been.calledWith(testc9Path);

      await delay(100);
      spy.should.have.been.calledWith(testd1Path);
      spy.should.have.been.calledWith(teste1Path);
      spy.should.have.been.calledWith(testf1Path);
      spy.should.have.been.calledWith(testg1Path);
      spy.should.have.been.calledWith(testh1Path);
      spy.should.have.been.calledWith(testi1Path);
    });
    it('should emit `addDir` event when directory was added', async () => {
      const testDir = getFixturePath('subdir');
      const spy = await aspy(watcher, 'addDir');
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
      const spy = await aspy(watcher, EV_CHANGE);
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
      const spy = await aspy(watcher, EV_UNLINK);
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
      fs.mkdirSync(testDir, PERM_ARR);
      const spy = await aspy(watcher, EV_UNLINK_DIR);

      await delay();
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
      fs.mkdirSync(testDir, PERM_ARR);
      fs.mkdirSync(testDir2, PERM_ARR);
      fs.mkdirSync(testDir3, PERM_ARR);
      const spy = await aspy(watcher, EV_UNLINK_DIR);
      await waitFor([spy]);
      await pRimraf(testDir2); // test removing in one
      await waitFor([spy]);
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
      watcher.on(EV_UNLINK, unlinkSpy).on(EV_ADD, addSpy);
      await waitForWatcher(watcher);
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
      fs.writeFileSync(testPath, 'hello');
      watcher
        .on(EV_UNLINK, unlinkSpy)
        .on(EV_ADD, addSpy)
        .on(EV_CHANGE, changeSpy);
      await waitForWatcher(watcher);
      unlinkSpy.should.not.have.been.called;
      addSpy.should.not.have.been.called;
      changeSpy.should.not.have.been.called;
      await fs_unlink(testPath);
      await waitFor([unlinkSpy.withArgs(testPath)]);
      unlinkSpy.should.have.been.calledWith(testPath);

      await delay();
      await write(testPath, dateNow());
      await waitFor([addSpy.withArgs(testPath)]);
      addSpy.should.have.been.calledWith(testPath);
      changeSpy.should.not.have.been.called;
    });
    it('should not emit `unlink` for previously moved files', async () => {
      const unlinkSpy = sinon.spy(function unlink(){});
      const testPath = getFixturePath('change.txt');
      const newPath1 = getFixturePath('moved.txt');
      const newPath2 = getFixturePath('moved-again.txt');
      await aspy(watcher, EV_UNLINK, unlinkSpy);
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
      await waitForWatcher(watcher);
      watcher.add(testDir);
    });
    it('should notice when a file appears in a new directory', async () => {
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      const spy = await aspy(watcher, EV_ADD);
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
      watcher.on(EV_UNLINK_DIR, unlinkSpy).on(EV_ADD_DIR, addSpy);
      await waitForWatcher(watcher);
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
      watcher.on(EV_UNLINK_DIR, unlinkSpy).on(EV_ADD, addSpy);
      await waitForWatcher(watcher);

      await delay();
      await fs_rmdir(testPath);
      await delay();
      await write(testPath, 'file content');

      await waitFor([unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);
      await waitFor([addSpy]);
      addSpy.should.have.been.calledWith(testPath);
    });
    it('should emit `unlink` and `addDir` when file is replaced by dir', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = getFixturePath('fileDir');
      await write(testPath, 'file content');
      watcher.on(EV_UNLINK, unlinkSpy).on(EV_ADD_DIR, addSpy);
      await waitForWatcher(watcher);

      await delay();
      await fs_unlink(testPath);
      await delay();
      await fs_mkdir(testPath, PERM_ARR);

      await waitFor([unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);
      await waitFor([addSpy]);
      addSpy.should.have.been.calledWith(testPath);
    });
  });
  describe('watch individual files', () => {
    it('should detect changes', async () => {
      const testPath = getFixturePath('change.txt');
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV_CHANGE);
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(testPath);
    });
    it('should detect unlinks', async () => {
      const testPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV_UNLINK);

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
        .on(EV_UNLINK, unlinkSpy)
        .on(EV_ADD, addSpy);
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
      const spy = await aspy(watcher, EV_ALL);

      await delay();
      await write(siblingPath, dateNow());
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(EV_ADD, testPath);
    });

    it('should detect safe-edit', async () => {
      const testPath = getFixturePath('change.txt');
      const safePath = getFixturePath('tmp.txt');
      await write(testPath, dateNow());
      const watcher = chokidar_watch(testPath, options);
      const spy = await aspy(watcher, EV_ALL);

      await delay();
      await write(safePath, dateNow());
      await fs_rename(safePath, testPath);
      await delay(100);
      await write(safePath, dateNow());
      await fs_rename(safePath, testPath);
      await delay(100);
      await write(safePath, dateNow());
      await fs_rename(safePath, testPath);
      await waitFor([spy]);
      spy.withArgs(EV_CHANGE, testPath).should.have.been.calledThrice;
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
        const spy = await aspy(watcher, EV_UNLINK);

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
          .on(EV_UNLINK, unlinkSpy)
          .on(EV_ADD, addSpy);
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
          .on(EV_UNLINK, unlinkSpy)
          .on(EV_ADD, addSpy);
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
          .on(EV_UNLINK, unlinkSpy)
          .on(EV_ADD, addSpy);
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
          .on(EV_UNLINK, unlinkSpy)
          .on(EV_ADD, addSpy);
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
          .on(EV_UNLINK, unlinkSpy)
          .on(EV_ADD, addSpy);
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
      const spy = await aspy(watcher, EV_ADD);

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
      const spy = await aspy(watcher, EV_ADD);

      await delay();
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should watch non-existent dir and detect addDir/add', async () => {
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      const watcher = chokidar_watch(testDir, options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.not.have.been.called;

      await delay();
      await fs_mkdir(testDir, PERM_ARR);

      await delay();
      await write(testPath, 'hello');
      await waitFor([spy.withArgs(EV_ADD)]);
      spy.should.have.been.calledWith(EV_ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV_ADD, testPath);
    });
  });
  describe('watch glob patterns', () => {
    it('should correctly watch and emit based on glob input', async () => {
      const watchPath = getGlobPath('*a*.txt');
      const addPath = getFixturePath('add.txt');
      const changePath = getFixturePath('change.txt');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.have.been.calledWith(EV_ADD, changePath);

      await write(addPath, dateNow());
      await write(changePath, dateNow());

      await delay();
      await waitFor([[spy, 3], spy.withArgs(EV_ADD, addPath)]);
      spy.should.have.been.calledWith(EV_ADD, addPath);
      spy.should.have.been.calledWith(EV_CHANGE, changePath);
      spy.should.not.have.been.calledWith(EV_ADD, getFixturePath('unlink.txt'));
      spy.should.not.have.been.calledWith(EV_ADD_DIR);
    });
    it('should respect negated glob patterns', async () => {
      const watchPath = getGlobPath('*');
      const negatedWatchPath = `!${getGlobPath('*a*.txt')}`;
      const unlinkPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch([watchPath, negatedWatchPath], options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV_ADD, unlinkPath);

      await delay();
      await fs_unlink(unlinkPath);
      await waitFor([[spy, 2], spy.withArgs(EV_UNLINK)]);
      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV_UNLINK, unlinkPath);
    });
    it('should traverse subdirs to match globstar patterns', async () => {
      const watchPath = getGlobPath(`../../test-*/${subdirId}/**/a*.txt`);
      const addFile = getFixturePath('add.txt');
      const subdir = getFixturePath('subdir');
      const subsubdir = getFixturePath('subdir/subsub');
      const aFile = getFixturePath('subdir/a.txt');
      const bFile = getFixturePath('subdir/b.txt');
      const subFile = getFixturePath('subdir/subsub/ab.txt');
      fs.mkdirSync(subdir, PERM_ARR);
      fs.mkdirSync(subsubdir, PERM_ARR);
      fs.writeFileSync(aFile, 'b');
      fs.writeFileSync(bFile, 'b');
      fs.writeFileSync(subFile, 'b');

      await delay();
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV_ALL);
      await Promise.all([
        write(addFile, dateNow()),
        write(subFile, dateNow()),
        fs_unlink(aFile),
        fs_unlink(bFile)
      ]);

      await waitFor([spy.withArgs(EV_CHANGE)]);
      spy.withArgs(EV_CHANGE).should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV_CHANGE, subFile);

      await waitFor([spy.withArgs(EV_UNLINK)]);
      spy.withArgs(EV_UNLINK).should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV_UNLINK, aFile);

      await waitFor([[spy.withArgs(EV_ADD), 3]]);
      spy.withArgs(EV_ADD).should.have.been.calledThrice;
    });
    it('should resolve relative paths with glob patterns', async () => {
      const id = subdirId.toString();
      const watchPath = `test-*/${id}/*a*.txt`;
      // getFixturePath() returns absolute paths, so use sysPath.join() instead
      const addPath = sysPath.join(FIXTURES_PATH_REL, id, 'add.txt');
      const changePath = sysPath.join(FIXTURES_PATH_REL, id, 'change.txt');
      const unlinkPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV_ALL);

      spy.should.have.been.calledWith(EV_ADD);
      await Promise.all([
        write(addPath, dateNow()),
        write(changePath, dateNow())
      ]);
      await waitFor([[spy, 3], spy.withArgs(EV_ADD, addPath)]);
      spy.should.have.been.calledWith(EV_ADD, addPath);
      spy.should.have.been.calledWith(EV_CHANGE, changePath);
      spy.should.not.have.been.calledWith(EV_ADD, unlinkPath);
      spy.should.not.have.been.calledWith(EV_ADD_DIR);
      if (!macosFswatch) spy.should.have.been.calledThrice;
    });
    it('should correctly handle conflicting glob patterns', async () => {
      const changePath = getFixturePath('change.txt');
      const unlinkPath = getFixturePath('unlink.txt');
      const addPath = getFixturePath('add.txt');
      const watchPaths = [getGlobPath('change*'), getGlobPath('unlink*')];
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.have.been.calledWith(EV_ADD, changePath);
      spy.should.have.been.calledWith(EV_ADD, unlinkPath);
      spy.should.have.been.calledTwice;

      await delay();
      await fs_unlink(unlinkPath);
      await write(addPath, dateNow());
      await write(changePath, dateNow());

      await waitFor([[spy, 4], spy.withArgs(EV_UNLINK, unlinkPath)]);
      spy.should.have.been.calledWith(EV_CHANGE, changePath);
      spy.should.have.been.calledWith(EV_UNLINK, unlinkPath);
      spy.should.not.have.been.calledWith(EV_ADD, addPath);
      spy.callCount.should.equal(4);
    });
    it('should correctly handle intersecting glob patterns', async () => {
      const changePath = getFixturePath('change.txt');
      const watchPaths = [getGlobPath('cha*'), getGlobPath('*nge.*')];
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.have.been.calledWith(EV_ADD, changePath);
      spy.should.have.been.calledOnce;

      await write(changePath, dateNow());
      await delay();
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith(EV_CHANGE, changePath);
      spy.should.have.been.calledTwice;
    });
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = getFixturePath('nota[glob].txt');
      await write(filePath, 'b');
      await delay();
      const spy = await aspy(chokidar_watch(), EV_ALL);
      spy.should.have.been.calledWith(EV_ADD, filePath);

      await delay();
      await write(filePath, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV_CHANGE, filePath);
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
      const spy = await aspy(watcher, EV_ALL);

      spy.should.have.been.calledWith(EV_ADD, filePath);
      spy.should.not.have.been.calledWith(EV_ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV_ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV_ADD, matchingFile2);
      await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV_CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV_CHANGE, filePath);
    });
    it('should treat glob-like filenames as literal filenames when globbing is disabled', async () => {
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
      const spy = await aspy(watcher, EV_ALL);

      spy.should.have.been.calledWith(EV_ADD, filePath);
      spy.should.not.have.been.calledWith(EV_ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV_ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV_ADD, matchingFile2);
      await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV_CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV_CHANGE, filePath);
    });
    it('should not prematurely filter dirs against complex globstar patterns', async () => {
      const deepFile = getFixturePath('subdir/subsub/subsubsub/a.txt');
      const watchPath = getGlobPath(`../../test-*/${subdirId}/**/subsubsub/*.txt`);
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), PERM_ARR);
      fs.writeFileSync(deepFile, 'b');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV_ALL);

      await delay();
      await write(deepFile, dateNow());
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith(EV_ADD, deepFile);
      spy.should.have.been.calledWith(EV_CHANGE, deepFile);
    });
    it('should emit matching dir events', async () => {
      // test with and without globstar matches
      const watchPaths = [getGlobPath('*'), getGlobPath('subdir/subsub/**/*')];
      const deepDir = getFixturePath('subdir/subsub/subsubsub');
      const deepFile = sysPath.join(deepDir, 'a.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV_ALL);

      await waitFor([spy.withArgs(EV_ADD_DIR)]);
      spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('subdir'));
      spy.withArgs(EV_ADD_DIR).should.have.been.calledOnce;
      fs.mkdirSync(deepDir, PERM_ARR);
      fs.writeFileSync(deepFile, dateNow());

      await waitFor([[spy.withArgs(EV_ADD_DIR), 2], spy.withArgs(EV_ADD, deepFile)]);
      if (win32Polling) return true;

      spy.should.have.been.calledWith(EV_ADD_DIR, deepDir);
      fs.unlinkSync(deepFile);
      fs.rmdirSync(deepDir);

      await waitFor([spy.withArgs(EV_UNLINK_DIR)]);
      spy.should.have.been.calledWith(EV_UNLINK_DIR, deepDir);
    });
    it('should correctly handle glob with braces', async () => {
      const watchPath = upath.normalizeSafe(getGlobPath('{subdir/*,subdir1/subsub1}/subsubsub/*.txt'));
      const deepFileA = getFixturePath('subdir/subsub/subsubsub/a.txt');
      const deepFileB = getFixturePath('subdir1/subsub1/subsubsub/a.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir1'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir1/subsub1'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir1/subsub1/subsubsub'), PERM_ARR);
      fs.writeFileSync(deepFileA, dateNow());
      fs.writeFileSync(deepFileB, dateNow());
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV_ALL);

      spy.should.have.been.calledWith(EV_ADD, deepFileA);
      spy.should.have.been.calledWith(EV_ADD, deepFileB);
      fs.appendFileSync(deepFileA, dateNow());
      fs.appendFileSync(deepFileB, dateNow());

      await waitFor([[spy, 4]]);
      spy.should.have.been.calledWith(EV_CHANGE, deepFileA);
      spy.should.have.been.calledWith(EV_CHANGE, deepFileB);
    });
  });
  describe('watch symlinks', () => {
    if (isWindows) return true;
    let linkedDir;
    beforeEach(async () => {
      linkedDir = sysPath.resolve(currentDir, '..', `${subdirId}-link`);
      await fs_symlink(currentDir, linkedDir);
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
        .on(EV_ADD_DIR, dirSpy)
        .on(EV_ADD, addSpy);
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
      const spy = await aspy(watcher, EV_ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE)]);
      spy.should.have.been.calledWith(EV_ADD, linkPath);
      spy.should.have.been.calledWith(EV_CHANGE, linkPath);
    });
    it('should follow symlinked files within a normal dir', async () => {
      const changePath = getFixturePath('change.txt');
      const linkPath = getFixturePath('subdir/link.txt');
      fs.symlinkSync(changePath, linkPath);
      const watcher = chokidar_watch(getFixturePath('subdir'), options);
      const spy = await aspy(watcher, EV_ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE, linkPath)]);
      spy.should.have.been.calledWith(EV_ADD, linkPath);
      spy.should.have.been.calledWith(EV_CHANGE, linkPath);
    });
    it('should watch paths with a symlinked parent', async () => {
      const testDir = sysPath.join(linkedDir, 'subdir');
      const testFile = sysPath.join(testDir, 'add.txt');
      const watcher = chokidar_watch(testDir, options);
      const spy = await aspy(watcher, EV_ALL);

      spy.should.have.been.calledWith(EV_ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV_ADD, testFile);
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await waitFor([spy.withArgs(EV_CHANGE)]);
      spy.should.have.been.calledWith(EV_CHANGE, testFile);
    });
    it('should not recurse indefinitely on circular symlinks', async () => {
      await fs_symlink(currentDir, getFixturePath('subdir/circular'));
      return new Promise((resolve, reject) => {
        const watcher = chokidar_watch();
        watcher.on(EV_ERROR, resolve());
        watcher.on(EV_READY, reject('The watcher becomes ready, although he watches a circular symlink.'));
      })
    });
    it('should recognize changes following symlinked dirs', async () => {
      const linkedFilePath = sysPath.join(linkedDir, 'change.txt');
      const watcher = chokidar_watch(linkedDir, options);
      const spy = await aspy(watcher, EV_CHANGE);
      const wa = spy.withArgs(linkedFilePath);
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([wa]);
      spy.should.have.been.calledWith(linkedFilePath);
    });
    it('should follow newly created symlinks', async () => {
      options.ignoreInitial = true;
      const watcher = chokidar_watch();
      const spy = await aspy(watcher, EV_ALL);
      await delay();
      await fs_symlink(getFixturePath('subdir'), getFixturePath('link'));
      await waitFor([
        spy.withArgs(EV_ADD, getFixturePath('link/add.txt')),
        spy.withArgs(EV_ADD_DIR, getFixturePath('link'))
      ]);
      spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('link'));
      spy.should.have.been.calledWith(EV_ADD, getFixturePath('link/add.txt'));
    });
    it('should watch symlinks as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const watcher = chokidar_watch(linkedDir, options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.not.have.been.calledWith(EV_ADD_DIR);
      spy.should.have.been.calledWith(EV_ADD, linkedDir);
      spy.should.have.been.calledOnce;
    });
    it('should watch symlinks within a watched dir as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      // Create symlink in linkPath
      const linkPath = getFixturePath('link');
      fs.symlinkSync(getFixturePath('subdir'), linkPath);
      const spy = await aspy(chokidar_watch(), EV_ALL);
      await delay();
      setTimeout(() => {
        fs.writeFileSync(getFixturePath('subdir/add.txt'), dateNow());
        fs.unlinkSync(linkPath);
        fs.symlinkSync(getFixturePath('subdir/add.txt'), linkPath);
      }, options.usePolling ? 1200 : 300);

      await waitFor([spy.withArgs(EV_CHANGE, linkPath)]);
      spy.should.not.have.been.calledWith(EV_ADD_DIR, linkPath);
      spy.should.not.have.been.calledWith(EV_ADD, getFixturePath('link/add.txt'));
      spy.should.have.been.calledWith(EV_ADD, linkPath);
      spy.should.have.been.calledWith(EV_CHANGE, linkPath);
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
      const spy = await aspy(watcher, EV_ALL);

      await delay();
      await write(linkedFilePath, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE)]);
      spy.should.have.been.calledWith(EV_CHANGE, watchedPath);
    });
    it('should properly match glob patterns that include a symlinked dir', async () => {
      const dirSpy = sinon.spy(function dirSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      // test with relative path to ensure proper resolution
      const watchDir = upath.relative(process.cwd(), linkedDir);
      const watcher = chokidar_watch(upath.join(watchDir, '**/*'), options)
        .on(EV_ADD_DIR, dirSpy)
        .on(EV_ADD, addSpy);
      await waitForWatcher(watcher);
      // only the children are matched by the glob pattern, not the link itself
      addSpy.should.have.been.calledThrice; // also unlink.txt & subdir/add.txt
      addSpy.should.have.been.calledWith(sysPath.join(watchDir, 'change.txt'));
      dirSpy.should.have.been.calledWith(sysPath.join(watchDir, 'subdir'));
      await write(sysPath.join(watchDir, 'add.txt'), '');
      await waitFor([[addSpy, 4]]);
      addSpy.should.have.been.calledWith(sysPath.join(watchDir, 'add.txt'));
    });
    it('should emit ready event even when broken symlinks are encountered', async () => {
      const targetDir = getFixturePath('subdir/nonexistent');
      await fs_mkdir(targetDir);
      await fs_symlink(targetDir, getFixturePath('subdir/broken'));
      await fs_rmdir(targetDir);
      const readySpy = sinon.spy(function readySpy(){});
      const watcher = chokidar_watch(getFixturePath('subdir'), options)
          .on(EV_READY, readySpy);
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
      const spy = await aspy(watcher, EV_ALL);
      spy.should.have.been.calledWith(EV_ADD, testPath);
      spy.should.have.been.calledWith(EV_ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV_ADD, getFixturePath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE)]);
      spy.should.have.been.calledWith(EV_CHANGE, testPath);
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      await fs_mkdir(testDir);
      const watcher = chokidar_watch([[testDir], [testPath]], options);
      const spy = await aspy(watcher, EV_ALL);
      spy.should.have.been.calledWith(EV_ADD, testPath);
      spy.should.have.been.calledWith(EV_ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV_ADD, getFixturePath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE)]);
      spy.should.have.been.calledWith(EV_CHANGE, testPath);
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
          const spy = await aspy(watcher, EV_ADD);
          spy.should.have.been.calledTwice;
        });
        it('should emit `addDir` event for watched dir', async () => {
          const watcher = chokidar_watch(currentDir, options);
          const spy = await aspy(watcher, EV_ADD_DIR);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(currentDir);
        });
        it('should emit `addDir` events for preexisting dirs', async () => {
          await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
          await fs_mkdir(getFixturePath('subdir/subsub'), PERM_ARR);
          const watcher = chokidar_watch(currentDir, options);
          const spy = await aspy(watcher, EV_ADD_DIR);
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
          const spy = await aspy(watcher, EV_ADD);
          await delay();
          spy.should.not.have.been.called;
        });
        it('should ignore add events on a subsequent .add()', async () => {
          const watcher = chokidar_watch(getFixturePath('subdir'), options);
          const spy = await aspy(watcher, EV_ADD);
          watcher.add(currentDir);
          await delay(1000);
          spy.should.not.have.been.called;
        });
        it('should notice when a file appears in an empty directory', async () => {
          const testDir = getFixturePath('subdir');
          const testPath = getFixturePath('subdir/add.txt');
          const spy = await aspy(chokidar_watch(), EV_ADD);
          spy.should.not.have.been.called;
          await fs_mkdir(testDir, PERM_ARR);
          await write(testPath, dateNow());
          await waitFor([spy]);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
        });
        it('should emit a change on a preexisting file as a change', async () => {
          const testPath = getFixturePath('change.txt');
          const spy = await aspy(chokidar_watch(), EV_ALL);
          spy.should.not.have.been.called;
          await write(testPath, dateNow());
          await waitFor([spy.withArgs(EV_CHANGE, testPath)]);
          spy.should.have.been.calledWith(EV_CHANGE, testPath);
          spy.should.not.have.been.calledWith(EV_ADD);
        });
        it('should not emit for preexisting dirs when depth is 0', async () => {
          options.depth = 0;
          const testPath = getFixturePath('add.txt');
          await fs_mkdir(getFixturePath('subdir'), PERM_ARR);

          await delay(200);
          const spy = await aspy(chokidar_watch(), EV_ALL);
          await write(testPath, dateNow());
          await waitFor([spy]);

          await delay(200);
          spy.should.have.been.calledWith(EV_ADD, testPath);
          spy.should.not.have.been.calledWith(EV_ADD_DIR);
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
        const spy = await aspy(watcher, EV_ADD);
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
        const spy = await aspy(watcher, EV_ALL);

        await delay();
        await write(testFile, dateNow());

        await delay(300);
        spy.should.not.have.been.calledWith(EV_ADD_DIR, testDir);
        spy.should.not.have.been.calledWith(EV_ADD, testFile);
        spy.should.not.have.been.calledWith(EV_CHANGE, testFile);
      });
      it('should allow regex/fn ignores', async () => {
        options.cwd = currentDir;
        options.ignored = /add/;

        fs.writeFileSync(getFixturePath('add.txt'), 'b');
        const watcher = chokidar_watch(currentDir, options);
        const spy = await aspy(watcher, EV_ALL);

        await delay();
        await write(getFixturePath('add.txt'), dateNow());
        await write(getFixturePath('change.txt'), dateNow());

        await waitFor([spy.withArgs(EV_CHANGE, 'change.txt')]);
        spy.should.not.have.been.calledWith(EV_ADD, 'add.txt');
        spy.should.not.have.been.calledWith(EV_CHANGE, 'add.txt');
        spy.should.have.been.calledWith(EV_ADD, 'change.txt');
        spy.should.have.been.calledWith(EV_CHANGE, 'change.txt');
      });
    });
    describe('depth', () => {
      beforeEach(async () => {
        await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
        await write(getFixturePath('subdir/add.txt'), 'b');
        await delay(options.useFsEvents && 200);
        await fs_mkdir(getFixturePath('subdir/subsub'), PERM_ARR);
        await write(getFixturePath('subdir/subsub/ab.txt'), 'b');
        await delay(options.useFsEvents && 200);
      });
      it('should not recurse if depth is 0', async () => {
        options.depth = 0;
        const watcher = chokidar_watch();
        const spy = await aspy(watcher, EV_ALL);
        await write(getFixturePath('subdir/add.txt'), dateNow());
        await waitFor([[spy, 4]]);
        spy.should.have.been.calledWith(EV_ADD_DIR, currentDir);
        spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('subdir'));
        spy.should.have.been.calledWith(EV_ADD, getFixturePath('change.txt'));
        spy.should.have.been.calledWith(EV_ADD, getFixturePath('unlink.txt'));
        spy.should.not.have.been.calledWith(EV_CHANGE);
        if (!macosFswatch) spy.callCount.should.equal(4);
      });
      it('should recurse to specified depth', async () => {
        options.depth = 1;
        const addPath = getFixturePath('subdir/add.txt');
        const changePath = getFixturePath('change.txt');
        const ignoredPath = getFixturePath('subdir/subsub/ab.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await delay();
        await write(getFixturePath('change.txt'), dateNow());
        await write(addPath, dateNow());
        await write(ignoredPath, dateNow());
        await waitFor([spy.withArgs(EV_CHANGE, addPath), spy.withArgs(EV_CHANGE, changePath)]);
        spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('subdir/subsub'));
        spy.should.have.been.calledWith(EV_CHANGE, changePath);
        spy.should.have.been.calledWith(EV_CHANGE, addPath);
        spy.should.not.have.been.calledWith(EV_ADD, ignoredPath);
        spy.should.not.have.been.calledWith(EV_CHANGE, ignoredPath);
        if (!macosFswatch) spy.callCount.should.equal(8);
      });
      it('should respect depth setting when following symlinks', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        await fs_symlink(getFixturePath('subdir'), getFixturePath('link'));
        await delay();
        const spy = await aspy(chokidar_watch(), EV_ALL);
        spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('link'));
        spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('link/subsub'));
        spy.should.have.been.calledWith(EV_ADD, getFixturePath('link/add.txt'));
        spy.should.not.have.been.calledWith(EV_ADD, getFixturePath('link/subsub/ab.txt'));
      });
      it('should respect depth setting when following a new symlink', async () => {
        if (isWindows) return true; // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        const linkPath = getFixturePath('link');
        const dirPath = getFixturePath('link/subsub');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await fs_symlink(getFixturePath('subdir'), linkPath);
        await waitFor([[spy, 3], spy.withArgs(EV_ADD_DIR, dirPath)]);
        spy.should.have.been.calledWith(EV_ADD_DIR, linkPath);
        spy.should.have.been.calledWith(EV_ADD_DIR, dirPath);
        spy.should.have.been.calledWith(EV_ADD, getFixturePath('link/add.txt'));
        spy.should.have.been.calledThrice;
      });
      it('should correctly handle dir events when depth is 0', async () => {
        options.depth = 0;
        const subdir2 = getFixturePath('subdir2');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        const addSpy = spy.withArgs(EV_ADD_DIR);
        const unlinkSpy = spy.withArgs(EV_UNLINK_DIR);
        spy.should.have.been.calledWith(EV_ADD_DIR, currentDir);
        spy.should.have.been.calledWith(EV_ADD_DIR, getFixturePath('subdir'));
        await fs_mkdir(subdir2, PERM_ARR);
        await waitFor([[addSpy, 3]]);
        addSpy.should.have.been.calledThrice;

        await fs_rmdir(subdir2);
        await waitFor([unlinkSpy]);
        await delay();
        unlinkSpy.should.have.been.calledWith(EV_UNLINK_DIR, subdir2);
        unlinkSpy.should.have.been.calledOnce;
      });
    });
    describe('atomic', () => {
      beforeEach(() => {
        options.atomic = true;
        options.ignoreInitial = true;
      });
      it('should ignore vim/emacs/Sublime swapfiles', async () => {
        const spy = await aspy(chokidar_watch(), EV_ALL);
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
        const spy = await aspy(chokidar_watch(), EV_ALL);
        spy.should.not.have.been.calledWith(getFixturePath('old.txt'));
        spy.should.not.have.been.calledWith(getFixturePath('old.txt~'));
      });
    });
    describe('cwd', () => {
      it('should emit relative paths based on cwd', async () => {
        options.cwd = currentDir;
        const watcher = chokidar_watch('**', options);
        const spy = await aspy(watcher, EV_ALL);
        await fs_unlink(getFixturePath('unlink.txt'));
        await write(getFixturePath('change.txt'), dateNow());
        await waitFor([spy.withArgs(EV_UNLINK)]);
        spy.should.have.been.calledWith(EV_ADD, 'change.txt');
        spy.should.have.been.calledWith(EV_ADD, 'unlink.txt');
        spy.should.have.been.calledWith(EV_CHANGE, 'change.txt');
        spy.should.have.been.calledWith(EV_UNLINK, 'unlink.txt');
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
          watcher.on(EV_ADD_DIR, spy);
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
        const watcher = chokidar_watch(getGlobPath('**'), options);
        const spy1 = await aspy(watcher, EV_ALL);

        await delay();
        const watcher2 = chokidar_watch(currentDir, options2);
        const spy2 = await aspy(watcher2, EV_ALL);

        await fs_unlink(getFixturePath('unlink.txt'));
        await write(getFixturePath('change.txt'), dateNow());
        await waitFor([spy1.withArgs(EV_UNLINK), spy2.withArgs(EV_UNLINK)]);
        spy1.should.have.been.calledWith(EV_CHANGE, 'change.txt');
        spy1.should.have.been.calledWith(EV_UNLINK, 'unlink.txt');
        spy2.should.have.been.calledWith(EV_ADD, sysPath.join('..', 'change.txt'));
        spy2.should.have.been.calledWith(EV_ADD, sysPath.join('..', 'unlink.txt'));
        spy2.should.have.been.calledWith(EV_CHANGE, sysPath.join('..', 'change.txt'));
        spy2.should.have.been.calledWith(EV_UNLINK, sysPath.join('..', 'unlink.txt'));
      });
      it('should ignore files even with cwd', async () => {
        options.cwd = currentDir;
        options.ignored = 'ignored-option.txt';
        const files = [
          '*.txt',
          '!ignored.txt'
        ];
        fs.writeFileSync(getFixturePath('change.txt'), 'hello');
        fs.writeFileSync(getFixturePath('ignored.txt'), 'ignored');
        fs.writeFileSync(getFixturePath('ignored-option.txt'), 'ignored option');
        const watcher = chokidar_watch(files, options);

        const spy = await aspy(watcher, EV_ALL);
        fs.writeFileSync(getFixturePath('ignored.txt'), dateNow());
        fs.writeFileSync(getFixturePath('ignored-option.txt'), dateNow());
        await fs_unlink(getFixturePath('ignored.txt'));
        await fs_unlink(getFixturePath('ignored-option.txt'));
        await delay();
        await write(getFixturePath('change.txt'), EV_CHANGE);
        await waitFor([spy.withArgs(EV_CHANGE, 'change.txt')]);
        spy.should.have.been.calledWith(EV_ADD, 'change.txt');
        spy.should.not.have.been.calledWith(EV_ADD, 'ignored.txt');
        spy.should.not.have.been.calledWith(EV_ADD, 'ignored-option.txt');
        spy.should.not.have.been.calledWith(EV_CHANGE, 'ignored.txt');
        spy.should.not.have.been.calledWith(EV_CHANGE, 'ignored-option.txt');
        spy.should.not.have.been.calledWith(EV_UNLINK, 'ignored.txt');
        spy.should.not.have.been.calledWith(EV_UNLINK, 'ignored-option.txt');
        spy.should.have.been.calledWith(EV_CHANGE, 'change.txt');
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
          const spy = await aspy(chokidar_watch(), EV_ALL);
          spy.should.not.have.been.calledWith(EV_ADD, filePath);
          await write(filePath, dateNow());

          await delay(200);
          spy.should.not.have.been.calledWith(EV_CHANGE, filePath);
        });
      });
      describe('true', () => {
        beforeEach(() => { options.ignorePermissionErrors = true; });
        it('should watch unreadable files if possible', async () => {
          const spy = await aspy(chokidar_watch(), EV_ALL);
          spy.should.have.been.calledWith(EV_ADD, filePath);
          if (!options.useFsEvents) return true;
          await write(filePath, dateNow());
          await waitFor([spy.withArgs(EV_CHANGE)]);
          spy.should.have.been.calledWith(EV_CHANGE, filePath);
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
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await write(testPath, 'hello');
        await delay(200);
        spy.should.not.have.been.calledWith(EV_ADD);
      });
      it('should wait for the file to be fully written before emitting the add event', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await write(testPath, 'hello');

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith(EV_ADD, testPath);
      });
      it('should emit with the final stats', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await write(testPath, 'hello ');

        await delay(300);
        fs.appendFileSync(testPath, 'world!');

        await waitFor([spy]);
        spy.should.have.been.calledWith(EV_ADD, testPath);
        expect(spy.args[0][2].size).to.equal(12);
      });
      it('should not emit change event while a file has not been fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await write(testPath, 'hello');
        await delay(100);
        await write(testPath, 'edit');
        await delay(200);
        spy.should.not.have.been.calledWith(EV_CHANGE, testPath);
      });
      it('should not emit change event before an existing file is fully updated', async () => {
        const testPath = getFixturePath('change.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await write(testPath, 'hello');
        await delay(300);
        spy.should.not.have.been.calledWith(EV_CHANGE, testPath);
      });
      it('should wait for an existing file to be fully updated before emitting the change event', async () => {
        const testPath = getFixturePath('change.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        fs.writeFile(testPath, 'hello', () => {});

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith(EV_CHANGE, testPath);
      });
      it('should emit change event after the file is fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await delay();
        await write(testPath, 'hello');

        await waitFor([spy]);
        spy.should.have.been.calledWith(EV_ADD, testPath);
        await write(testPath, 'edit');
        await waitFor([spy.withArgs(EV_CHANGE)]);
        spy.should.have.been.calledWith(EV_CHANGE, testPath);
      });
      it('should not raise any event for a file that was deleted before fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(chokidar_watch(), EV_ALL);
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
        const spy = await aspy(chokidar_watch(), EV_ALL);

        await delay(400);
        await write(testPath, 'hello');

        await waitFor([spy.withArgs(EV_ADD)]);
        spy.should.have.been.calledWith(EV_ADD, filename);
      });
      it('should still emit initial add events', async () => {
        options.ignoreInitial = false;
        const spy = await aspy(chokidar_watch(), EV_ALL);
        spy.should.have.been.calledWith(EV_ADD);
        spy.should.have.been.calledWith(EV_ADD_DIR);
      });
      it('should emit an unlink event when a file is updated and deleted just after that', async () => {
        const testPath = getFixturePath('subdir/add.txt');
        const filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        await fs_mkdir(options.cwd);
        await delay();
        await write(testPath, 'hello');
        await delay();
        const spy = await aspy(chokidar_watch(), EV_ALL);
        await write(testPath, 'edit');
        await delay();
        await fs_unlink(testPath);
        await waitFor([spy.withArgs(EV_UNLINK)]);
        spy.should.have.been.calledWith(EV_UNLINK, filename);
        spy.should.not.have.been.calledWith(EV_CHANGE, filename);
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
          let intrvl, to;
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
          .on(EV_ALL, spy)
          .on(EV_READY, () => {
            fs.writeFile(testPath, 'hello', simpleCb);
            _waitFor([spy], () => {
              spy.should.have.been.calledWith(EV_ADD, testPath);
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
                  _waitFor([spy.withArgs(EV_UNLINK)], w(() => {
                    // Wait a while after unlink to ensure stat() had time to return. That's where
                    // an uncaught exception used to happen.
                    spy.should.have.been.calledWith(EV_UNLINK, testPath);
                    spy.should.not.have.been.calledWith(EV_CHANGE);
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
      const spy = await aspy(watcher, EV_ALL);
      watcher.unwatch(getFixturePath('subdir'));

      await delay();
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV_CHANGE, getFixturePath('change.txt'));
      spy.should.not.have.been.calledWith(EV_ADD);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should ignore unwatched paths that are a subset of watched paths', async () => {
      const subdirRel = upath.relative(process.cwd(), getFixturePath('subdir'));
      const unlinkFile = getFixturePath('unlink.txt');
      const addFile = getFixturePath('subdir/add.txt');
      const changedFile = getFixturePath('change.txt');
      const watcher = chokidar_watch(currentDir, options);
      const spy = await aspy(watcher, EV_ALL);

      // test with both relative and absolute paths
      watcher.unwatch([subdirRel, getGlobPath('unl*')]);

      await delay();
      await fs_unlink(unlinkFile);
      await write(addFile, dateNow());
      await write(changedFile, dateNow());
      await waitFor([spy.withArgs(EV_CHANGE)]);

      await delay(300);
      spy.should.have.been.calledWith(EV_CHANGE, changedFile);
      spy.should.not.have.been.calledWith(EV_ADD, addFile);
      spy.should.not.have.been.calledWith(EV_UNLINK, unlinkFile);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch relative paths', async () => {
      const fixturesDir = sysPath.relative(process.cwd(), currentDir);
      const subdir = sysPath.join(fixturesDir, 'subdir');
      const changeFile = sysPath.join(fixturesDir, 'change.txt');
      const watchPaths = [subdir, changeFile];
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV_ALL);

      await delay();
      watcher.unwatch(subdir);
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV_CHANGE, changeFile);
      spy.should.not.have.been.calledWith(EV_ADD);
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
      watcher.on(EV_ALL, spy).add(getFixturePath('change.txt'));

      await delay();
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(EV_CHANGE, getFixturePath('change.txt'));
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch paths that are relative to options.cwd', async () => {
      options.cwd = currentDir;
      const watcher = chokidar_watch('.', options);
      const spy = await aspy(watcher, EV_ALL);
      watcher.unwatch(['subdir', getFixturePath('unlink.txt')]);

      await delay();
      await fs_unlink(getFixturePath('unlink.txt'));
      await write(getFixturePath('subdir/add.txt'), dateNow());
      await write(getFixturePath('change.txt'), dateNow());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith(EV_CHANGE, 'change.txt');
      spy.should.not.have.been.calledWith(EV_ADD);
      spy.should.not.have.been.calledWith(EV_UNLINK);
      if (!macosFswatch) spy.should.have.been.calledOnce;
    });
  });
  describe('close', () => {
    it('should ignore further events on close', async () => {
      return new Promise((resolve) => {
        const spy = sinon.spy();
        const watcher = chokidar_watch(currentDir, options);
        watcher.once(EV_ADD, () => {
          watcher.once(EV_ADD, async () => {
            await watcher.on(EV_ADD, spy).close();
            await delay(900);
            await write(getFixturePath('add.txt'), dateNow());
            spy.should.not.have.been.called;
            resolve();
          });
        });
        (async () => {
          await waitForWatcher(watcher);
          await write(getFixturePath('add.txt'), 'hello');
          await fs_unlink(getFixturePath('add.txt'));
        })();
      });
    });
    it('should not ignore further events on close with existing watchers', async () => {
      return new Promise((resolve) => {
        const watcher1 = chokidar_watch(currentDir);
        const watcher2 = chokidar_watch(currentDir);
        // The EV_ADD event should be called on the second watcher even if the first watcher is closed
        watcher2.on(EV_ADD, () => {
          watcher2.on(EV_ADD, (path) => {
            if (path.endsWith('add.txt')) {
              resolve();
            }
          })
        });
        (async () => {
          await waitForWatcher(watcher1);
          await waitForWatcher(watcher2);
          // Watcher 1 is closed to ensure events only happen on watcher 2
          await watcher1.close();
          // Write a new file into the fixtures to test the EV_ADD event
          await write(getFixturePath('add.txt'), 'hello');
          // Ensures EV_ADD is called. Immediately removing the file causes it to be skipped
          await delay(200);
          await fs_unlink(getFixturePath('add.txt'));
        })()
      })
    });
    it('should not prevent the process from exiting', async () => {
      const scriptFile = getFixturePath('script.js');
      const scriptContent = `
        const chokidar = require("${__dirname.replace(/\\/g, '\\\\')}");
        const watcher = chokidar.watch("${scriptFile.replace(/\\/g, '\\\\')}");
        watcher.on("ready", () => {
          watcher.close();
          process.stdout.write("closed");
        });`;
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
  describe('env variable option override', () => {
    beforeEach(() => {
      // Do not spin up
      options.useFsEvents = false;
    });
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
    if (options && options.usePolling && !options.useFsEvents) {
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
  describe('reproduction of bug in issue #1024', () => {
    it('should detect changes to folders, even if they were deleted before', async () => {
      const id = subdirId.toString();
      const relativeWatcherDir = sysPath.join(FIXTURES_PATH_REL, id, 'test');
      const watcher = chokidar.watch(relativeWatcherDir, {
        persistent: true,
      });
      try {
        const events = [];
        watcher.on('all', (event, path) =>
          events.push(`[ALL] ${event}: ${path}`)
        );
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
        await write(testSubDirFile, '');
        await delay(300);
        
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
      await fs_symlink(sysPath.resolve(relativeWatcherDir), linkedRelativeWatcherDir);
      const watcher = chokidar.watch(linkedRelativeWatcherDir, {
        persistent: true,
      });
      try {
        const events = [];
        watcher.on('all', (event, path) =>
          events.push(`[ALL] ${event}: ${path}`)
        );
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
        await write(testSubDirFile, '');
        await delay(300);
        
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
};

describe('chokidar', () => {
  before(async () => {
    await pRimraf(FIXTURES_PATH);
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
    await pRimraf(FIXTURES_PATH);
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

  if (isMacos) {
    const FsEventsHandler = require('./lib/fsevents-handler');
    if (FsEventsHandler.canUse()) {
      describe('fsevents (native extension)', runTests.bind(this, {useFsEvents: true}));
    }
  }
  if(!isIBMi) {
    describe('fs.watch (non-polling)', runTests.bind(this, {usePolling: false, useFsEvents: false}));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, {usePolling: true, interval: 10}));
});
