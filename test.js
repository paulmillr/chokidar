'use strict';

const chokidar = require('./');
const promisify = require('util').promisify;
const chai = require('chai');
const expect = chai.expect;
const should = chai.should();
const sinon = require('sinon');
const rimraf = promisify(require('rimraf'));
const fs = require('fs');
const sysPath = require('path');
const upath = require("upath");
const exec = promisify(require('child_process').exec);
chai.use(require('sinon-chai'));
const os = process.platform;

// const fs_promises = require('fs').promises;
const write = promisify(fs.writeFile);
const fs_symlink = promisify(fs.symlink);
const fs_rename = promisify(fs.rename);
const fs_mkdir = promisify(fs.mkdir);
const fs_rmdir = promisify(fs.rmdir);
const fs_unlink = promisify(fs.unlink);

const isTravisMac = process.env.TRAVIS && os === 'darwin';

// spyOnReady
const aspy = (watcher, eventName, spy=null, noStat=false) => {
  if (typeof eventName !== 'string') {
    throw new TypeError('aspy: eventName must be a String');
  }
  if (spy == null) spy = sinon.spy();
  return new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('ready', () => { resolve(spy); });
    watcher.on(eventName, noStat ? (path => spy(path)) : spy);
  });
};

const waitForWatcher = (watcher) => {
  return new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('ready', resolve);
  });
};

/** @type {chokidar.FSWatcher=} */
let watcher;
/** @type {chokidar.FSWatcher=} */
let watcher2;
let usedWatchers = [];
let fixturesPath;
let subdir = 0;
let options;
let osXFsWatch;
let win32Polling;
let slowerDelay;
const PERM_ARR = 0o755; // rwe, r+e, r+e

const delay = async (time) => {
  return new Promise((resolve) => {
    const timer = time || slowerDelay || 20;
    setTimeout(resolve, timer);
  });
};

const getFixturePath = (subPath) => {
  const subd = subdir && subdir.toString() || '';
  return sysPath.join(__dirname, 'test-fixtures', subd, subPath);
};
const getGlobPath = (subPath) => {
  const subd = subdir && subdir.toString() || '';
  return upath.join(__dirname, 'test-fixtures', subd, subPath);
};
fixturesPath = getFixturePath('');

const closeWatchers = async () => {
  let u;
  while (u = usedWatchers.pop()) u.close();
  if (isTravisMac) {
    await delay(500);
    return true;
  } else {
    return true;
  }
};

const runTests = function(baseopts) {
  baseopts.persistent = true;

  before(function() {
    // flags for bypassing special-case test failures on CI
    osXFsWatch = os === 'darwin' && !baseopts.usePolling && !baseopts.useFsEvents;
    win32Polling = os === 'win32' && baseopts.usePolling;
    slowerDelay = osXFsWatch ? 900 : undefined;
  });

  after(closeWatchers);

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach(function(key) {
      options[key] = baseopts[key];
    });
  });

  function stdWatcher() {
    watcher = chokidar.watch(fixturesPath, options);
    return watcher;
  }

  const waitFor = async (spies) => {
    if (spies.length === 0) throw new TypeError('SPies zero');
    return new Promise((resolve, reject) => {
      const isSpyReady = (spy) => {
        if (Array.isArray(spy)) {
          return spy[0].callCount >= spy[1];
        } else {
          return spy.callCount >= 1;
        }
      };
      let intrvl, timeo;
      function finish() {
        clearInterval(intrvl);
        clearTimeout(timeo);
        resolve();
      }
      intrvl = setInterval(() => {
        if (spies.every(isSpyReady)) finish();
      }, 20);
      timeo = setTimeout(finish, 3500);
    });
  };

  describe('watch a directory', function() {
    var readySpy, rawSpy;
    beforeEach(function() {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = sinon.spy(function readySpy(){});
      rawSpy = sinon.spy(function rawSpy(){});
      stdWatcher().on('ready', readySpy).on('raw', rawSpy);
    });
    afterEach(async () => {
      await waitFor([readySpy]);
      readySpy.should.have.been.calledOnce;
      readySpy = undefined;
      rawSpy = undefined;
      await closeWatchers();
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
      const spy = await aspy(watcher, 'add');
      await delay();
      await write(testPath, Date.now());
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
      watcher.on('add', (path) => {
        spy(path);
      });
      await waitForWatcher(watcher);

      await delay();

      (async () => {
        for (let path of paths.slice(0, 5)) {
          await write(path, Date.now());
        }
        await delay(100);
        for (let path of paths.slice(5)) {
          await write(path, Date.now());
        }
        delay();
      })();

      await waitFor([[spy, 9]]);
      paths.forEach(path => {
        spy.should.have.been.calledWith(path);
      });
    });
    it('should emit thirtythree `add` events when thirtythree files were added in nine directories', async () => {
      watcher.close();

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

      watcher2 = stdWatcher().on('ready', readySpy).on('raw', rawSpy);
      const spy = await aspy(watcher2, 'add', null, true);

      await write(test1Path, Date.now());
      await write(test2Path, Date.now());
      await write(test3Path, Date.now());
      await write(test4Path, Date.now());
      await write(test5Path, Date.now());

      await delay(200);
      await write(test6Path, Date.now());
      await write(test7Path, Date.now());
      await write(test8Path, Date.now());
      await write(test9Path, Date.now());
      await write(testb1Path, Date.now());
      await write(testb2Path, Date.now());
      await write(testb3Path, Date.now());
      await write(testb4Path, Date.now());
      await write(testb5Path, Date.now());

      await delay(200);
      await write(testb6Path, Date.now());
      await write(testb7Path, Date.now());
      await write(testb8Path, Date.now());
      await write(testb9Path, Date.now());
      await write(testc1Path, Date.now());
      await write(testc2Path, Date.now());
      await write(testc3Path, Date.now());
      await write(testc4Path, Date.now());
      await write(testc5Path, Date.now());

      await delay(150);
      await write(testc6Path, Date.now());
      await write(testc7Path, Date.now());
      await write(testc8Path, Date.now());
      await write(testc9Path, Date.now());
      await write(testd1Path, Date.now());
      await write(teste1Path, Date.now());
      await write(testf1Path, Date.now());

      await delay(100);
      await write(testg1Path, Date.now());
      await write(testh1Path, Date.now());
      await write(testi1Path, Date.now());
      await waitFor([[spy, 33]]);

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
      const spy = await aspy(watcher, 'change');
      spy.should.not.have.been.called;
      await write(testPath, Date.now());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit `unlink` event when file was removed', async () => {
      const testPath = getFixturePath('unlink.txt');
      const spy = await aspy(watcher, 'unlink');
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
      const spy = await aspy(watcher, 'unlinkDir');

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
      const spy = await aspy(watcher, 'unlinkDir');
      await rimraf(testDir2); // test removing in one
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
      watcher.on('unlink', unlinkSpy).on('add', addSpy);
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
      if (!osXFsWatch) unlinkSpy.should.have.been.calledOnce;
    });
    it('should emit `add`, not `change`, when previously deleted file is re-added', async () => {
      const unlinkSpy = sinon.spy(function unlink(){});
      const addSpy = sinon.spy(function add(){});
      const changeSpy = sinon.spy(function change(){});
      const testPath = getFixturePath('add.txt');
      fs.writeFileSync(testPath, 'hello');
      watcher
        .on('unlink', unlinkSpy)
        .on('add', addSpy)
        .on('change', changeSpy);
      await waitForWatcher(watcher);
      unlinkSpy.should.not.have.been.called;
      addSpy.should.not.have.been.called;
      changeSpy.should.not.have.been.called;
      await fs_unlink(testPath);
      await waitFor([unlinkSpy.withArgs(testPath)]);
      unlinkSpy.should.have.been.calledWith(testPath);

      await delay();
      await write(testPath, Date.now());
      await waitFor([addSpy.withArgs(testPath)]);
      addSpy.should.have.been.calledWith(testPath);
      changeSpy.should.not.have.been.called;
    });
    it('should not emit `unlink` for previously moved files', async () => {
      const unlinkSpy = sinon.spy(function unlink(){});
      const testPath = getFixturePath('change.txt');
      const newPath1 = getFixturePath('moved.txt');
      const newPath2 = getFixturePath('moved-again.txt');
      await aspy(watcher, 'unlink', unlinkSpy);
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
      const spy = await aspy(watcher, 'add');
      spy.should.not.have.been.called;
      await fs_mkdir(testDir, PERM_ARR);
      await write(testPath, Date.now());
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
      watcher.on('unlinkDir', unlinkSpy).on('addDir', addSpy);
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
  });
  describe('watch individual files', function() {
    before(closeWatchers);
    it('should detect changes', async () => {
      const testPath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options);
      const spy = await aspy(watcher, 'change');
      await write(testPath, Date.now());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith(testPath);
    });
    it('should detect unlinks', async () => {
      const testPath = getFixturePath('unlink.txt');
      watcher = chokidar.watch(testPath, options);
      const spy = await aspy(watcher, 'unlink');

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
      watcher = chokidar.watch([testPath], options)
        .on('unlink', unlinkSpy)
        .on('add', addSpy);
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
      watcher = chokidar.watch(testPath, options);
      const spy = await aspy(watcher, 'all');

      await delay();
      await write(siblingPath, Date.now());
      await write(testPath, Date.now());
      await waitFor([spy]);
      spy.should.have.always.been.calledWith('add', testPath);
    });

    // PR 682 is failing.
    describe.skip('Skipping gh-682: should detect unlink', function() {
      it('should detect unlink while watching a non-existent second file in another directory', async () => {
        const testPath = getFixturePath('unlink.txt');
        const otherDirPath = getFixturePath('other-dir');
        const otherPath = getFixturePath('other-dir/other.txt');
        fs.mkdirSync(otherDirPath, PERM_ARR);
        watcher = chokidar.watch([testPath, otherPath], options);
        // intentionally for this test don't write fs.writeFileSync(otherPath, 'other');
        const spy = await aspy(watcher, 'unlink');

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
        watcher = chokidar.watch([testPath, otherPath], options)
          .on('unlink', unlinkSpy)
          .on('add', addSpy);
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
        watcher = chokidar.watch([testPath, otherPath], options)
          .on('unlink', unlinkSpy)
          .on('add', addSpy);
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
        watcher = chokidar.watch([testPath, otherPath], options)
          .on('unlink', unlinkSpy)
          .on('add', addSpy);
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
        watcher = chokidar.watch([testPath, otherPath], options)
          .on('unlink', unlinkSpy)
          .on('add', addSpy);
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
        watcher = chokidar.watch([testPath, otherPath, other2Path], options)
          .on('unlink', unlinkSpy)
          .on('add', addSpy);
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
  describe('renamed directory', function() {
    it('should emit `add` for a file in a renamed directory', async () => {
      options.ignoreInitial = true;
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      const renamedDir = getFixturePath('subdir-renamed');
      const expectedPath = sysPath.join(renamedDir, 'add.txt');
      await fs_mkdir(testDir, PERM_ARR);
      await write(testPath, Date.now());
      watcher = chokidar.watch(fixturesPath, options);
      const spy = await aspy(watcher, 'add');

      await delay(1000);
      await fs_rename(testDir, renamedDir);
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(expectedPath);
    });
  });
  describe('watch non-existent paths', function() {
    it('should watch non-existent file and detect add', async () => {
      const testPath = getFixturePath('add.txt');
      watcher = chokidar.watch(testPath, options);
      const spy = await aspy(watcher, 'add');

      await delay();
      await write(testPath, Date.now());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should watch non-existent dir and detect addDir/add', async () => {
      const testDir = getFixturePath('subdir');
      const testPath = getFixturePath('subdir/add.txt');
      watcher = chokidar.watch(testDir, options);
      const spy = await aspy(watcher, 'all');
      spy.should.not.have.been.called;

      await delay();
      await fs_mkdir(testDir, PERM_ARR);

      await delay();
      await write(testPath, 'hello');
      await waitFor([spy.withArgs('add')]);
      spy.should.have.been.calledWith('addDir', testDir);
      spy.should.have.been.calledWith('add', testPath);
    });
  });
  describe('watch glob patterns', function() {
    before(closeWatchers);
    it('should correctly watch and emit based on glob input', async () => {
      const watchPath = getGlobPath('*a*.txt');
      const addPath = getFixturePath('add.txt');
      const changePath = getFixturePath('change.txt');
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');
      spy.should.have.been.calledWith('add', changePath);

      await write(addPath, Date.now());
      await write(changePath, Date.now());

      await delay();
      await waitFor([[spy, 3], spy.withArgs('add', addPath)]);
      spy.should.have.been.calledWith('add', addPath);
      spy.should.have.been.calledWith('change', changePath);
      spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
      spy.should.not.have.been.calledWith('addDir');
    });
    it('should respect negated glob patterns', async () => {
      const watchPath = getGlobPath('*');
      const negatedWatchPath = '!' + getGlobPath('*a*.txt');
      const unlinkPath = getFixturePath('unlink.txt');
      watcher = chokidar.watch([watchPath, negatedWatchPath], options);
      const spy = await aspy(watcher, 'all');
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith('add', unlinkPath);

      await delay();
      await fs_unlink(unlinkPath);
      await waitFor([[spy, 2], spy.withArgs('unlink')]);
      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith('unlink', unlinkPath);
    });
    it('should traverse subdirs to match globstar patterns', async () => {
      const watchPath = getGlobPath('../../test-*/' + subdir + '/**/a*.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      fs.writeFileSync(getFixturePath('subdir/a.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/b.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/subsub/ab.txt'), 'b');

      await delay();
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');
      setTimeout(() => {
        write(getFixturePath('add.txt'), Date.now());
        write(getFixturePath('subdir/subsub/ab.txt'), Date.now());
        fs_unlink(getFixturePath('subdir/a.txt'));
        fs_unlink(getFixturePath('subdir/b.txt'));
      }, 50);
      await waitFor([[spy.withArgs('add'), 3], spy.withArgs('unlink'), spy.withArgs('change')]);
      spy.withArgs('add').should.have.been.calledThrice;
      spy.should.have.been.calledWith('unlink', getFixturePath('subdir/a.txt'));
      spy.should.have.been.calledWith('change', getFixturePath('subdir/subsub/ab.txt'));
      spy.withArgs('unlink').should.have.been.calledOnce;
      spy.withArgs('change').should.have.been.calledOnce;
    });
    it('should resolve relative paths with glob patterns', async () => {
      const watchPath = 'test-*/' + subdir + '/*a*.txt';
      // getFixturePath() returns absolute paths, so use sysPath.join() instead
      const addPath = sysPath.join('test-fixtures', subdir.toString(), 'add.txt');
      const changePath = sysPath.join('test-fixtures', subdir.toString(), 'change.txt');
      const unlinkPath = sysPath.join('test-fixtures', subdir.toString(), 'unlink.txt');
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');

      spy.should.have.been.calledWith('add', changePath);
      setTimeout(async () => {
        await write(addPath, Date.now());
        await write(changePath, Date.now());
      }, 50);
      await waitFor([[spy, 3], spy.withArgs('add', addPath)]);
      spy.should.have.been.calledWith('add', addPath);
      spy.should.have.been.calledWith('change', changePath);
      spy.should.not.have.been.calledWith('add', unlinkPath);
      spy.should.not.have.been.calledWith('addDir');
      if (!osXFsWatch) spy.should.have.been.calledThrice;
    });
    it('should correctly handle conflicting glob patterns', async () => {
      const changePath = getFixturePath('change.txt');
      const unlinkPath = getFixturePath('unlink.txt');
      const addPath = getFixturePath('add.txt');
      const watchPaths = [getGlobPath('change*'), getGlobPath('unlink*')];
      watcher = chokidar.watch(watchPaths, options);
      const spy = await aspy(watcher, 'all');
      spy.should.have.been.calledWith('add', changePath);
      spy.should.have.been.calledWith('add', unlinkPath);
      spy.should.have.been.calledTwice;

      await delay();
      await write(addPath, Date.now());
      await write(changePath, Date.now());
      await fs_unlink(unlinkPath);

      await waitFor([[spy, 4], spy.withArgs('unlink', unlinkPath)]);
      spy.should.have.been.calledWith('change', changePath);
      spy.should.have.been.calledWith('unlink', unlinkPath);
      spy.should.not.have.been.calledWith('add', addPath);
      spy.callCount.should.equal(4);
    });
    it('should correctly handle intersecting glob patterns', async () => {
      const changePath = getFixturePath('change.txt');
      const watchPaths = [getGlobPath('cha*'), getGlobPath('*nge.*')];
      watcher = chokidar.watch(watchPaths, options);
      const spy = await aspy(watcher, 'all');
      spy.should.have.been.calledWith('add', changePath);
      spy.should.have.been.calledOnce;

      await delay();
      await write(changePath, Date.now());
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith('change', changePath);
      spy.should.have.been.calledTwice;
    });
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = getFixturePath('nota[glob].txt');
      await write(filePath, 'b');
      await delay();
      const spy = await aspy(stdWatcher(), 'all');
      spy.should.have.been.calledWith('add', filePath);

      await delay();
      await write(filePath, Date.now());
      await waitFor([spy.withArgs('change', filePath)]);
      spy.should.have.been.calledWith('change', filePath);
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
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');

      spy.should.have.been.calledWith('add', filePath);
      spy.should.not.have.been.calledWith('addDir', matchingDir);
      spy.should.not.have.been.calledWith('add', matchingFile);
      spy.should.not.have.been.calledWith('add', matchingFile2);
      await delay();
      await write(filePath, Date.now());

      await waitFor([spy.withArgs('change', filePath)]);
      spy.should.have.been.calledWith('change', filePath);
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
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');

      spy.should.have.been.calledWith('add', filePath);
      spy.should.not.have.been.calledWith('addDir', matchingDir);
      spy.should.not.have.been.calledWith('add', matchingFile);
      spy.should.not.have.been.calledWith('add', matchingFile2);
      await delay();
      await write(filePath, Date.now());

      await waitFor([spy.withArgs('change', filePath)]);
      spy.should.have.been.calledWith('change', filePath);
    });
    it('should not prematurely filter dirs against complex globstar patterns', async () => {
      const deepFile = getFixturePath('subdir/subsub/subsubsub/a.txt');
      const watchPath = getGlobPath('../../test-*/' + subdir + '/**/subsubsub/*.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), PERM_ARR);
      fs.writeFileSync(deepFile, 'b');
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');

      await delay();
      await write(deepFile, Date.now());
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith('add', deepFile);
      spy.should.have.been.calledWith('change', deepFile);
    });
    it('should emit matching dir events', async () => {
      // test with and without globstar matches
      const watchPaths = [getGlobPath('*'), getGlobPath('subdir/subsub/**/*')];
      const deepDir = getFixturePath('subdir/subsub/subsubsub');
      const deepFile = sysPath.join(deepDir, 'a.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      watcher = chokidar.watch(watchPaths, options);
      const spy = await aspy(watcher, 'all');

      spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
      spy.withArgs('addDir').should.have.been.calledOnce;
      fs.mkdirSync(deepDir, PERM_ARR);
      fs.writeFileSync(deepFile, Date.now());

      await waitFor([[spy.withArgs('addDir'), 2], spy.withArgs('add', deepFile)]);
      if (win32Polling) return true;

      spy.should.have.been.calledWith('addDir', deepDir);
      fs.unlinkSync(deepFile);
      fs.rmdirSync(deepDir);

      await waitFor([spy.withArgs('unlinkDir')]);
      spy.should.have.been.calledWith('unlinkDir', deepDir);
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
      fs.writeFileSync(deepFileA, Date.now());
      fs.writeFileSync(deepFileB, Date.now());
      watcher = chokidar.watch(watchPath, options);
      const spy = await aspy(watcher, 'all');

      spy.should.have.been.calledWith('add', deepFileA);
      spy.should.have.been.calledWith('add', deepFileB);
      fs.appendFileSync(deepFileA, Date.now());
      fs.appendFileSync(deepFileB, Date.now());

      await waitFor([[spy, 4]]);
      spy.should.have.been.calledWith('change', deepFileA);
      spy.should.have.been.calledWith('change', deepFileB);
    });
  });
  describe('watch symlinks', function() {
    if (os === 'win32') return true;
    before(closeWatchers);

    let linkedDir;
    beforeEach(async () => {
      linkedDir = sysPath.resolve(fixturesPath, '..', subdir + '-link');
      await fs_symlink(fixturesPath, linkedDir);
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
      watcher = chokidar.watch(linkedDir, options)
        .on('addDir', dirSpy)
        .on('add', addSpy);
      await waitForWatcher(watcher);

      dirSpy.should.have.been.calledWith(linkedDir);
      addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'change.txt'));
      addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'unlink.txt'));
    });
    it('should watch symlinked files', async () => {
      const changePath = getFixturePath('change.txt');
      const linkPath = getFixturePath('link.txt');
      fs.symlinkSync(changePath, linkPath);
      watcher = chokidar.watch(linkPath, options);
      const spy = await aspy(watcher, 'all');

      await write(changePath, Date.now());
      await waitFor([spy.withArgs('change')]);
      spy.should.have.been.calledWith('add', linkPath);
      spy.should.have.been.calledWith('change', linkPath);
    });
    it('should follow symlinked files within a normal dir', async () => {
      const changePath = getFixturePath('change.txt');
      const linkPath = getFixturePath('subdir/link.txt');
      fs.symlinkSync(changePath, linkPath);
      watcher = chokidar.watch(getFixturePath('subdir'), options);
      const spy = await aspy(watcher, 'all');

      await write(changePath, Date.now());
      await waitFor([spy.withArgs('change', linkPath)]);
      spy.should.have.been.calledWith('add', linkPath);
      spy.should.have.been.calledWith('change', linkPath);
    });
    it('should watch paths with a symlinked parent', async () => {
      const testDir = sysPath.join(linkedDir, 'subdir');
      const testFile = sysPath.join(testDir, 'add.txt');
      watcher = chokidar.watch(testDir, options);
      const spy = await aspy(watcher, 'all');

      spy.should.have.been.calledWith('addDir', testDir);
      spy.should.have.been.calledWith('add', testFile);
      await write(getFixturePath('subdir/add.txt'), Date.now());
      await waitFor([spy.withArgs('change')]);
      spy.should.have.been.calledWith('change', testFile);
    });
    it('should not recurse indefinitely on circular symlinks', async () => {
      await fs_symlink(fixturesPath, getFixturePath('subdir/circular'));
      watcher = stdWatcher();
      await waitForWatcher(watcher);
      // return true;
    });
    it('should recognize changes following symlinked dirs', async () => {
      const linkedFilePath = sysPath.join(linkedDir, 'change.txt');
      watcher = chokidar.watch(linkedDir, options);
      const spy = await aspy(watcher, 'change');
      const wa = spy.withArgs(linkedFilePath);
      await write(getFixturePath('change.txt'), Date.now());
      await waitFor([wa]);
      spy.should.have.been.calledWith(linkedFilePath);
    });
    it('should follow newly created symlinks', async () => {
      options.ignoreInitial = true;
      stdWatcher();
      const spy = await aspy(watcher, 'all');
      await delay();
      await fs_symlink(getFixturePath('subdir'), getFixturePath('link'));
      await waitFor([
        spy.withArgs('add', getFixturePath('link/add.txt')),
        spy.withArgs('addDir', getFixturePath('link'))
      ]);
      spy.should.have.been.calledWith('addDir', getFixturePath('link'));
      spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
    });
    it('should watch symlinks as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      watcher = chokidar.watch(linkedDir, options);
      const spy = await aspy(watcher, 'all');
      spy.should.not.have.been.calledWith('addDir');
      spy.should.have.been.calledWith('add', linkedDir);
      spy.should.have.been.calledOnce;
    });
    it('should watch symlinks within a watched dir as files when followSymlinks:false', async () => {
      options.followSymlinks = false;
      const linkPath = getFixturePath('link');
      fs.symlinkSync(getFixturePath('subdir'), linkPath);
      const spy = await aspy(stdWatcher(), 'all');

      // await delay();
      setTimeout(() => {
        fs.writeFileSync(getFixturePath('subdir/add.txt'), Date.now());
        fs.unlinkSync(linkPath);
        fs.symlinkSync(getFixturePath('subdir/add.txt'), linkPath);
      }, options.usePolling ? 1200 : 300);

      await waitFor([spy.withArgs('change', linkPath)]);
      spy.should.not.have.been.calledWith('addDir', linkPath);
      spy.should.not.have.been.calledWith('add', getFixturePath('link/add.txt'));
      spy.should.have.been.calledWith('add', linkPath);
      spy.should.have.been.calledWith('change', linkPath);
    });
    it('should not reuse watcher when following a symlink to elsewhere', async () => {
      const linkedPath = getFixturePath('outside');
      const linkedFilePath = sysPath.join(linkedPath, 'text.txt');
      const linkPath = getFixturePath('subdir/subsub');
      fs.mkdirSync(linkedPath, PERM_ARR);
      fs.writeFileSync(linkedFilePath, 'b');
      fs.symlinkSync(linkedPath, linkPath);
      watcher2 = chokidar.watch(getFixturePath('subdir'), options);
      await waitForWatcher(watcher2);

      await delay(options.usePolling ? 900 : undefined);
      const watchedPath = getFixturePath('subdir/subsub/text.txt');
      watcher = chokidar.watch(watchedPath, options);
      const spy = await aspy(watcher, 'all');

      await delay();
      await write(linkedFilePath, Date.now());
      await waitFor([spy.withArgs('change')]);
      spy.should.have.been.calledWith('change', watchedPath);
    });
    it('should properly match glob patterns that include a symlinked dir', async () => {
      const dirSpy = sinon.spy(function dirSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      // test with relative path to ensure proper resolution
      const watchDir = upath.relative(process.cwd(), linkedDir);
      watcher = chokidar.watch(upath.join(watchDir, '**/*'), options)
        .on('addDir', dirSpy)
        .on('add', addSpy);
      await waitForWatcher(watcher);
      // only the children are matched by the glob pattern, not the link itself
      addSpy.should.have.been.calledThrice; // also unlink.txt & subdir/add.txt
      addSpy.should.have.been.calledWith(sysPath.join(watchDir, 'change.txt'));
      dirSpy.should.have.been.calledWith(sysPath.join(watchDir, 'subdir'));
      await write(sysPath.join(watchDir, 'add.txt'), '');
      await waitFor([[addSpy, 4]]);
      addSpy.should.have.been.calledWith(sysPath.join(watchDir, 'add.txt'));
    });
  });
  describe('watch arrays of paths/globs', function() {
    before(closeWatchers);
    it('should watch all paths in an array', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir);
      watcher = chokidar.watch([testDir, testPath], options);
      const spy = await aspy(watcher, 'all');
      spy.should.have.been.calledWith('add', testPath);
      spy.should.have.been.calledWith('addDir', testDir);
      spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
      await write(testPath, Date.now());
      await waitFor([spy.withArgs('change')]);
      spy.should.have.been.calledWith('change', testPath);
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      await fs_mkdir(testDir);
      watcher = chokidar.watch([[testDir], [testPath]], options);
      const spy = await aspy(watcher, 'all');
      spy.should.have.been.calledWith('add', testPath);
      spy.should.have.been.calledWith('addDir', testDir);
      spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
      await write(testPath, Date.now());
      await waitFor([spy.withArgs('change')]);
      spy.should.have.been.calledWith('change', testPath);
    });
    it('should throw if provided any non-string paths', () => {
      expect(chokidar.watch.bind(null, [[fixturesPath], /notastring/]))
        .to.throw(TypeError, /non-string/i);
    });
  });
  describe('watch options', function() {
    before(closeWatchers);
    describe('ignoreInitial', function() {
      describe('false', function() {
        beforeEach(function() { options.ignoreInitial = false; });
        it('should emit `add` events for preexisting files', async () => {
          watcher = chokidar.watch(fixturesPath, options);
          const spy = await aspy(watcher, 'add');
          spy.should.have.been.calledTwice;
        });
        it('should emit `addDir` event for watched dir', async () => {
          watcher = chokidar.watch(fixturesPath, options);
          const spy = await aspy(watcher, 'addDir');
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(fixturesPath);
        });
        it('should emit `addDir` events for preexisting dirs', async () => {
          await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
          await fs_mkdir(getFixturePath('subdir/subsub'), PERM_ARR);
          watcher = chokidar.watch(fixturesPath, options);
          const spy = await aspy(watcher, 'addDir');
          spy.should.have.been.calledWith(fixturesPath);
          spy.should.have.been.calledWith(getFixturePath('subdir'));
          spy.should.have.been.calledWith(getFixturePath('subdir/subsub'));
          spy.should.have.been.calledThrice;
        });
      });
      describe('true', function() {
        beforeEach(function() { options.ignoreInitial = true; });
        it('should ignore inital add events', async () => {
          stdWatcher();
          const spy = await aspy(watcher, 'add');
          await delay();
          spy.should.not.have.been.called;
        });
        it('should ignore add events on a subsequent .add()', async () => {
          watcher = chokidar.watch(getFixturePath('subdir'), options);
          const spy = await aspy(watcher, 'add');
          watcher.add(fixturesPath);
          await delay(1000);
          spy.should.not.have.been.called;
        });
        it('should notice when a file appears in an empty directory', async () => {
          const testDir = getFixturePath('subdir');
          const testPath = getFixturePath('subdir/add.txt');
          const spy = await aspy(stdWatcher(), 'add');
          spy.should.not.have.been.called;
          await fs_mkdir(testDir, PERM_ARR);
          await write(testPath, Date.now());
          await waitFor([spy]);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
        });
        it('should emit a change on a preexisting file as a change', async () => {
          const testPath = getFixturePath('change.txt');
          const spy = await aspy(stdWatcher(), 'all');
          spy.should.not.have.been.called;
          await write(testPath, Date.now());
          await waitFor([spy.withArgs('change', testPath)]);
          spy.should.have.been.calledWith('change', testPath);
          spy.should.not.have.been.calledWith('add');
        });
        it('should not emit for preexisting dirs when depth is 0', async () => {
          options.depth = 0;
          const testPath = getFixturePath('add.txt');
          await fs_mkdir(getFixturePath('subdir'), PERM_ARR);

          await delay(200);
          const spy = await aspy(stdWatcher(), 'all');
          await write(testPath, Date.now());
          await waitFor([spy]);

          await delay(200);
          spy.should.have.been.calledWith('add', testPath);
          spy.should.not.have.been.calledWith('addDir');
        });
      });
    });
    describe('ignored', function() {
      it('should check ignore after stating', async () => {
        options.ignored = function(path, stats) {
          if (upath.normalizeSafe(path) === upath.normalizeSafe(testDir) || !stats) return false;
          return stats.isDirectory();
        };
        const testDir = getFixturePath('subdir');
        fs.mkdirSync(testDir, PERM_ARR);
        fs.writeFileSync(sysPath.join(testDir, 'add.txt'), '');
        fs.mkdirSync(sysPath.join(testDir, 'subsub'), PERM_ARR);
        fs.writeFileSync(sysPath.join(testDir, 'subsub', 'ab.txt'), '');
        watcher = chokidar.watch(testDir, options);
        const spy = await aspy(watcher, 'add');
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith(sysPath.join(testDir, 'add.txt'));
      });
      it('should not choke on an ignored watch path', async () => {
        options.ignored = function() { return true; };
        await waitForWatcher(stdWatcher());
      });
      it('should ignore the contents of ignored dirs', async () => {
        const testDir = getFixturePath('subdir');
        const testFile = sysPath.join(testDir, 'add.txt');
        options.ignored = testDir;
        fs.mkdirSync(testDir, PERM_ARR);
        fs.writeFileSync(testFile, 'b');
        watcher = chokidar.watch(fixturesPath, options);
        const spy = await aspy(watcher, 'all');

        await delay();
        await write(testFile, Date.now());

        await delay(300);
        spy.should.not.have.been.calledWith('addDir', testDir);
        spy.should.not.have.been.calledWith('add', testFile);
        spy.should.not.have.been.calledWith('change', testFile);
      });
      it('should allow regex/fn ignores', async () => {
        options.cwd = fixturesPath;
        options.ignored = /add/;

        fs.writeFileSync(getFixturePath('add.txt'), 'b');
        watcher = chokidar.watch(fixturesPath, options);
        const spy = await aspy(watcher, 'all');

        await delay();
        await write(getFixturePath('add.txt'), Date.now());
        await write(getFixturePath('change.txt'), Date.now());

        await waitFor([spy.withArgs('change', 'change.txt')]);
        spy.should.not.have.been.calledWith('add', 'add.txt');
        spy.should.not.have.been.calledWith('change', 'add.txt');
        spy.should.have.been.calledWith('add', 'change.txt');
        spy.should.have.been.calledWith('change', 'change.txt');
      });
    });
    describe('depth', function() {
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
        stdWatcher();
        const spy = await aspy(watcher, 'all');
        await write(getFixturePath('subdir/add.txt'), Date.now());
        await waitFor([[spy, 4]]);
        spy.should.have.been.calledWith('addDir', fixturesPath);
        spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
        spy.should.have.been.calledWith('add', getFixturePath('change.txt'));
        spy.should.have.been.calledWith('add', getFixturePath('unlink.txt'));
        spy.should.not.have.been.calledWith('change');
        if (!osXFsWatch) spy.callCount.should.equal(4);
      });
      it('should recurse to specified depth', async () => {
        options.depth = 1;
        const addPath = getFixturePath('subdir/add.txt');
        const changePath = getFixturePath('change.txt');
        const ignoredPath = getFixturePath('subdir/subsub/ab.txt');
        stdWatcher();
        const spy = await aspy(watcher, 'all');
        await delay();
        await write(getFixturePath('change.txt'), Date.now());
        await write(addPath, Date.now());
        await write(ignoredPath, Date.now());
        await waitFor([spy.withArgs('change', addPath), spy.withArgs('change', changePath)]);
        spy.should.have.been.calledWith('addDir', getFixturePath('subdir/subsub'));
        spy.should.have.been.calledWith('change', changePath);
        spy.should.have.been.calledWith('change', addPath);
        spy.should.not.have.been.calledWith('add', ignoredPath);
        spy.should.not.have.been.calledWith('change', ignoredPath);
        if (!osXFsWatch) spy.callCount.should.equal(8);
      });
      it('should respect depth setting when following symlinks', async () => {
        if (os === 'win32') return true; // skip on windows
        options.depth = 1;
        await fs_symlink(getFixturePath('subdir'), getFixturePath('link'));
        await delay();
        stdWatcher();
        const spy = await aspy(watcher, 'all');
        spy.should.have.been.calledWith('addDir', getFixturePath('link'));
        spy.should.have.been.calledWith('addDir', getFixturePath('link/subsub'));
        spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
        spy.should.not.have.been.calledWith('add', getFixturePath('link/subsub/ab.txt'));
      });
      it('should respect depth setting when following a new symlink', async () => {
        if (os === 'win32') return true; // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        const linkPath = getFixturePath('link');
        const dirPath = getFixturePath('link/subsub');
        stdWatcher();
        const spy = await aspy(watcher, 'all');
        await fs_symlink(getFixturePath('subdir'), linkPath);
        await waitFor([[spy, 3], spy.withArgs('addDir', dirPath)]);
        spy.should.have.been.calledWith('addDir', linkPath);
        spy.should.have.been.calledWith('addDir', dirPath);
        spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
        spy.should.have.been.calledThrice;
      });
      it('should correctly handle dir events when depth is 0', async () => {
        options.depth = 0;
        const subdir2 = getFixturePath('subdir2');
        const spy = await aspy(stdWatcher(), 'all');
        const addSpy = spy.withArgs('addDir');
        const unlinkSpy = spy.withArgs('unlinkDir');
        spy.should.have.been.calledWith('addDir', fixturesPath);
        spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
        await fs_mkdir(subdir2, PERM_ARR);
        await waitFor([[addSpy, 3]]);
        addSpy.should.have.been.calledThrice;

        await fs_rmdir(subdir2);
        await waitFor([unlinkSpy]);
        await delay();
        unlinkSpy.should.have.been.calledWith('unlinkDir', subdir2);
        unlinkSpy.should.have.been.calledOnce;
      });
    });
    describe('atomic', function() {
      beforeEach(function() {
        options.atomic = true;
        options.ignoreInitial = true;
      });
      it('should ignore vim/emacs/Sublime swapfiles', async () => {
        const spy = await aspy(stdWatcher(), 'all');
        await write(getFixturePath('.change.txt.swp'), 'a'); // vim
        await write(getFixturePath('add.txt\~'), 'a'); // vim/emacs
        await write(getFixturePath('.subl5f4.tmp'), 'a'); // sublime
        await delay(300);
        await write(getFixturePath('.change.txt.swp'), 'c');
        await write(getFixturePath('add.txt\~'), 'c');
        await write(getFixturePath('.subl5f4.tmp'), 'c');
        await delay(300);
        await fs_unlink(getFixturePath('.change.txt.swp'));
        await fs_unlink(getFixturePath('add.txt\~'));
        await fs_unlink(getFixturePath('.subl5f4.tmp'));
        await delay(300);
        spy.should.not.have.been.called;
      });
      it('should ignore stale tilde files', async () => {
        options.ignoreInitial = false;
        await write(getFixturePath('old.txt~'), 'a');
        await delay();
        const spy = await aspy(stdWatcher(), 'all');
        spy.should.not.have.been.calledWith(getFixturePath('old.txt'));
        spy.should.not.have.been.calledWith(getFixturePath('old.txt~'));
      });
    });
    describe('cwd', function() {
      it('should emit relative paths based on cwd', async () => {
        options.cwd = fixturesPath;
        watcher = chokidar.watch('**', options);
        const spy = await aspy(watcher, 'all');
        await write(getFixturePath('change.txt'), Date.now());
        await fs_unlink(getFixturePath('unlink.txt'));
        await waitFor([spy.withArgs('unlink')]);
        spy.should.have.been.calledWith('add', 'change.txt');
        spy.should.have.been.calledWith('add', 'unlink.txt');
        spy.should.have.been.calledWith('change', 'change.txt');
        spy.should.have.been.calledWith('unlink', 'unlink.txt');
      });
      it('should emit `addDir` with alwaysStat for renamed directory', async () => {
        options.cwd = fixturesPath;
        options.alwaysStat = true;
        options.ignoreInitial = true;
        const spy = sinon.spy();
        const testDir = getFixturePath('subdir');
        const renamedDir = getFixturePath('subdir-renamed');

        await fs_mkdir(testDir, PERM_ARR);
        watcher = chokidar.watch('.', options);

        setTimeout(() => {
          watcher.on('addDir', spy);
          fs_rename(testDir, renamedDir);
        }, 1000);

        await waitFor([spy]);
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith('subdir-renamed');
        expect(spy.args[0][1]).to.be.ok; // stats
      });
      it('should allow separate watchers to have different cwds', async () => {
        options.cwd = fixturesPath;
        const options2 = {};
        Object.keys(options).forEach((key) => {
          options2[key] = options[key];
        });
        options2.cwd = getFixturePath('subdir');
        watcher = chokidar.watch(getGlobPath('**'), options);
        const spy1 = await aspy(watcher, 'all');

        await delay();
        watcher2 = chokidar.watch(fixturesPath, options2);
        const spy2 = await aspy(watcher2, 'all');

        await write(getFixturePath('change.txt'), Date.now());
        await fs_unlink(getFixturePath('unlink.txt'));
        await waitFor([spy1.withArgs('unlink'), spy2.withArgs('unlink')]);
        spy1.should.have.been.calledWith('change', 'change.txt');
        spy1.should.have.been.calledWith('unlink', 'unlink.txt');
        spy2.should.have.been.calledWith('add', sysPath.join('..', 'change.txt'));
        spy2.should.have.been.calledWith('add', sysPath.join('..', 'unlink.txt'));
        spy2.should.have.been.calledWith('change', sysPath.join('..', 'change.txt'));
        spy2.should.have.been.calledWith('unlink', sysPath.join('..', 'unlink.txt'));
      });
      it('should ignore files even with cwd', async () => {
        options.cwd = fixturesPath;
        options.ignored = 'ignored-option.txt';
        const files = [
          '*.txt',
          '!ignored.txt'
        ];
        fs.writeFileSync(getFixturePath('change.txt'), 'hello');
        fs.writeFileSync(getFixturePath('ignored.txt'), 'ignored');
        fs.writeFileSync(getFixturePath('ignored-option.txt'), 'ignored option');
        watcher = chokidar.watch(files, options);

        const spy = await aspy(watcher, 'all');
        fs.writeFileSync(getFixturePath('ignored.txt'), Date.now());
        fs.writeFileSync(getFixturePath('ignored-option.txt'), Date.now());
        await fs_unlink(getFixturePath('ignored.txt'));
        await fs_unlink(getFixturePath('ignored-option.txt'));
        await delay();
        await write(getFixturePath('change.txt'), 'change');
        await waitFor([spy.withArgs('change', 'change.txt')]);
        spy.should.have.been.calledWith('add', 'change.txt');
        spy.should.not.have.been.calledWith('add', 'ignored.txt');
        spy.should.not.have.been.calledWith('add', 'ignored-option.txt');
        spy.should.not.have.been.calledWith('change', 'ignored.txt');
        spy.should.not.have.been.calledWith('change', 'ignored-option.txt');
        spy.should.not.have.been.calledWith('unlink', 'ignored.txt');
        spy.should.not.have.been.calledWith('unlink', 'ignored-option.txt');
        spy.should.have.been.calledWith('change', 'change.txt');
      });
    });
    describe('ignorePermissionErrors', function() {
      let filePath;
      beforeEach(async () => {
        filePath = getFixturePath('add.txt');
        await write(filePath, 'b', {mode: 128});
        await delay();
      });
      describe('false', function() {
        beforeEach(() => {
          options.ignorePermissionErrors = false;
          // stdWatcher();
        });
        it('should not watch files without read permissions', async () => {

          if (os === 'win32') return true;
          const spy = await aspy(stdWatcher(), 'all');
          spy.should.not.have.been.calledWith('add', filePath);
          await write(filePath, Date.now());

          await delay(200);
          spy.should.not.have.been.calledWith('change', filePath);
        });
      });
      describe('true', function() {
        beforeEach(function() { options.ignorePermissionErrors = true; });
        it('should watch unreadable files if possible', async () => {
          const spy = await aspy(stdWatcher(), 'all');
          spy.should.have.been.calledWith('add', filePath);
          if (!options.useFsEvents) return true;
          await write(filePath, Date.now());
          await waitFor([spy.withArgs('change')]);
          spy.should.have.been.calledWith('change', filePath);
        });
        it('should not choke on non-existent files', async () => {
          watcher = chokidar.watch(getFixturePath('nope.txt'), options);
          await waitForWatcher(watcher);
        });
      });
    });
    describe('awaitWriteFinish', function() {
      beforeEach(function() {
        options.awaitWriteFinish = {stabilityThreshold: 500};
        options.ignoreInitial = true;
      });
      it('should use default options if none given', function() {
        options.awaitWriteFinish = true;
        watcher = stdWatcher();
        expect(watcher.options.awaitWriteFinish.pollInterval).to.equal(100);
        expect(watcher.options.awaitWriteFinish.stabilityThreshold).to.equal(2000);
      });
      it('should not emit add event before a file is fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(stdWatcher(), 'all');
        await write(testPath, 'hello');
        await delay(200);
        spy.should.not.have.been.calledWith('add');
      });
      it('should wait for the file to be fully written before emitting the add event', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(stdWatcher(), 'all');
        await write(testPath, 'hello');

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith('add', testPath);
      });
      it('should emit with the final stats', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(stdWatcher(), 'all');
        await write(testPath, 'hello ');

        await delay(300);
        fs.appendFileSync(testPath, 'world!');

        await waitFor([spy]);
        spy.should.have.been.calledWith('add', testPath);
        expect(spy.args[0][2].size).to.equal(12);
      });
      it('should not emit change event while a file has not been fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(stdWatcher(), 'all');
        await write(testPath, 'hello');
        await delay(100);
        await write(testPath, 'edit');
        await delay(200);
        spy.should.not.have.been.calledWith('change', testPath);
      });
      it('should not emit change event before an existing file is fully updated', async () => {
        const testPath = getFixturePath('change.txt');
        const spy = await aspy(stdWatcher(), 'all');
        await write(testPath, 'hello');
        await delay(300);
        spy.should.not.have.been.calledWith('change', testPath);
      });
      it('should wait for an existing file to be fully updated before emitting the change event', async () => {
        const testPath = getFixturePath('change.txt');
        const spy = await aspy(stdWatcher(), 'all');
        fs.writeFile(testPath, 'hello', () => {});

        await delay(300);
        spy.should.not.have.been.called;
        await waitFor([spy]);
        spy.should.have.been.calledWith('change', testPath);
      });
      it('should emit change event after the file is fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(stdWatcher(), 'all');
        await delay();
        await write(testPath, 'hello');

        await waitFor([spy]);
        spy.should.have.been.calledWith('add', testPath);
        await write(testPath, 'edit');
        await waitFor([spy.withArgs('change')]);
        spy.should.have.been.calledWith('change', testPath);
      });
      it('should not raise any event for a file that was deleted before fully written', async () => {
        const testPath = getFixturePath('add.txt');
        const spy = await aspy(stdWatcher(), 'all');
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
        const spy = await aspy(stdWatcher(), 'all');

        await delay(400);
        await write(testPath, 'hello');

        await waitFor([spy.withArgs('add')]);
        spy.should.have.been.calledWith('add', filename);
      });
      it('should still emit initial add events', async () => {
        options.ignoreInitial = false;
        const spy = await aspy(stdWatcher(), 'all');
        spy.should.have.been.calledWith('add');
        spy.should.have.been.calledWith('addDir');
      });
      it('should emit an unlink event when a file is updated and deleted just after that', async () => {
        const testPath = getFixturePath('subdir/add.txt');
        const filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        await fs_mkdir(options.cwd);
        await delay();
        await write(testPath, 'hello');
        await delay();
        const spy = await aspy(stdWatcher(), 'all');
        await write(testPath, 'edit');
        await delay();
        await fs_unlink(testPath);
        await waitFor([spy.withArgs('unlink')]);
        spy.should.have.been.calledWith('unlink', filename);
        spy.should.not.have.been.calledWith('change', filename);
      });
      // describe('race2 condition', function() {
      //   // Reproduces bug https://github.com/paulmillr/chokidar/issues/546, which was causing an
      //   // uncaught exception. The race condition is likelier to happen when stat() is slow.
      //   const _fs = require('fs');
      //   const _realStat = _fs.stat;

      //   beforeEach(function() {
      //     options.awaitWriteFinish = {pollInterval: 50, stabilityThreshold: 50};
      //     options.ignoreInitial = true;

      //     // Stub fs.stat() to take a while to return.
      //     sinon.stub(_fs, 'stat', function(path, cb) {
      //       _realStat(path, w(cb, 250));
      //     });
      //   });

      //   afterEach(() => {
      //     // Restore fs.stat() back to normal.
      //     sinon.restore(_fs.stat);
      //   });

      //   it('should handle unlink that happens while waiting for stat to return', async () => {
      //     const testPath = getFixturePath('add.txt');
      //     const spy = await aspy(stdWatcher(), 'all');
      //     await write(testPath, 'hello');
      //     await waitFor([spy]);
      //     spy.should.have.been.calledWith('add', testPath);
      //     _fs.stat.reset();
      //     await write(testPath, 'edit');

      //     await delay(40);
      //     // There will be a stat() call after we notice the change, plus pollInterval.
      //     // After waiting a bit less, wait specifically for that stat() call.
      //     _fs.stat.reset();
      //     await waitFor([_fs.stat]);
      //     // Once stat call is made, it will take some time to return. Meanwhile, unlink
      //     // the file and wait for that to be noticed.
      //     await fs_unlink(testPath);
      //     await waitFor([spy.withArgs('unlink')]);

      //     await delay(400);
      //     // Wait a while after unlink to ensure stat() had time to return. That's where
      //     // an uncaught exception used to happen.
      //     spy.should.have.been.calledWith('unlink', testPath);
      //     spy.should.not.have.been.calledWith('change');
      //   });
      // });
      describe('race condition', function() {
        function w(fn, to) {
          return setTimeout.bind(null, fn, to || slowerDelay || 50);
        }
        function simpleCb(err) { if (err) throw err; }

        // Reproduces bug https://github.com/paulmillr/chokidar/issues/546, which was causing an
        // uncaught exception. The race condition is likelier to happen when stat() is slow.
        var _fs = require('fs');
        var _realStat = _fs.stat;
        beforeEach(function() {
          options.awaitWriteFinish = {pollInterval: 50, stabilityThreshold: 50};
          options.ignoreInitial = true;

          // Stub fs.stat() to take a while to return.
          sinon.stub(_fs, 'stat').callsFake(function(path, cb) { _realStat(path, w(cb, 250)); });
        });

        afterEach(function() {
          // Restore fs.stat() back to normal.
          sinon.restore();
        });

        function _waitFor(spies, fn) {
          function isSpyReady(spy) {
            return Array.isArray(spy) ? spy[0].callCount >= spy[1] : spy.callCount;
          }
          function finish() {
            clearInterval(intrvl);
            clearTimeout(to);
            fn();
            fn = Function.prototype;
          }
          var intrvl = setInterval(function() {
            if (spies.every(isSpyReady)) finish();
          }, 5);
          var to = setTimeout(finish, 3500);
        }

        it('should handle unlink that happens while waiting for stat to return', function(done) {
          var spy = sinon.spy();
          var testPath = getFixturePath('add.txt');
          stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', simpleCb);
            _waitFor([spy], function() {
              spy.should.have.been.calledWith('add', testPath);
              _fs.stat.resetHistory();
              fs.writeFile(testPath, 'edit', simpleCb);
              w(function() {
                // There will be a stat() call after we notice the change, plus pollInterval.
                // After waiting a bit less, wait specifically for that stat() call.
                _fs.stat.resetHistory();
                _waitFor([_fs.stat], function() {
                  // Once stat call is made, it will take some time to return. Meanwhile, unlink
                  // the file and wait for that to be noticed.
                  fs.unlink(testPath, simpleCb);
                  _waitFor([spy.withArgs('unlink')], w(function() {
                    // Wait a while after unlink to ensure stat() had time to return. That's where
                    // an uncaught exception used to happen.
                    spy.should.have.been.calledWith('unlink', testPath);
                    spy.should.not.have.been.calledWith('change');
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
  describe('getWatched', function() {
    before(closeWatchers);
    it('should return the watched paths', async () => {
      const expected = {};
      expected[sysPath.dirname(fixturesPath)] = [subdir.toString()];
      expected[fixturesPath] = ['change.txt', 'unlink.txt'];
      await waitForWatcher(stdWatcher());
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
    it('should set keys relative to cwd & include added paths', async () => {
      options.cwd = fixturesPath;
      const expected = {
        '.': ['change.txt', 'subdir', 'unlink.txt'],
        '..': [subdir.toString()],
        'subdir': []
      };
      await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
      await waitForWatcher(stdWatcher());
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
  });
  describe('unwatch', function() {
    before(closeWatchers);
    beforeEach(async () => {
      options.ignoreInitial = true;
      await fs_mkdir(getFixturePath('subdir'), PERM_ARR);
      await delay();
    });
    it('should stop watching unwatched paths', async () => {
      const watchPaths = [getFixturePath('subdir'), getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options);
      const spy = await aspy(watcher, 'all');
      watcher.unwatch(getFixturePath('subdir'));

      await delay();
      await write(getFixturePath('subdir/add.txt'), Date.now());
      await write(getFixturePath('change.txt'), Date.now());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
      spy.should.not.have.been.calledWith('add');
      if (!osXFsWatch) spy.should.have.been.calledOnce;
    });
    it('should ignore unwatched paths that are a subset of watched paths', async () => {
      watcher = chokidar.watch(fixturesPath, options);
      const spy = await aspy(watcher, 'all');

      await delay();
      // test with both relative and absolute paths
      const subdirRel = upath.relative(process.cwd(), getFixturePath('subdir'));
      watcher.unwatch([subdirRel, getGlobPath('unl*')]);

      await delay();
      await fs_unlink(getFixturePath('unlink.txt'));
      await write(getFixturePath('subdir/add.txt'), Date.now());
      await write(getFixturePath('change.txt'), Date.now());
      await waitFor([spy.withArgs('change')]);

      await delay(300);
      spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
      spy.should.not.have.been.calledWith('add', getFixturePath('subdir/add.txt'));
      spy.should.not.have.been.calledWith('unlink');
      if (!osXFsWatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch relative paths', async () => {
      const fixturesDir = sysPath.relative(process.cwd(), fixturesPath);
      const subdir = sysPath.join(fixturesDir, 'subdir');
      const changeFile = sysPath.join(fixturesDir, 'change.txt');
      const watchPaths = [subdir, changeFile];
      watcher = chokidar.watch(watchPaths, options);
      const spy = await aspy(watcher, 'all');

      await delay();
      watcher.unwatch(subdir);
      await write(getFixturePath('subdir/add.txt'), Date.now());
      await write(getFixturePath('change.txt'), Date.now());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith('change', changeFile);
      spy.should.not.have.been.calledWith('add');
      if (!osXFsWatch) spy.should.have.been.calledOnce;
    });
    it('should watch paths that were unwatched and added again', async () => {
      const spy = sinon.spy();
      const watchPaths = [getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options);
      await waitForWatcher(watcher);

      await delay();
      watcher.unwatch(getFixturePath('change.txt'));

      await delay();
      watcher.on('all', spy).add(getFixturePath('change.txt'));

      await delay();
      await write(getFixturePath('change.txt'), Date.now());
      await waitFor([spy]);
      spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
      if (!osXFsWatch) spy.should.have.been.calledOnce;
    });
    it('should unwatch paths that are relative to options.cwd', async () => {
      options.cwd = fixturesPath;
      watcher = chokidar.watch('.', options);
      const spy = await aspy(watcher, 'all');
      watcher.unwatch(['subdir', getFixturePath('unlink.txt')]);

      await delay();
      await fs_unlink(getFixturePath('unlink.txt'));
      await write(getFixturePath('subdir/add.txt'), Date.now());
      await write(getFixturePath('change.txt'), Date.now());
      await waitFor([spy]);

      await delay(300);
      spy.should.have.been.calledWith('change', 'change.txt');
      spy.should.not.have.been.calledWith('add');
      spy.should.not.have.been.calledWith('unlink');
      if (!osXFsWatch) spy.should.have.been.calledOnce;
    });
  });
  describe('close', function() {
    it('should ignore further events on close', async () => {
      return new Promise(async (resolve) => {
        const spy = sinon.spy();
        watcher = chokidar.watch(fixturesPath, options);
        watcher.once('add', () => {
          watcher.once('add', async () => {
            watcher.on('add', spy).close();
            await delay(900);
            await write(getFixturePath('add.txt'), Date.now());
            spy.should.not.have.been.called;
            resolve();
          });
        });
        await waitForWatcher(watcher);
        await write(getFixturePath('add.txt'), 'hello');
        await fs_unlink(getFixturePath('add.txt'));
      });
    });
    it('should not prevent the process from exiting', async () => {
      const scriptFile = getFixturePath('script.js');
      const scriptContent = '\
      const chokidar = require("' + __dirname.replace(/\\/g, '\\\\') + '");\n\
      const watcher = chokidar.watch("' + scriptFile.replace(/\\/g, '\\\\') + '");\n\
      watcher.close();\n\
      process.stdout.write("closed");\n';
      await write(scriptFile, scriptContent);
      const obj = await exec('node ' + scriptFile);
      const stdout = obj.stdout;
      expect(stdout.toString()).to.equal('closed');
    });
  });
  describe('env variable option override', function() {
    describe('CHOKIDAR_USEPOLLING', function() {
      afterEach(function() {
        delete process.env.CHOKIDAR_USEPOLLING;
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to true', async () => {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = 'true';

        watcher = chokidar.watch(fixturesPath, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to 1', async () => {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = '1';

        watcher = chokidar.watch(fixturesPath, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to false', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        watcher = chokidar.watch(fixturesPath, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.false;
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to 0', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'false';

        watcher = chokidar.watch(fixturesPath, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.false;
      });

      it('should not attenuate options.usePolling when CHOKIDAR_USEPOLLING is set to an arbitrary value', async () => {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'foo';

        watcher = chokidar.watch(fixturesPath, options);
        await waitForWatcher(watcher);
        watcher.options.usePolling.should.be.true;
      });
    });
    describe('CHOKIDAR_INTERVAL', function() {
      afterEach(() => {
        delete process.env.CHOKIDAR_INTERVAL;
      });

      it('should make options.interval = CHOKIDAR_INTERVAL when it is set', async () => {
        options.interval = 100;
        process.env.CHOKIDAR_INTERVAL = '1500';

        watcher = chokidar.watch(fixturesPath, options);
        await waitForWatcher(watcher);
        watcher.options.interval.should.be.equal(1500);
      });
    });
  });
};

describe('chokidar', function() {
  this.timeout(6000);
  before(async () => {
    let created = 0;
    await rimraf(sysPath.join(__dirname, 'test-fixtures'));
    const _content = fs.readFileSync(__filename, 'utf-8');
    const _only = _content.match(/\sit\.only\(/g);
    const itCount = _only && _only.length || _content.match(/\sit\(/g).length;
    const testCount = itCount * 3;
    fs.mkdirSync(fixturesPath, PERM_ARR);
    while (subdir < testCount) {
      subdir++;
      fixturesPath = getFixturePath('');
      fs.mkdirSync(fixturesPath, PERM_ARR);
      fs.writeFileSync(sysPath.join(fixturesPath, 'change.txt'), 'b');
      fs.writeFileSync(sysPath.join(fixturesPath, 'unlink.txt'), 'b');
    }
    subdir = 0;
  });
  beforeEach(function() {
    subdir++;
    fixturesPath = getFixturePath('');
  });

  after(async () => {
    await rimraf(sysPath.join(__dirname, 'test-fixtures'));
  });

  afterEach(function() {
    function disposeWatcher(watcher) {
      if (!watcher || !watcher.close) return;
      os === 'darwin' ? usedWatchers.push(watcher) : watcher.close();
    }
    disposeWatcher(watcher);
    disposeWatcher(watcher2);
  });

  it('should expose public API methods', function() {
    chokidar.FSWatcher.should.be.a('function');
    chokidar.watch.should.be.a('function');
  });

  if (os === 'darwin') {
    describe('fsevents (native extension)', runTests.bind(this, {useFsEvents: true}));
  } else {
    describe('fs.watch (non-polling)', runTests.bind(this, {usePolling: false, useFsEvents: false}));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, {usePolling: true, interval: 10}));
});
