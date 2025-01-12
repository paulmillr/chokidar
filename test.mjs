import fs, { writeFileSync } from 'node:fs'; // fs.stat is mocked below, so can't import INDIVIDUAL methods
import {
  rm, symlink, rename, mkdir, readFile as read, writeFile as write, unlink as unl
} from 'node:fs/promises';
import {
  join as pjoin, relative as prelative, resolve as presolve,
  dirname as pdirname, basename as pbasename
} from 'node:path';
// import {describe, it, before, after, beforeEach, afterEach} from 'node:test';
import {describe, it, beforeEach, afterEach} from './test-micro-should.mjs';
import {fileURLToPath, pathToFileURL, URL} from 'node:url';
import {promisify} from 'node:util';
import { exec as cexec } from 'node:child_process';
import { tmpdir } from 'node:os';
import chai from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import upath from 'upath';

import chokidar from './esm/index.js';
import { EVENTS as EV, isWindows, isMacos, isIBMi } from './esm/handler.js';

const TEST_TIMEOUT = 8000; // ms

const {expect} = chai;
chai.use(sinonChai);
chai.should();

const exec = promisify(cexec);
// const rm = promisify(fs.rm);
// const read = promisify(fs.readFile);
// const write = promisify(fs.writeFile);
// const symlink = promisify(fs.symlink);
// const rename = promisify(fs.rename);
// const mkdir = promisify(fs.mkdir);
// const unl = promisify(fs.unlink);

const imetaurl = import.meta.url;
const __filename = fileURLToPath(new URL('', imetaurl));
const __dirname = fileURLToPath(new URL('.', imetaurl)); // Will contain trailing slash
const initialPath = process.cwd();
const FIXTURES_PATH = pjoin(tmpdir(), 'chokidar-' + Date.now())

const WATCHERS = [];
const PERM = 0o755; // rwe, r+e, r+e
let testId = 1;
let currentDir;
let slowerDelay;

// spyOnReady
// const aspy = (watcher, eventName, spy = null, noStat = false) => {
//   if (typeof eventName !== 'string') {
//     throw new TypeError('aspy: eventName must be a String');
//   }
//   if (spy == null) spy = sinon.spy();
//   return new Promise((resolve, reject) => {
//     const handler = noStat ?
//       (eventName === EV.ALL ?
//       (event, path) => spy(event, path) :
//       (path) => spy(path)) :
//       spy;
//     const timeout = setTimeout(() => {
//       reject(new Error('timeout'));
//     }, TEST_TIMEOUT);
//     watcher.on(EV.ERROR, (...args) => {
//       clearTimeout(timeout);
//       reject(...args);
//     });
//     watcher.on(EV.READY, () => {
//       clearTimeout(timeout);
//       resolve(spy);
//     });
//     watcher.on(eventName, handler);
//   });
// };

const waitForWatcher = (watcher) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('waitForWatcher timeout'));
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

// dir path
const dpath = (subPath = '') => {
  if (!testId) throw new Error('no testId');
  const id = testId.toString();
  return pjoin(id, id, subPath);
};
// glob path
const gpath = (subPath = '') => {
  if (!testId) throw new Error('no testId');
  const id = testId.toString();
  return upath.join(id, id, subPath);
};
currentDir = undefined;

const cwatch = (path = dpath(), opts) => {
  console.log('watch', path, opts);
  const wt = chokidar.watch(path, opts);
  WATCHERS.push(wt);
  return wt;
};

let TIMER_WAIT_FOR;
let TIMER_WAIT_FOR_TIMEOUT;

function makeSpy() {
  function spied(...args) {
    spied.args.push(args);
    spied.callCount++;
  }
  spied.args = [];
  spied.callCount = 0;
  spied.wasCalledWith = function(arg) {
    for (let scall of spied.args) {
      if (scall.includes(arg)) return true;
    }
    throw new Error('spy should have been called with arg');
  }
  spied.wasCalled = () => {
    if (spied.callCount === 0) throw new Error('spy has not been called');
  }
  return spied;
}

const waitFor = (spy, callCount = 1) => {
  if (typeof spy !== 'function') throw new Error('spy expected');
  if (!Number.isInteger(callCount) || callCount < 1) throw new Error('callCount expected');
  if (TIMER_WAIT_FOR) throw new Error('waitFor already called');
  return new Promise((resolve, reject) => {
    TIMER_WAIT_FOR_TIMEOUT = setTimeout(() => {
      clearInterval(TIMER_WAIT_FOR);
      TIMER_WAIT_FOR = TIMER_WAIT_FOR_TIMEOUT = undefined;
      reject(new Error('timeout waitFor, passed ms: ' + TEST_TIMEOUT));
    }, TEST_TIMEOUT);
    TIMER_WAIT_FOR = setInterval(function checkSpiesReady() {
      if (spy.callCount >= callCount) {
        clearInterval(TIMER_WAIT_FOR);
        clearTimeout(TIMER_WAIT_FOR_TIMEOUT);
        TIMER_WAIT_FOR = TIMER_WAIT_FOR_TIMEOUT = undefined;
        resolve();
      }
    }, 20);
  });
};

const waitForEvents = (watcher, count) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout waitForEvents, passed ms: ' + TEST_TIMEOUT));
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
  let macosFswatch = isMacos && !baseopts.usePolling;
  let win32Polling = isWindows && baseopts.usePolling;
  let options;
  slowerDelay = macosFswatch ? 100 : undefined;
  baseopts.persistent = true;

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach((key) => {
      options[key] = baseopts[key];
    });
  });

  describe('watch a directory', () => {
    let readySpy, rawSpy, watcher, watcher2;
    async function dwatch() {
      watcher = cwatch(dpath(), options).on(EV.READY, readySpy).on(EV.RAW, rawSpy);
      await waitForWatcher(watcher);
    }
    beforeEach(() => {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = makeSpy(function readySpy(){});
      rawSpy = makeSpy(function rawSpy(){});
    });
    afterEach(async () => {
      await waitFor(readySpy);
      await watcher.close();
      await delay(1500);

      expect(readySpy.callCount).to.be.above(0);
      readySpy = undefined;
      rawSpy = undefined;
      watcher = undefined;
    });
    it('should produce an instance of chokidar.FSWatcher', async () => {
      await dwatch();
      watcher.should.be.an.instanceof(chokidar.FSWatcher);
    });
    it('should expose public API methods', async () => {
      await dwatch();
      watcher.on.should.be.a('function');
      watcher.emit.should.be.a('function');
      watcher.add.should.be.a('function');
      watcher.close.should.be.a('function');
      watcher.getWatched.should.be.a('function');
    });
    it('should emit `add` event when file was added', async () => {
      await dwatch();
      const testPath = dpath('add.txt');
      const spy = makeSpy();
      watcher.on(EV.ADD, spy);
      await delay();
      await write(testPath, dateNow());
      await waitFor(spy);
      spy.wasCalled();
      spy.wasCalledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.wasCalled();
    });
    it('should emit nine `add` events when nine files were added in one directory', async () => {
      await dwatch();
      const paths = [];
      for (let i = 1; i <= 9; i++) {
        paths.push(dpath(`add${i}.txt`));
      }

      const spy = makeSpy();
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

      await waitFor(spy, 4);

      await delay(1000);
      await waitFor(spy, 9);
      paths.forEach(path => {
        spy.wasCalledWith(path);
        // spy.should.have.been.calledWith(path);
      });
    });
    it('should emit thirtythree `add` events when thirtythree files were added in nine directories', async () => {
      // await watcher.close();
      // await dwatch();

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
      await mkdir(dpath('b'), PERM);
      await mkdir(dpath('c'), PERM);
      await mkdir(dpath('d'), PERM);
      await mkdir(dpath('e'), PERM);
      await mkdir(dpath('f'), PERM);
      await mkdir(dpath('g'), PERM);
      await mkdir(dpath('h'), PERM);
      await mkdir(dpath('i'), PERM);

      await delay(1000);
      const added = new Set();
      let spy = makeSpy();

      watcher = cwatch(currentDir, options)
      .on(EV.RAW, (a, b, c) => {
        console.log('raw', a, b, c);
      })
      .on(EV.ALL, (a, b) => {
        console.log('all', a, b);
      })
      .on(EV.ADD, (path) => {
        console.log('add', path);
        added.add(path);
        spy(path);
      });

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

      let callCount = 0;
      for (const fileToWrite of filesToWrite) {
        console.log('write', fileToWrite);
        await write(fileToWrite, dateNow());
        callCount++;
        console.log('wrote', callCount);
        // setInterval(() => {console.log(added)}, 500);
        // await waitFor(spy, callCount)
        // await waitFor([[spy, ++currentCallCount]]);
        // console.log(added.has(fileToWrite));
        // await waitFor([spy, ++currentCallCount]);
      }
      await delay(5000);
      console.log(added);
      // console.log('ab 114');
      // for (let file of filesToWrite) {
      //   if (!added.has(file)) {
      //     console.log(added);
      //     throw new Error('no file ' + file);
      //   }
      // }

      /*
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
      readySpy.should.have.been.calledOnce;
      */
      // await watcher.close()
    });
    it('should emit `addDir` event when directory was added', async () => {
      await dwatch();
      const testDir = dpath('subdir');
      const spy = sinon.spy(function addDirSpy(){});
      watcher.on(EV.ADD_DIR, spy);
      spy.should.not.have.been.called;
      await mkdir(testDir, PERM);
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testDir);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should emit `change` event when file was changed', async () => {
      await dwatch();
      const testPath = dpath('change.txt');
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
      await dwatch();
      const testPath = dpath('unlink.txt');
      const spy = sinon.spy(function unlinkSpy(){});
      watcher.on(EV.UNLINK, spy);
      spy.should.not.have.been.called;
      await unl(testPath);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit `unlinkDir` event when a directory was removed', async () => {
      await dwatch();
      const testDir = dpath('subdir');
      const spy = sinon.spy(function unlinkDirSpy(){});

      await mkdir(testDir, PERM);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, spy);

      await rm(testDir, { recursive: true });
      await waitFor([spy]);
      spy.should.have.been.calledWith(testDir);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledOnce;
    });
    it('should emit two `unlinkDir` event when two nested directories were removed', async () => {
      await dwatch();
      const testDir = dpath('subdir');
      const testDir2 = dpath('subdir/subdir2');
      const testDir3 = dpath('subdir/subdir2/subdir3');
      const spy = sinon.spy(function unlinkDirSpy(){});

      await mkdir(testDir, PERM);
      await mkdir(testDir2, PERM);
      await mkdir(testDir3, PERM);
      await delay(300);

      watcher.on(EV.UNLINK_DIR, spy);

      await rm(testDir2, {recursive: true});
      await waitFor([[spy, 2]]);

      spy.should.have.been.calledWith(testDir2);
      spy.should.have.been.calledWith(testDir3);
      expect(spy.args[0][1]).to.not.be.ok; // no stats
      rawSpy.should.have.been.called;
      spy.should.have.been.calledTwice;
    });
    it('should emit `unlink` and `add` events when a file is renamed', async () => {
      await dwatch();
      const unlinkSpy = sinon.spy(function unlink(){});
      const addSpy = sinon.spy(function add(){});
      const testPath = dpath('change.txt');
      const newPath = dpath('moved.txt');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy);
      unlinkSpy.should.not.have.been.called;
      addSpy.should.not.have.been.called;

      await delay();
      await rename(testPath, newPath);
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
        console.warn('test skipped')
        return true;
      }
      await dwatch();
      const unlinkSpy = sinon.spy(function unlink(){});
      const addSpy = sinon.spy(function add(){});
      const changeSpy = sinon.spy(function change(){});
      const testPath = dpath('add.txt');
      watcher
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy)
        .on(EV.CHANGE, changeSpy);
      await write(testPath, 'hello');
      await waitFor([[addSpy.withArgs(testPath), 1]]);
      unlinkSpy.should.not.have.been.called;
      changeSpy.should.not.have.been.called;
      await unl(testPath);
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
      await dwatch();
      const unlinkSpy = sinon.spy(function unlink(){});
      const testPath = dpath('change.txt');
      const newPath1 = dpath('moved.txt');
      const newPath2 = dpath('moved-again.txt');
      watcher.on(EV.UNLINK, unlinkSpy);
      await rename(testPath, newPath1);

      await delay(300);
      await rename(newPath1, newPath2);
      await waitFor([unlinkSpy.withArgs(newPath1)]);
      unlinkSpy.withArgs(testPath).should.have.been.calledOnce;
      unlinkSpy.withArgs(newPath1).should.have.been.calledOnce;
      unlinkSpy.withArgs(newPath2).should.not.have.been.called;
    });
    it('should survive ENOENT for missing subdirectories', async () => {
      await dwatch();
      const testDir = dpath('notadir');
      watcher.add(testDir);
    });
    it('should notice when a file appears in a new directory', async () => {
      await dwatch();
      const testDir = dpath('subdir');
      const testPath = dpath('subdir/add.txt');
      const spy = sinon.spy(function addSpy(){});
      watcher.on(EV.ADD, spy);
      spy.should.not.have.been.called;
      await mkdir(testDir, PERM);
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(testPath);
      expect(spy.args[0][1]).to.be.ok; // stats
      rawSpy.should.have.been.called;
    });
    it('should watch removed and re-added directories', async () => {
      await dwatch();
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const parentPath = dpath('subdir2');
      const subPath = dpath('subdir2/subsub');
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD_DIR, addSpy);
      await mkdir(parentPath, PERM);

      await delay(win32Polling ? 900 : 300);
      await rm(parentPath, { recursive: true });
      await waitFor([unlinkSpy.withArgs(parentPath)]);
      unlinkSpy.should.have.been.calledWith(parentPath);
      await mkdir(parentPath, PERM);

      await delay(win32Polling ? 2200 : 1200);
      await mkdir(subPath, PERM);
      await waitFor([[addSpy, 3]]);
      addSpy.should.have.been.calledWith(parentPath);
      addSpy.should.have.been.calledWith(subPath);
    });
    it('should emit `unlinkDir` and `add` when dir is replaced by file', async () => {
      await dwatch();
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = dpath('dirFile');
      await mkdir(testPath, PERM);
      await delay(300);
      watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD, addSpy);

      await rm(testPath, { recursive: true });
      await waitFor([unlinkSpy]);

      await write(testPath, 'file content');
      await waitFor([addSpy]);

      unlinkSpy.should.have.been.calledWith(testPath);
      addSpy.should.have.been.calledWith(testPath);
    });
    it('should emit `unlink` and `addDir` when file is replaced by dir', async () => {
      await dwatch();
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = dpath('fileDir');
      await write(testPath, 'file content');
      watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD_DIR, addSpy);

      await delay(300);
      await unl(testPath);
      await delay(300);
      await mkdir(testPath, PERM);

      await waitFor([addSpy, unlinkSpy]);
      unlinkSpy.should.have.been.calledWith(testPath);
      addSpy.should.have.been.calledWith(testPath);
    });
  });
  describe('watch individual files', () => {
    it('should emit `ready` when three files were added', async () => {
      const readySpy = sinon.spy(function readySpy(){});
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
      await unl(testPath);
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });
    it('should detect unlink and re-add', async () => {
      options.ignoreInitial = true;
      const unlinkSpy = sinon.spy(function unlinkSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const testPath = dpath('unlink.txt');
      const watcher = cwatch([testPath], options)
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      await delay();
      await unl(testPath);
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
      await rename(safePath, testPath);
      await delay(300);
      await write(safePath, dateNow());
      await rename(safePath, testPath);
      await delay(300);
      await write(safePath, dateNow());
      await rename(safePath, testPath);
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
        await mkdir(otherDirPath, PERM);
        const watcher = cwatch([testPath, otherPath], options);
        // intentionally for this test don't write write(otherPath, 'other');
        const spy = await aspy(watcher, EV.UNLINK);

        await delay();
        await unl(testPath);
        await waitFor([spy]);
        spy.should.have.been.calledWith(testPath);
      });
      it('should detect unlink and re-add while watching a second file', async () => {
        options.ignoreInitial = true;
        const unlinkSpy = sinon.spy(function unlinkSpy(){});
        const addSpy = sinon.spy(function addSpy(){});
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        await write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unl(testPath);
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
        const testPath = dpath('unlink.txt');
        const otherDirPath = dpath('other-dir');
        const otherPath = dpath('other-dir/other.txt');
        await mkdir(otherDirPath, PERM);
        // intentionally for this test don't write write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unl(testPath);
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
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        // intentionally for this test don't write write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unl(testPath);
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
        const testPath = dpath('unlink.txt');
        const otherPath = dpath('other.txt');
        await write(otherPath, 'other');
        const watcher = cwatch([testPath, otherPath], options)
          .on(EV.UNLINK, unlinkSpy)
          .on(EV.ADD, addSpy);
        await waitForWatcher(watcher);

        await delay();
        await unl(otherPath);

        await delay();
        await unl(testPath);
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
        await unl(testPath);

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
      const expectedPath = pjoin(renamedDir, 'add.txt');
      await mkdir(testDir, PERM);
      await write(testPath, dateNow());
      const watcher = cwatch(currentDir, options);
      const spy = await aspy(watcher, EV.ADD);

      await delay(1000);
      await rename(testDir, renamedDir);
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
      await mkdir(testDir, PERM);
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
      options.disableGlobbing = true;
      const filePath = dpath('nota[glob]/a.txt');
      const watchPath = dpath('nota[glob]');
      const testDir = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/b.txt');
      const matchingFile2 = dpath('notal');
      await mkdir(testDir, PERM);
      await write(filePath, 'b');
      await mkdir(matchingDir, PERM);
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
      options.disableGlobbing = true;
      const filePath = dpath('nota[glob]');
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/a.txt');
      const matchingFile2 = dpath('notal');
      await write(filePath, 'b');
      await mkdir(matchingDir, PERM);
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
    let linkedDir;
    beforeEach(async () => {
      linkedDir = presolve(currentDir, '..', `${testId}-link`);
      await symlink(currentDir, linkedDir, isWindows ? 'dir' : null);
      await mkdir(dpath('subdir'), PERM);
      await write(dpath('subdir/add.txt'), 'b');
      return true;
    });
    afterEach(async () => {
      await unl(linkedDir);
      return true;
    });

    it('should watch symlinked dirs', async () => {
      const dirSpy = sinon.spy(function dirSpy(){});
      const addSpy = sinon.spy(function addSpy(){});
      const watcher = cwatch(linkedDir, options)
        .on(EV.ADD_DIR, dirSpy)
        .on(EV.ADD, addSpy);
      await waitForWatcher(watcher);

      dirSpy.should.have.been.calledWith(linkedDir);
      addSpy.should.have.been.calledWith(pjoin(linkedDir, 'change.txt'));
      addSpy.should.have.been.calledWith(pjoin(linkedDir, 'unlink.txt'));
    });
    it('should watch symlinked files', async () => {
      const changePath = dpath('change.txt');
      const linkPath = dpath('link.txt');
      await symlink(changePath, linkPath);
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
      await symlink(changePath, linkPath);
      const watcher = cwatch(dpath('subdir'), options);
      const spy = await aspy(watcher, EV.ALL);

      await write(changePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should watch paths with a symlinked parent', async () => {
      const testDir = pjoin(linkedDir, 'subdir');
      const testFile = pjoin(testDir, 'add.txt');
      const watcher = cwatch(testDir, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.have.been.calledWith(EV.ADD, testFile);
      await write(dpath('subdir/add.txt'), dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testFile);
    });
    it('should not recurse indefinitely on circular symlinks', async () => {
      await symlink(currentDir, dpath('subdir/circular'), isWindows ? 'dir' : null);
      return new Promise((resolve, reject) => {
        const watcher = cwatch(currentDir, options);
        watcher.on(EV.ERROR, resolve());
        watcher.on(EV.READY, reject('The watcher becomes ready, although he watches a circular symlink.'));
      })
    });
    it('should recognize changes following symlinked dirs', async () => {
      const linkedFilePath = pjoin(linkedDir, 'change.txt');
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
      await symlink(dpath('subdir'), dpath('link'), isWindows ? 'dir' : null);
      await waitFor([
        spy.withArgs(EV.ADD, dpath('link/add.txt')),
        spy.withArgs(EV.ADD_DIR, dpath('link'))
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
      await mkdir(targetDir);
      await symlink(targetDir, dpath('subdir/broken'), isWindows ? 'dir' : null);
      await rm(targetDir, { recursive: true });
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
      await symlink(dpath('subdir'), linkPath);
      const spy = await aspy(cwatch(currentDir, options), EV.ALL);
      await delay(300);
      setTimeout(() => {
        fs.writeFileSync(dpath('subdir/add.txt'), dateNow());
        fs.unlinkSync(linkPath);
        fs.symlinkSync(dpath('subdir/add.txt'), linkPath);
      }, options.usePolling ? 1200 : 300);

      await delay(300);
      await waitFor([spy.withArgs(EV.CHANGE, linkPath)]);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, linkPath);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('link/add.txt'));
      spy.should.have.been.calledWith(EV.ADD, linkPath);
      spy.should.have.been.calledWith(EV.CHANGE, linkPath);
    });
    it('should not reuse watcher when following a symlink to elsewhere', async () => {
      const linkedPath = dpath('outside');
      const linkedFilePath = pjoin(linkedPath, 'text.txt');
      const linkPath = dpath('subdir/subsub');
      await mkdir(linkedPath, PERM);
      await write(linkedFilePath, 'b');
      await symlink(linkedPath, linkPath);
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
      await watcher2.close();
    });
    it('should emit ready event even when broken symlinks are encountered', async () => {
      const targetDir = dpath('subdir/nonexistent');
      await mkdir(targetDir);
      await symlink(targetDir, dpath('subdir/broken'), isWindows ? 'dir' : null);
      await rm(targetDir, { recursive: true });
      const readySpy = sinon.spy(function readySpy(){});
      const watcher = cwatch(dpath('subdir'), options)
          .on(EV.READY, readySpy);
      await waitForWatcher(watcher);
      readySpy.should.have.been.calledOnce;
    });
  });
  describe('watch arrays of paths/globs', () => {
    it('should watch all paths in an array', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await mkdir(testDir);
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
      await mkdir(testDir);
      const watcher = cwatch([[testDir], [testPath]], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should throw if provided any non-string paths', () => {
      expect(cwatch.bind(null, [[currentDir], /notastring/], options))
        .to.throw(TypeError, /non-string/i);
    });
  });
  describe('watch options', () => {
    describe('ignoreInitial', () => {
      describe('false', () => {
        beforeEach(() => { options.ignoreInitial = false; });
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
          await mkdir(dpath('subdir'), PERM);
          await mkdir(dpath('subdir/subsub'), PERM);
          const watcher = cwatch(currentDir, options);
          const spy = await aspy(watcher, EV.ADD_DIR);
          spy.should.have.been.calledWith(currentDir);
          spy.should.have.been.calledWith(dpath('subdir'));
          spy.should.have.been.calledWith(dpath('subdir/subsub'));
          spy.should.have.been.calledThrice;
        });
      });
      describe('true', () => {
        beforeEach(() => { options.ignoreInitial = true; });
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
          await mkdir(testDir, PERM);
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
          await mkdir(dpath('subdir'), PERM);

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
        await mkdir(testDir, PERM);
        await write(pjoin(testDir, 'add.txt'), '');
        await mkdir(pjoin(testDir, 'subsub'), PERM);
        await write(pjoin(testDir, 'subsub', 'ab.txt'), '');
        const watcher = cwatch(testDir, options);
        const spy = await aspy(watcher, EV.ADD);
        spy.should.have.been.calledOnce;
        spy.should.have.been.calledWith(pjoin(testDir, 'add.txt'));
      });
      it('should not choke on an ignored watch path', async () => {
        options.ignored = () => { return true; };
        await waitForWatcher(cwatch(currentDir, options));
      });
      it('should ignore the contents of ignored dirs', async () => {
        const testDir = dpath('subdir');
        const testFile = pjoin(testDir, 'add.txt');
        options.ignored = testDir;
        await mkdir(testDir, PERM);
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
        await mkdir(dpath('subdir'), PERM);
        await write(dpath('subdir/add.txt'), 'b');
        await delay();
        await mkdir(dpath('subdir/subsub'), PERM);
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
        await symlink(dpath('subdir'), dpath('link'), isWindows ? 'dir' : null);
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
        await symlink(dpath('subdir'), linkPath, isWindows ? 'dir' : null);
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
        await mkdir(subdir2, PERM);
        await waitFor([[addSpy, 3]]);
        addSpy.should.have.been.calledThrice;

        await rm(subdir2, { recursive: true });
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
        await unl(dpath('.change.txt.swp'));
        await unl(dpath('add.txt~'));
        await unl(dpath('.subl5f4.tmp'));
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
        await unl(dpath('unlink.txt'));
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

        await mkdir(testDir, PERM);
        const watcher = cwatch('.', options);

        await new Promise((resolve) => {
          setTimeout(() => {
            watcher.on(EV.ADD_DIR, spy);
            rename(testDir, renamedDir);
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
        const options2 = {};
        Object.keys(options).forEach((key) => {
          options2[key] = options[key];
        });
        options2.cwd = dpath('subdir');
        const watcher = cwatch(gpath('.'), options);
        const watcherEvents = waitForEvents(watcher, 3);
        const spy1 = await aspy(watcher, EV.ALL);

        await delay();
        const watcher2 = cwatch(currentDir, options2);
        const watcher2Events = waitForEvents(watcher2, 5);
        const spy2 = await aspy(watcher2, EV.ALL);

        await unl(dpath('unlink.txt'));
        await write(dpath('change.txt'), dateNow());
        await Promise.all([watcherEvents, watcher2Events]);
        spy1.should.have.been.calledWith(EV.CHANGE, 'change.txt');
        spy1.should.have.been.calledWith(EV.UNLINK, 'unlink.txt');
        spy2.should.have.been.calledWith(EV.ADD, pjoin('..', 'change.txt'));
        spy2.should.have.been.calledWith(EV.ADD, pjoin('..', 'unlink.txt'));
        spy2.should.have.been.calledWith(EV.CHANGE, pjoin('..', 'change.txt'));
        spy2.should.have.been.calledWith(EV.UNLINK, pjoin('..', 'unlink.txt'));
      });
      it('should ignore files even with cwd', async () => {
        options.cwd = currentDir;
        options.ignored = ['ignored-option.txt', 'ignored.txt'];
        const files = [
          '.'
        ];
        await write(dpath('change.txt'), 'hello');
        await write(dpath('ignored.txt'), 'ignored');
        await write(dpath('ignored-option.txt'), 'ignored option');
        const watcher = cwatch(files, options);

        const spy = await aspy(watcher, EV.ALL);
        await write(dpath('ignored.txt'), dateNow());
        await write(dpath('ignored-option.txt'), dateNow());
        await unl(dpath('ignored.txt'));
        await unl(dpath('ignored-option.txt'));
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
      let filePath;
      beforeEach(async () => {
        filePath = dpath('add.txt');
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
          const spy = await aspy(cwatch(currentDir, options), EV.ALL);
          spy.should.not.have.been.calledWith(EV.ADD, filePath);
          await write(filePath, dateNow());

          await delay(200);
          spy.should.not.have.been.calledWith(EV.CHANGE, filePath);
        });
      });
      describe('true', () => {
        beforeEach(() => { options.ignorePermissionErrors = true; });
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
        options.awaitWriteFinish = {stabilityThreshold: 500};
        options.ignoreInitial = true;
      });
      it('should use default options if none given', () => {
        options.awaitWriteFinish = true;
        const watcher = cwatch(currentDir, options);
        expect(watcher.options.awaitWriteFinish.pollInterval).to.equal(100);
        expect(watcher.options.awaitWriteFinish.stabilityThreshold).to.equal(2000);
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
        await unl(testPath);
        await delay(400);
        spy.should.not.have.been.calledWith(sinon.match.string, testPath);
      });
      it('should be compatible with the cwd option', async () => {
        const testPath = dpath('subdir/add.txt');
        const filename = pbasename(testPath);
        options.cwd = pdirname(testPath);
        await mkdir(options.cwd);

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
        const filename = pbasename(testPath);
        options.cwd = pdirname(testPath);
        await mkdir(options.cwd);
        await delay();
        await write(testPath, 'hello');
        await delay();
        const spy = await aspy(cwatch(currentDir, options), EV.ALL);
        await write(testPath, 'edit');
        await delay();
        await unl(testPath);
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
          const testPath = dpath('add.txt');
          cwatch(currentDir, options)
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
      expected[pdirname(currentDir)] = [testId.toString()];
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
        'subdir': []
      };
      await mkdir(dpath('subdir'), PERM);
      const watcher = cwatch(currentDir, options);
      await waitForWatcher(watcher);
      expect(watcher.getWatched()).to.deep.equal(expected);
    });
  });
  describe('unwatch', () => {
    beforeEach(async () => {
      options.ignoreInitial = true;
      await mkdir(dpath('subdir'), PERM);
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
      await unl(unlinkFile);
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
      const fixturesDir = prelative(process.cwd(), currentDir);
      const subdir = pjoin(fixturesDir, 'subdir');
      const changeFile = pjoin(fixturesDir, 'change.txt');
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
      console.log('watching', watchPaths)
      const watcher = cwatch(watchPaths, options).on(EV.ALL, console.log.bind(console));
      await waitForWatcher(watcher);
      await delay();
      watcher.unwatch(dpath('change.txt'));
      await delay();
      watcher.on(EV.ALL, spy).add(dpath('change.txt'));

      await delay();
      await write(dpath('change.txt'), dateNow());
      console.log('a')
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
      await unl(dpath('unlink.txt'));
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
      const CURR = pjoin(FIXTURES_PATH, testId.toString());
      const fixturesPathRel = pjoin(CURR, 'test-case-1040');
      const linkPath = pjoin(fixturesPathRel, 'symlinkFolder');
      const packagesPath = pjoin(fixturesPathRel, 'packages');
      await mkdir(fixturesPathRel, { recursive: true });
      await mkdir(linkPath);
      await mkdir(packagesPath);

      // Init chokidar
      const watcher = cwatch([]);

      // Add more than 10 folders to cap consolidateThreshhold
      for (let i = 0 ; i < 20 ; i += 1) {
        const folderPath = pjoin(packagesPath, `folder${i}`);
        await mkdir(folderPath);
        const filePath = pjoin(folderPath, `file${i}.js`);
        await write(presolve(filePath), 'file content');
        const symlinkPath = pjoin(linkPath, `folder${i}`);
        await symlink(presolve(folderPath), symlinkPath, isWindows ? 'dir' : null);
        watcher.add(presolve(pjoin(symlinkPath, `file${i}.js`)));
      }

      // Wait to be sure that we have no other event than the update file
      await delay(300);

      const eventsWaiter = waitForEvents(watcher, 1);

      // Update a random generated file to fire an event
      const randomFilePath = pjoin(packagesPath, 'folder17', 'file17.js');
      await write(presolve(randomFilePath), 'file content changer zeri ezhriez');

      // Wait chokidar watch
      await delay(300);

      const events = await eventsWaiter;

      expect(events.length).to.equal(1);
    })
  });
  describe('reproduction of bug in issue #1024', () => {
    it('should detect changes to folders, even if they were deleted before', async () => {
      const id = testId.toString();
      const absoluteWatchedDir = pjoin(FIXTURES_PATH, id, 'test');
      const relativeWatcherDir = pjoin(id, 'test');
      const watcher = cwatch(relativeWatcherDir, {
        persistent: true
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = pjoin(absoluteWatchedDir, 'dir');
        const testSubDirFile = pjoin(absoluteWatchedDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await mkdir(absoluteWatchedDir);
        await mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rmdir will be equalize
        await delay(300);
        await rm(testSubDir, { recursive: true });
        // The following delay is essential otherwise the call of rmdir and mkdir will be equalize
        await delay(300);
        await mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        chai.assert.deepStrictEqual(events, [
          `[ALL] addDir: ${pjoin(id, 'test')}`,
          `[ALL] addDir: ${pjoin(id, 'test', 'dir')}`,
          `[ALL] unlinkDir: ${pjoin(id, 'test', 'dir')}`,
          `[ALL] addDir: ${pjoin(id, 'test', 'dir')}`,
          `[ALL] add: ${pjoin(id, 'test', 'dir', 'file')}`,
        ]);
      } finally {
        await watcher.close();
      }
    });

    it('should detect changes to symlink folders, even if they were deleted before', async () => {
      const id = testId.toString();
      const relativeWatcherDir = pjoin(id, 'test');
      const linkedRelativeWatcherDir = pjoin(id, 'test-link');
      await symlink(
        presolve(relativeWatcherDir),
        linkedRelativeWatcherDir,
        isWindows ? 'dir' : null
      );
      await delay();
      const watcher = cwatch(linkedRelativeWatcherDir, {
        persistent: true,
      });
      try {
        const eventsWaiter = waitForEvents(watcher, 5);
        const testSubDir = pjoin(relativeWatcherDir, 'dir');
        const testSubDirFile = pjoin(relativeWatcherDir, 'dir', 'file');

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await delay();
        await mkdir(relativeWatcherDir);
        await mkdir(testSubDir);
        // The following delay is essential otherwise the call of mkdir and rmdir will be equalize
        await delay(300);
        await rm(testSubDir, { recursive: true });
        // The following delay is essential otherwise the call of rmdir and mkdir will be equalize
        await delay(300);
        await mkdir(testSubDir);
        await delay(300);
        await write(testSubDirFile, '');
        await delay(300);

        const events = await eventsWaiter;

        chai.assert.deepStrictEqual(events, [
          `[ALL] addDir: ${pjoin(id, 'test-link')}`,
          `[ALL] addDir: ${pjoin(id, 'test-link', 'dir')}`,
          `[ALL] unlinkDir: ${pjoin(id, 'test-link', 'dir')}`,
          `[ALL] addDir: ${pjoin(id, 'test-link', 'dir')}`,
          `[ALL] add: ${pjoin(id, 'test-link', 'dir', 'file')}`,
        ]);
      } finally {
        await watcher.close();
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
      await unl(dpath('add.txt'));

      spy.should.not.have.been.called;
    });
    it('should not ignore further events on close with existing watchers', async () => {
      const spy = sinon.spy();
      const watcher1 = cwatch(currentDir);
      const watcher2 = cwatch(currentDir);
      await Promise.all([
        waitForWatcher(watcher1),
        waitForWatcher(watcher2)
      ]);

      // The EV_ADD event should be called on the second watcher even if the first watcher is closed
      watcher2.on(EV.ADD, spy);
      await watcher1.close();

      await write(dpath('add.txt'), 'hello');
      // Ensures EV_ADD is called. Immediately removing the file causes it to be skipped
      await delay(200);
      await unl(dpath('add.txt'));

      spy.should.have.been.calledWith(sinon.match('add.txt'));
    });
    it('should not prevent the process from exiting', async () => {
      const scriptFile = dpath('script.js');
      const chokidarPath = pathToFileURL(pjoin(__dirname, 'esm/index.js'))
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
    const promises = WATCHERS.map(w => w.close());
    await Promise.allSettled(promises);
    await rm(pdirname(currentDir), { recursive: true});
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
async function main() {
  try {
    await rm(FIXTURES_PATH, {recursive: true, force: true});
    await mkdir(FIXTURES_PATH, { recursive: true, mode: PERM });
  } catch (error) {}
  process.chdir(FIXTURES_PATH);
  // Create many directories before tests.
  // Creating them in `beforeEach` increases chance of random failures.
  const _content = await read(__filename, 'utf-8');
  const _only = _content.match(/\sit\.only\(/g);
  const itCount = _only && _only.length || _content.match(/\sit\(/g).length;
  const testCount = itCount * 3;
  console.log('creating', testCount, 'directories');
  while (testId++ < testCount) {
    await mkdir(dpath(''), { recursive: true, mode: PERM });
    await write(dpath('change.txt'), 'b');
    await write(dpath('unlink.txt'), 'b');
  }
  testId = 1;

  await it.run();

  try {
    await rm(FIXTURES_PATH, {recursive: true, force: true});
  } catch (error) {}
  process.chdir(initialPath);
}
main();