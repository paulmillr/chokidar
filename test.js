'use strict';

var chokidar = require('./');
var chai = require('chai');
var expect = chai.expect;
var should = chai.should();
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var rimraf = require('rimraf');
var fs = require('fs');
var sysPath = require('path');
var os = process.platform;

function getFixturePath (subPath) {
  return sysPath.join(
    __dirname,
    'test-fixtures',
    subdir && subdir.toString() || '',
    subPath
  );
}

var watcher,
    watcher2,
    usedWatchers = [],
    fixturesPath = getFixturePath(''),
    subdir = 0,
    options,
    osXFsWatch,
    slowerDelay,
    testCount = 1,
    mochaIt = it;


if (!fs.readFileSync(__filename).toString().match(/\sit\.only\(/)) {
  it = function() {
    testCount++;
    mochaIt.apply(this, arguments);
  }
  it.skip = function() {
    testCount--;
    mochaIt.skip.apply(this, arguments)
  }
}

before(function(done) {
  var writtenCount = 0;
  function wrote(err) {
    if (err) throw err;
    if (++writtenCount === testCount * 2) {
      subdir = 0;
      done();
    }
  }
  rimraf(sysPath.join(__dirname, 'test-fixtures'), function(err) {
    if (err) throw err;
    fs.mkdir(fixturesPath, 0x1ed, function(err) {
      if (err) throw err;
      while (subdir < testCount) {
        subdir++;
        fixturesPath = getFixturePath('');
        fs.mkdir(fixturesPath, 0x1ed, function() {
          fs.writeFile(sysPath.join(this, 'change.txt'), 'b', wrote);
          fs.writeFile(sysPath.join(this, 'unlink.txt'), 'b', wrote);
        }.bind(fixturesPath));
      }
    });
  });
});

beforeEach(function() {
  subdir++;
  fixturesPath = getFixturePath('');
});

function closeWatchers() {
  var u;
  while (u = usedWatchers.pop()) u.close();
}
function disposeWatcher(watcher) {
  if (!watcher || !watcher.close) return;
  osXFsWatch ? usedWatchers.push(watcher) : watcher.close();
}
afterEach(function() {
  disposeWatcher(watcher);
  disposeWatcher(watcher2);
});

describe('chokidar', function() {
  this.timeout(6000);
  it('should expose public API methods', function() {
    chokidar.FSWatcher.should.be.a('function');
    chokidar.watch.should.be.a('function');
  });

  describe('fs.watch (non-polling)', runTests.bind(this, {usePolling: false, useFsEvents: false}));
  describe('fs.watchFile (polling)', runTests.bind(this, {usePolling: true, interval: 10}));
  if (os === 'darwin') describe('fsevents (native extension)', runTests.bind(this, {useFsEvents: true}));
});

function simpleCb(err) { if (err) throw err; }
function w(fn, to) {
  return setTimeout.bind(null, fn, to || slowerDelay ? 200 : 50);
}

function runTests(baseopts) {
  baseopts.persistent = true;

  before(function() {
    // use to prevent failures caused by known issue with fs.watch on OS X
    // unpredictably emitting extra change and unlink events
    osXFsWatch = os === 'darwin' && !baseopts.usePolling && !baseopts.useFsEvents;

    slowerDelay = osXFsWatch || (
      os === 'win32' &&
      process.version.slice(0, 5) === 'v0.10' &&
      baseopts.usePolling
    );
  });

  after(closeWatchers);

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach(function(key) {
      options[key] = baseopts[key]
    });
  });

  function stdWatcher() {
    return watcher = chokidar.watch(fixturesPath, options);
  }

  function waitFor(spies, fn) {
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
    var to = setTimeout(finish, 3000);
  }
  function d(fn, quicker, forceTimeout) {
    if (options.usePolling || forceTimeout) {
      return setTimeout.bind(null, fn, quicker ? 300 : 900);
    } else {
      return setTimeout.bind(null, fn, 25);
    }
  }
  function dd(fn, slower) {
    return d(fn, !slower, true);
  }
  function w(fn, to) {
    return setTimeout.bind(null, fn, to || 25);
  }

  describe('watch a directory', function() {
    var readySpy, rawSpy;
    beforeEach(function() {
      readySpy = sinon.spy(function readySpy(){});
      rawSpy = sinon.spy(function rawSpy(){});
      options.ignoreInitial = true;
      options.alwaysStat = true;
      stdWatcher().on('ready', readySpy).on('raw', rawSpy);
    });
    afterEach(function(done) {
      w(function() {
        readySpy.should.have.been.calledOnce;
        rawSpy = undefined;
        done()
      })();
    });
    it('should produce an instance of chokidar.FSWatcher', function() {
      watcher.should.be.an['instanceof'](chokidar.FSWatcher);
    });
    it('should expose public API methods', function() {
      watcher.on.should.be.a('function');
      watcher.emit.should.be.a('function');
      watcher.add.should.be.a('function');
      watcher.close.should.be.a('function');
    });
    it('should emit `add` event when file was added', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      watcher.on('add', spy).on('ready', w(function() {
        waitFor([spy], function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
        fs.writeFile(testPath, 'hello', simpleCb);
      }));
    });
    it('should emit `addDir` event when directory was added', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      watcher.on('addDir', spy).on('ready', w(function() {
        spy.should.not.have.been.called;
        waitFor([spy], function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testDir);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
        fs.mkdir(testDir, 0x1ed, simpleCb);
      }));
    });
    it('should emit `change` event when file was changed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      watcher.on('change', spy).on('ready', function() {
        spy.should.not.have.been.called;
        waitFor([spy], function() {
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
        fs.writeFile(testPath, Date.now(), simpleCb);
      });
    });
    it('should emit `unlink` event when file was removed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      watcher.on('unlink', spy).on('ready', function() {
        spy.should.not.have.been.called;
        waitFor([spy], function() {
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.not.be.ok; // no stats
          rawSpy.should.have.been.called;
          done();
        });
        fs.unlink(testPath, simpleCb);
      });
    });
    it('should emit `unlinkDir` event when a directory was removed', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir, 0x1ed);
      watcher.on('unlinkDir', spy).on('ready', function() {
        waitFor([spy], function() {
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testDir);
          expect(spy.args[0][1]).to.not.be.ok; // no stats
          rawSpy.should.have.been.called;
          done();
        });
        w(fs.rmdir.bind(fs, testDir, simpleCb))();
      });
    });
    it('should emit `unlink` and `add` events when a file is renamed', function(done) {
      var unlinkSpy = sinon.spy(function unlink(){});
      var addSpy = sinon.spy(function add(){});
      var testPath = getFixturePath('change.txt');
      var newPath = getFixturePath('moved.txt');
      watcher
        .on('unlink', unlinkSpy)
        .on('add', addSpy)
        .on('ready', function() {
          unlinkSpy.should.not.have.been.called;
          addSpy.should.not.have.been.called;
          waitFor([unlinkSpy, addSpy], function() {
            if (!osXFsWatch) unlinkSpy.should.have.been.calledOnce;
            unlinkSpy.should.have.been.calledWith(testPath);
            expect(unlinkSpy.args[0][1]).to.not.be.ok; // no stats
            addSpy.should.have.been.calledOnce;
            addSpy.should.have.been.calledWith(newPath);
            expect(addSpy.args[0][1]).to.be.ok; // stats
            rawSpy.should.have.been.called;
            done();
          });
          w(fs.rename.bind(fs, testPath, newPath, simpleCb))();
        });
    });
    it('should emit `add`, not `change`, when previously deleted file is re-added', function(done) {
      // false negatives in appveyor on node 0.10, skip for now
      if (os === 'win32' && process.version.slice(0, 5) === 'v0.10' && options.usePolling) {
        return done();
      }

      var unlinkSpy = sinon.spy(function unlink(){});
      var addSpy = sinon.spy(function add(){});
      var changeSpy = sinon.spy(function change(){});
      var testPath = getFixturePath('add.txt');
      fs.writeFileSync(testPath, 'hello');
      watcher
        .on('unlink', unlinkSpy)
        .on('add', addSpy)
        .on('change', changeSpy)
        .on('ready', function() {
          unlinkSpy.should.not.have.been.called;
          addSpy.should.not.have.been.called;
          changeSpy.should.not.have.been.called;
          waitFor([unlinkSpy.withArgs(testPath)], function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            waitFor([addSpy.withArgs(testPath)], function() {
              addSpy.should.have.been.calledWith(testPath);
              changeSpy.should.not.have.been.called;
              done();
            });
            w(fs.writeFile.bind(fs, testPath, 'b', simpleCb))();
          });
          fs.unlink(testPath, simpleCb);
        });
    });
    it('should not emit `unlink` for previously moved files', function(done) {
      var unlinkSpy = sinon.spy(function unlink(){});
      var testPath = getFixturePath('change.txt');
      var newPath1 = getFixturePath('moved.txt');
      var newPath2 = getFixturePath('moved-again.txt');
      watcher
        .on('unlink', unlinkSpy)
        .on('ready', function() {
          waitFor([unlinkSpy.withArgs(newPath1)], function() {
            unlinkSpy.withArgs(testPath).should.have.been.calledOnce;
            unlinkSpy.withArgs(newPath1).should.have.been.calledOnce;
            unlinkSpy.withArgs(newPath2).should.not.have.been.called;
            done();
          });
          fs.rename(testPath, newPath1, function(err) {
            if (err) throw err;
            w(fs.rename.bind(fs, newPath1, newPath2, simpleCb), 300)();
          });
        });
    });
    it('should survive ENOENT for missing subdirectories', function(done) {
      var testDir;
      testDir = getFixturePath('notadir');
      watcher.on('ready', function() {
        watcher.add(testDir);
        done();
      });
    });
    it('should notice when a file appears in a new directory', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      var testPath = getFixturePath('subdir/add.txt');
      watcher.on('add', spy).on('ready', function() {
        spy.should.not.have.been.called;
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(testPath, 'hello');
        waitFor([spy], function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      });
    });
    it('should watch removed and re-added directories', function(done) {
      // false negatives in appveyor on node 0.10, skip for now
      if (os === 'win32' && process.version.slice(0, 5) === 'v0.10' && options.usePolling) {
        return done();
      }

      var unlinkSpy = sinon.spy(function unlinkSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      var parentPath = getFixturePath('subdir2');
      var subPath = getFixturePath('subdir2/subsub');
      watcher
        .on('unlinkDir', unlinkSpy)
        .on('addDir', addSpy)
        .on('ready', function() {
          fs.mkdirSync(parentPath);
          d(function() {
            fs.rmdirSync(parentPath);
            waitFor([unlinkSpy.withArgs(parentPath)], function() {
              unlinkSpy.should.have.been.calledWith(parentPath);
              d(function() {
                fs.mkdirSync(parentPath);
                d(function() {
                  fs.mkdirSync(subPath);
                  waitFor([[addSpy, 3]], function() {
                    addSpy.should.have.been.calledWith(parentPath);
                    addSpy.should.have.been.calledWith(subPath);
                    try {
                      fs.rmdir(subPath, dd(fs.rmdir.bind(fs, parentPath, done)));
                    } catch(e) {
                      done();
                    }
                  });
                }, false, true)();
              }, false, true)();
            });
          }, false, true)();
        });
    });
  });
  describe('watch individual files', function() {
    it('should detect changes', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options)
        .on('change', spy)
        .on('ready', function() {
          waitFor([spy], function() {
            spy.should.have.always.been.calledWith(testPath);
            done();
          });
          fs.writeFile(testPath, 'c', simpleCb);
        });
    });
    it('should detect unlinks', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      watcher = chokidar.watch(testPath, options)
        .on('unlink', spy)
        .on('ready', function() {
          waitFor([spy], function() {
            spy.should.have.been.calledWith(testPath);
            done();
          });
          fs.unlink(testPath, simpleCb);
        });
    });
    it('should detect unlink and re-add', function(done) {
      var unlinkSpy = sinon.spy(function unlinkSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      var testPath = getFixturePath('unlink.txt');
      options.ignoreInitial = true;
      watcher = chokidar.watch(testPath, options)
        .on('unlink', unlinkSpy)
        .on('add', addSpy)
        .on('ready', function() {
          w(fs.unlink.bind(fs, testPath, simpleCb))();
          waitFor([unlinkSpy], w(function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            w(fs.writeFile.bind(fs, testPath, 're-added', simpleCb))();
            waitFor([addSpy], function() {
              addSpy.should.have.been.calledWith(testPath);
              done();
            });
          }));
        });
    });
    it('should ignore unwatched siblings', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      var siblingPath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options)
        .on('all', spy)
        .on('ready', w(function() {
          fs.writeFile(siblingPath, 'c', simpleCb);
          fs.writeFile(testPath, 'a', simpleCb);
          waitFor([spy], function() {
            spy.should.have.always.been.calledWith('add', testPath);
            done();
          });
        }));
    });
  });
  describe('watch non-existent paths', function() {
    it('should watch non-existent file and detect add', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      watcher = chokidar.watch(testPath, options)
        .on('add', spy)
        .on('ready', function() {
          waitFor([spy], function() {
            spy.should.have.been.calledWith(testPath);
            done();
          });
          w(fs.writeFile.bind(fs, testPath, 'a', simpleCb))();
        });
    });
    it('should watch non-existent dir and detect addDir/add', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      var testPath = getFixturePath('subdir/add.txt');
      watcher = chokidar.watch(testDir, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.not.have.been.called;
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('addDir', testDir);
            spy.should.have.been.calledWith('add', testPath);
            done();
          });
          w(fs.mkdir.bind(fs, testDir, 0x1ed, function() {
            w(fs.writeFile.bind(fs, testPath, 'hello', simpleCb), 100)();
          }, 100))();
        });
    });
  });
  describe('watch glob patterns', function() {
    it('should correctly watch and emit based on glob input', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('*a*.txt');
      var addPath = getFixturePath('add.txt');
      var changePath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', changePath);
          waitFor([[spy, 3], spy.withArgs('add', addPath)], function() {
            spy.should.have.been.calledWith('add', addPath);
            spy.should.have.been.calledWith('change', changePath);
            spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
            spy.should.not.have.been.calledWith('addDir');
            done();
          });
          w(fs.writeFile.bind(fs, addPath, 'a', simpleCb))();
          w(fs.writeFile.bind(fs, changePath, 'c', simpleCb))();
        });
    });
    it('should respect negated glob patterns', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('*');
      var negatedPath = '!' + getFixturePath('*a*.txt');
      var unlinkPath = getFixturePath('unlink.txt');
      watcher = chokidar.watch([testPath, negatedPath], options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith('add', unlinkPath);
          waitFor([[spy, 2], spy.withArgs('unlink')], function() {
            if (!osXFsWatch) spy.should.have.been.calledTwice;
            spy.should.have.been.calledWith('unlink', unlinkPath);
            done();
          });
          w(fs.unlink.bind(fs, unlinkPath, simpleCb))();
        });
    });
    it('should traverse subdirs to match globstar patterns', function(done) {
      var spy = sinon.spy();
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      fs.writeFileSync(getFixturePath('subdir/a.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/b.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/subsub/ab.txt'), 'b');
      var watchPath = getFixturePath('../../test-*/' + subdir + '/**/a*.txt');
      watcher = chokidar.watch(watchPath, options)
        .on('all', spy)
        .on('ready', d(function() {
          fs.writeFileSync(getFixturePath('add.txt'), 'a');
          fs.writeFileSync(getFixturePath('subdir/subsub/ab.txt'), 'a');
          fs.unlinkSync(getFixturePath('subdir/a.txt'));
          fs.unlinkSync(getFixturePath('subdir/b.txt'));
          waitFor([[spy, 5], [spy.withArgs('add'), 3]], function() {
            spy.withArgs('add').should.have.been.calledThrice;
            spy.withArgs('unlink').should.have.been.calledWith('unlink', getFixturePath('subdir/a.txt'));
            spy.withArgs('change').should.have.been.calledWith('change', getFixturePath('subdir/subsub/ab.txt'));
            if (!osXFsWatch) spy.withArgs('unlink').should.have.been.calledOnce;
            if (!osXFsWatch) spy.withArgs('change').should.have.been.calledOnce;
            done();
          });
        }));
    });
    it('should resolve relative paths with glob patterns', function(done) {
      var spy = sinon.spy();
      var testPath = 'test-*/' + subdir + '/*a*.txt';
      // getFixturesPath() returns absolute paths, so use sysPath.join() instead
      var addPath = sysPath.join('test-fixtures', subdir.toString(), 'add.txt');
      var changePath = sysPath.join('test-fixtures', subdir.toString(), 'change.txt');
      var unlinkPath = sysPath.join('test-fixtures', subdir.toString(), 'unlink.txt');
      watcher = chokidar.watch(testPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', changePath);
          waitFor([[spy, 3], spy.withArgs('add', addPath)], function() {
            spy.should.have.been.calledWith('add', addPath);
            spy.should.have.been.calledWith('change', changePath);
            spy.should.not.have.been.calledWith('add', unlinkPath);
            spy.should.not.have.been.calledWith('addDir');
            /*if (!osXFsWatch) */spy.should.have.been.calledThrice;
            done();
          });
          w(fs.writeFile.bind(fs, addPath, 'a', simpleCb))();
          w(fs.writeFile.bind(fs, changePath, 'c', simpleCb))();
        });
    });
    it('should correctly handle conflicting glob patterns', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var unlinkPath = getFixturePath('unlink.txt');
      var addPath = getFixturePath('add.txt');
      var watchPaths = [getFixturePath('change*'), getFixturePath('unlink*')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', changePath);
          spy.should.have.been.calledWith('add', unlinkPath);
          spy.should.have.been.calledTwice;
          waitFor([[spy, 4], spy.withArgs('unlink', unlinkPath)], function() {
            spy.should.have.been.calledWith('change', changePath);
            spy.should.have.been.calledWith('unlink', unlinkPath);
            spy.should.not.have.been.calledWith('add', addPath);
            /*if (!osXFsWatch) */spy.callCount.should.equal(4);
            done();
          });
          w(fs.writeFile.bind(fs, addPath, 'a', simpleCb))();
          w(fs.writeFile.bind(fs, changePath, 'c', simpleCb))();
          w(fs.unlink.bind(fs, unlinkPath, simpleCb))();
        });
    });
    it('should correctly handle intersecting glob patterns', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var watchPaths = [getFixturePath('cha*'), getFixturePath('*nge.*')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', changePath);
          /*if (!osXFsWatch) */ spy.should.have.been.calledOnce;
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('change', changePath);
            if (!osXFsWatch) spy.should.have.been.calledTwice;
            done();
          });
          w(fs.writeFile.bind(fs, changePath, 'c', simpleCb))();
        });
    });
    it('should not confuse glob-like filenames with globs', function(done) {
      var spy = sinon.spy();
      var filePath = getFixturePath('nota[glob].txt');
      fs.writeFileSync(filePath, 'b');
      d(function() {
        stdWatcher()
          .on('all', spy)
          .on('ready', d(function() {
            spy.should.have.been.calledWith('add', filePath);
            fs.writeFileSync(filePath, 'c');
            waitFor([spy.withArgs('change', filePath)], function() {
              spy.should.have.been.calledWith('change', filePath);
              done();
            });
          }));
      }, true)();
    });
    it('should not prematurely filter dirs against complex globstar patterns', function(done) {
      var spy = sinon.spy();
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), 0x1ed);
      var deepFile = getFixturePath('subdir/subsub/subsubsub/a.txt');
      fs.writeFileSync(deepFile, 'b');
      var watchPath = getFixturePath('../../test-*/' + subdir + '/**/subsubsub/*.txt');
      watcher = chokidar.watch(watchPath, options)
        .on('all', spy)
        .on('ready', d(function() {
          fs.writeFileSync(deepFile, 'a');
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('add', deepFile);
            spy.should.have.been.calledWith('change', deepFile);
            done();
          });
        }));
    });
  });
  describe('watch symlinks', function() {
    if (os === 'win32') return;
    var linkedDir;
    beforeEach(function(done) {
      linkedDir = sysPath.resolve(fixturesPath, '..', subdir + '-link');
      fs.symlink(fixturesPath, linkedDir, function() {
        fs.mkdir(getFixturePath('subdir'), 0x1ed, function() {
          fs.writeFile(getFixturePath('subdir/add.txt'), 'b', done);
        });
      });
    });
    afterEach(function(done) {
      fs.unlink(linkedDir, done);
    });
    it('should watch symlinked dirs', function(done) {
      var dirSpy = sinon.spy(function dirSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      watcher = chokidar.watch(linkedDir, options)
        .on('addDir', dirSpy)
        .on('add', addSpy)
        .on('ready', function() {
          dirSpy.should.have.been.calledWith(linkedDir);
          addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'change.txt'));
          addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'unlink.txt'));
          done();
        });
    });
    it('should watch symlinked files', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var linkPath = getFixturePath('link.txt');
      fs.symlinkSync(changePath, linkPath);
      watcher = chokidar.watch(linkPath, options)
        .on('all', spy)
        .on('ready', function() {
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
          fs.writeFile(changePath, 'c', simpleCb);
        });
    });
    it('should follow symlinked files within a normal dir', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var linkPath = getFixturePath('subdir/link.txt');
      fs.symlinkSync(changePath, linkPath);
      watcher = chokidar.watch(getFixturePath('subdir'), options)
        .on('all', spy)
        .on('ready', function() {
          waitFor([spy.withArgs('change', linkPath)], function() {
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
          fs.writeFile(changePath, 'c', simpleCb);
        });
    });
    it('should watch paths with a symlinked parent', function(done) {
      var spy = sinon.spy();
      var testDir = sysPath.join(linkedDir, 'subdir');
      var testFile = sysPath.join(testDir, 'add.txt');
      d(function() {
        watcher = chokidar.watch(testDir, options)
          .on('all', spy)
          .on('ready', d(function() {
            spy.should.have.been.calledWith('addDir', testDir);
            spy.should.have.been.calledWith('add', testFile);
            fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
            waitFor([spy.withArgs('change')], function() {
              spy.should.have.been.calledWith('change', testFile);
              done();
            });
          }));
      }, true)();
    });
    it('should not recurse indefinitely on circular symlinks', function(done) {
      fs.symlinkSync(fixturesPath, getFixturePath('subdir/circular'));
      stdWatcher().on('ready', done);
    });
    it('should recognize changes following symlinked dirs', function(done) {
      var spy = sinon.spy(function changeSpy(){});
      watcher = chokidar.watch(linkedDir, options)
        .on('change', spy)
        .on('ready', function() {
          var linkedFilePath = sysPath.join(linkedDir, 'change.txt');
          waitFor([spy.withArgs(linkedFilePath)], function() {
            spy.should.have.been.calledWith(linkedFilePath);
            done();
          });
          fs.writeFile(getFixturePath('change.txt'), 'c', simpleCb);
        });
    });
    it('should follow newly created symlinks', function(done) {
      var spy = sinon.spy();
      options.ignoreInitial = true;
      stdWatcher()
        .on('all', spy)
        .on('ready', function() {
          waitFor([
            spy.withArgs('add', getFixturePath('link/add.txt')),
            spy.withArgs('addDir', getFixturePath('link'))
          ], function() {
            spy.should.have.been.calledWith('addDir', getFixturePath('link'));
            spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
            done();
          });
          w(fs.symlink.bind(fs, getFixturePath('subdir'), getFixturePath('link'), simpleCb))();
        });
    });
    it('should watch symlinks as files when followSymlinks:false', function(done) {
      var spy = sinon.spy();
      options.followSymlinks = false;
      watcher = chokidar.watch(linkedDir, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.not.have.been.calledWith('addDir');
          spy.should.have.been.calledWith('add', linkedDir);
          spy.should.have.been.calledOnce;
          done();
        });
    });
    it('should watch symlinks within a watched dir as files when followSymlinks:false', function(done) {
      var spy = sinon.spy();
      options.followSymlinks = false;
      var linkPath = getFixturePath('link');
      fs.symlinkSync(getFixturePath('subdir'), linkPath);
      d(function() {
        stdWatcher()
          .on('all', spy)
          .on('ready', d(function() {
            fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
            fs.unlinkSync(linkPath);
            fs.symlinkSync(getFixturePath('subdir/add.txt'), linkPath);
            waitFor([spy.withArgs('change', linkPath)], function() {
              spy.should.not.have.been.calledWith('addDir', linkPath);
              spy.should.not.have.been.calledWith('add', getFixturePath('link/add.txt'));
              spy.should.have.been.calledWith('add', linkPath);
              spy.should.have.been.calledWith('change', linkPath);
              done();
            });
          }));
      }, true)();
    });
    it('should not reuse watcher when following a symlink to elsewhere', function(done) {
      var spy = sinon.spy();
      var linkedPath = getFixturePath('outside');
      var linkedFilePath = sysPath.join(linkedPath, 'text.txt');
      fs.mkdirSync(linkedPath, 0x1ed);
      fs.writeFileSync(linkedFilePath, 'c');
      var linkPath = getFixturePath('subdir/subsub');
      fs.symlinkSync(linkedPath, linkPath);
      watcher2 = chokidar.watch(getFixturePath('subdir'), options)
        .on('ready', d(function() {
          var watchedPath = getFixturePath('subdir/subsub/text.txt');
          watcher = chokidar.watch(watchedPath, options)
            .on('all', spy)
            .on('ready', d(function() {
              fs.writeFileSync(linkedFilePath, 'd');
              waitFor([spy.withArgs('change')], function() {
                spy.should.have.been.calledWith('change', watchedPath);
                done();
              });
            }));
        }, true));
    });
  });
  describe('watch arrays of paths/globs', function() {
    it('should watch all paths in an array', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      var testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir);
      watcher = chokidar.watch([testDir, testPath], options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', testPath);
          spy.should.have.been.calledWith('addDir', testDir);
          spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('change', testPath);
            done();
          });
          fs.writeFile(testPath, Date.now(), simpleCb);
        });
    });
    it('should accommodate nested arrays in input', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      var testDir = getFixturePath('subdir');
      fs.mkdir(testDir, function() {
        watcher = chokidar.watch([[testDir], [testPath]], options)
          .on('all', spy)
          .on('ready', function() {
            spy.should.have.been.calledWith('add', testPath);
            spy.should.have.been.calledWith('addDir', testDir);
            spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
            waitFor([spy.withArgs('change')], function() {
              spy.should.have.been.calledWith('change', testPath);
              done();
            });
            fs.writeFile(testPath, Date.now(), simpleCb);
          });
      });
    });
    it('should throw if provided any non-string paths', function() {
      expect(chokidar.watch.bind(null, [[fixturesPath], /notastring/]))
        .to.throw(TypeError, /non-string/i);
    });
  });
  describe('watch options', function() {
    describe('ignoreInitial', function() {
      describe('false', function() {
        beforeEach(function() { options.ignoreInitial = false; });
        it('should emit `add` events for preexisting files', function(done) {
          var spy = sinon.spy();
          watcher = chokidar.watch(fixturesPath, options)
            .on('add', spy)
            .on('ready', function() {
              spy.should.have.been.calledTwice;
              done();
            });
        });
        it('should emit `addDir` event for watched dir', function(done) {
          var spy = sinon.spy();
          watcher = chokidar.watch(fixturesPath, options)
            .on('addDir', spy)
            .on('ready', function() {
              spy.should.have.been.calledOnce;
              spy.should.have.been.calledWith(fixturesPath);
              done();
            });
        });
        it('should emit `addDir` events for preexisting dirs', function(done) {
          var spy = sinon.spy();
          fs.mkdir(getFixturePath('subdir'), 0x1ed, function() {
            fs.mkdir(getFixturePath('subdir/subsub'), 0x1ed, function() {
              watcher = chokidar.watch(fixturesPath, options)
                .on('addDir', spy)
                .on('ready', function() {
                  spy.should.have.been.calledWith(fixturesPath);
                  spy.should.have.been.calledWith(getFixturePath('subdir'));
                  spy.should.have.been.calledWith(getFixturePath('subdir/subsub'));
                  /*if (!osXFsWatch)*/ spy.should.have.been.calledThrice;
                  done();
                });
            });
          });
        });
      });
      describe('true', function() {
        beforeEach(function() { options.ignoreInitial = true; });
        it('should ignore inital add events', function(done) {
          var spy = sinon.spy();
          stdWatcher()
            .on('add', spy)
            .on('ready', w(function() {
              spy.should.not.have.been.called;
              done();
            }));
        });
        it('should ignore add events on a subsequent .add()', function(done) {
          var spy = sinon.spy();
          watcher = chokidar.watch(getFixturePath('subdir'), options)
            .on('add', spy)
            .on('ready', function() {
              watcher.add(fixturesPath);
              w(function() {
                spy.should.not.have.been.called;
                done();
              }, 500)();
          });
        });
        it('should notice when a file appears in an empty directory', function(done) {
          var spy = sinon.spy();
          var testDir = getFixturePath('subdir');
          var testPath = getFixturePath('subdir/add.txt');
          stdWatcher()
            .on('add', spy)
            .on('ready', function() {
              spy.should.not.have.been.called;
              waitFor([spy], function() {
                spy.should.have.been.calledOnce;
                spy.should.have.been.calledWith(testPath);
                done();
              });
              fs.mkdir(testDir, 0x1ed, function() {
                fs.writeFile(testPath, Date.now(), simpleCb);
              });
            });
        });
        it('should emit a change on a preexisting file as a change', function(done) {
          var spy = sinon.spy();
          var testPath = getFixturePath('change.txt');
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              spy.should.not.have.been.called;
              waitFor([spy.withArgs('change', testPath)], function() {
                spy.should.have.been.calledWith('change', testPath);
                spy.should.not.have.been.calledWith('add');
                done();
              });
              fs.writeFile(testPath, Date.now(), simpleCb);
            });
        });
        it('should not emit for preexisting dirs when depth is 0', function(done) {
          var spy = sinon.spy();
          var testPath = getFixturePath('add.txt');
          options.depth = 0
          fs.mkdir(getFixturePath('subdir'), 0x1ed, w(function() {
            stdWatcher()
              .on('all', spy)
              .on('ready', function() {
                waitFor([spy], w(function() {
                  spy.should.have.been.calledWith('add', testPath);
                  spy.should.not.have.been.calledWith('addDir');
                  done();
                }, 200));
                fs.writeFile(testPath, Date.now(), simpleCb);
              });
          }, 200));
        });
      });
    });
    describe('ignored', function() {
      it('should check ignore after stating', function(done) {
        var spy = sinon.spy();
        var testDir = getFixturePath('subdir');
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(sysPath.join(testDir, 'add.txt'), '');
        fs.mkdirSync(sysPath.join(testDir, 'subsub'), 0x1ed);
        fs.writeFileSync(sysPath.join(testDir, 'subsub', 'ab.txt'), '');
        function ignoredFn(path, stats) {
          if (path === testDir || !stats) return false;
          return stats.isDirectory();
        }
        options.ignored = ignoredFn;
        watcher = chokidar.watch(testDir, options)
          .on('add', spy)
          .on('ready', function() {
            spy.should.have.been.calledOnce;
            spy.should.have.been.calledWith(sysPath.join(testDir, 'add.txt'));
            done();
          });
      });
      it('should not choke on an ignored watch path', function(done) {
        options.ignored = function() { return true; };
        stdWatcher().on('ready', done);
      });
      it('should ignore the contents of ignored dirs', function(done) {
        var spy = sinon.spy();
        var testDir = getFixturePath('subdir');
        var testFile = sysPath.join(testDir, 'add.txt');
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(testFile, 'b');
        options.ignored = testDir;
        watcher = chokidar.watch(fixturesPath, options)
          .on('all', spy)
          .on('ready', w(function() {
            w(function() {
              spy.should.not.have.been.calledWith('addDir', testDir);
              spy.should.not.have.been.calledWith('add', testFile);
              spy.should.not.have.been.calledWith('change', testFile);
              done();
            }, 300)();
            fs.writeFile(testFile, 'a', simpleCb);
          }));
      });
      it('should allow regex/fn ignores', function(done) {
        var spy = sinon.spy();
        fs.writeFileSync(getFixturePath('add.txt'), 'b');
        options.cwd = fixturesPath;
        options.ignored = /add/;
        watcher = chokidar.watch(fixturesPath, options)
          .on('all', spy)
          .on('ready', function() {
            waitFor([spy.withArgs('change', 'change.txt')], function() {
              spy.should.not.have.been.calledWith('add', 'add.txt');
              spy.should.not.have.been.calledWith('change', 'add.txt');
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              done();
            });
            w(fs.writeFile.bind(fs, getFixturePath('add.txt'), 'a', simpleCb))();
            w(fs.writeFile.bind(fs, getFixturePath('change.txt'), 'a', simpleCb))();
          });
      });
    });
    describe('depth', function() {
      beforeEach(function(done) {
        var i = 0, r = function() { i++ && w(done, options.useFsEvents && 200)(); };
        fs.mkdir(getFixturePath('subdir'), 0x1ed, function() {
          fs.writeFile(getFixturePath('subdir/add.txt'), 'b', r);
          fs.mkdir(getFixturePath('subdir/subsub'), 0x1ed, function() {
            fs.writeFile(getFixturePath('subdir/subsub/ab.txt'), 'b', r);
          });
        });
      });
      it('should not recurse if depth is 0', function(done) {
        options.depth = 0;
        var spy = sinon.spy();
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            waitFor([[spy, 4]], function() {
              spy.should.have.been.calledWith('addDir', fixturesPath);
              spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
              spy.should.have.been.calledWith('add', getFixturePath('change.txt'));
              spy.should.have.been.calledWith('add', getFixturePath('unlink.txt'));
              spy.should.not.have.been.calledWith('change');
              if (!osXFsWatch) spy.callCount.should.equal(4);
              done();
            });
            fs.writeFile(getFixturePath('subdir/add.txt'), 'c', simpleCb);
          });
      });
      it('should recurse to specified depth', function(done) {
        options.depth = 1;
        var spy = sinon.spy();
        var addPath = getFixturePath('subdir/add.txt');
        var changePath = getFixturePath('change.txt');
        var ignoredPath = getFixturePath('subdir/subsub/ab.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            waitFor([spy.withArgs('change', addPath), spy.withArgs('change', changePath)], function() {
              spy.should.have.been.calledWith('addDir', getFixturePath('subdir/subsub'));
              spy.should.have.been.calledWith('change', changePath);
              spy.should.have.been.calledWith('change', addPath);
              spy.should.not.have.been.calledWith('add', ignoredPath);
              spy.should.not.have.been.calledWith('change', ignoredPath);
              if (!osXFsWatch) spy.callCount.should.equal(8);
              done();
            });
            w(function() {
              fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
              fs.writeFile(addPath, Date.now(), simpleCb);
              fs.writeFile(ignoredPath, Date.now(), simpleCb);
            })();
          });
      });
      it('should respect depth setting when following symlinks', function(done) {
        if (os === 'win32') return done(); // skip on windows
        options.depth = 1;
        var spy = sinon.spy();
        fs.symlink(getFixturePath('subdir'), getFixturePath('link'), w(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              spy.should.have.been.calledWith('addDir', getFixturePath('link'));
              spy.should.have.been.calledWith('addDir', getFixturePath('link/subsub'));
              spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
              spy.should.not.have.been.calledWith('add', getFixturePath('link/subsub/ab.txt'));
              done();
            });
        }));
      });
      it('should respect depth setting when following a new symlink', function(done) {
        if (os === 'win32') return done(); // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        var spy = sinon.spy();
        var linkPath = getFixturePath('link');
        var dirPath = getFixturePath('link/subsub');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            waitFor([[spy, 3], spy.withArgs('addDir', dirPath)], function() {
              spy.should.have.been.calledWith('addDir', linkPath);
              spy.should.have.been.calledWith('addDir', dirPath);
              spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
              if (!osXFsWatch) spy.should.have.been.calledThrice;
              done();
            });
            fs.symlink(getFixturePath('subdir'), linkPath, simpleCb);
          });
      });
      it('should correctly handle dir events when depth is 0', function(done) {
        options.depth = 0;
        var spy = sinon.spy();
        var addSpy = spy.withArgs('addDir');
        var unlinkSpy = spy.withArgs('unlinkDir');
        var subdir2 = getFixturePath('subdir2');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            spy.should.have.been.calledWith('addDir', fixturesPath);
            spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
            waitFor([[addSpy, 3]], function() {
              addSpy.should.have.been.calledThrice;
              waitFor([unlinkSpy], w(function() {
                unlinkSpy.should.have.been.calledOnce;
                unlinkSpy.should.have.been.calledWith('unlinkDir', subdir2);
                done();
              }));
              fs.rmdir(subdir2, simpleCb);
            });
            fs.mkdir(subdir2, 0x1ed, simpleCb);
          });
      });
    });
    describe('atomic', function() {
      beforeEach(function() {
        options.atomic = true;
        options.ignoreInitial = true;
      });
      it('should ignore vim/emacs/Sublime swapfiles', function(done) {
        var spy = sinon.spy();
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              fs.writeFileSync(getFixturePath('.change.txt.swp'), 'a'); // vim
              fs.writeFileSync(getFixturePath('add.txt\~'), 'a'); // vim/emacs
              fs.writeFileSync(getFixturePath('.subl5f4.tmp'), 'a'); // sublime
              d(function() {
                fs.writeFileSync(getFixturePath('.change.txt.swp'), 'c');
                fs.writeFileSync(getFixturePath('add.txt\~'), 'c');
                fs.writeFileSync(getFixturePath('.subl5f4.tmp'), 'c');
                d(function() {
                  fs.unlinkSync(getFixturePath('.change.txt.swp'));
                  fs.unlinkSync(getFixturePath('add.txt\~'));
                  fs.unlinkSync(getFixturePath('.subl5f4.tmp'));
                  d(function() {
                    spy.should.not.have.been.called;
                    done();
                  }, true)();
                }, true)();
              }, true)();
            });
        })();
      });
      it('should ignore stale tilde files', function(done) {
        options.ignoreInitial = false;
        fs.writeFileSync(getFixturePath('old.txt~'), 'a');
        var spy = sinon.spy();
        d(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              fs.unlinkSync(getFixturePath('old.txt~'));
              spy.should.not.have.been.calledWith(getFixturePath('old.txt'));
              spy.should.not.have.been.calledWith(getFixturePath('old.txt~'));
              done();
            });
        })();
      });
    });
    describe('cwd', function() {
      it('should emit relative paths based on cwd', function(done) {
        var spy = sinon.spy();
        options.cwd = fixturesPath;
        watcher = chokidar.watch('**', options)
          .on('all', spy)
          .on('ready', d(function() {
            fs.writeFileSync(getFixturePath('change.txt'), 'c');
            fs.unlinkSync(getFixturePath('unlink.txt'));
            waitFor([spy.withArgs('unlink')], function() {
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.have.been.calledWith('add', 'unlink.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              spy.should.have.been.calledWith('unlink', 'unlink.txt');
              done();
            });
          }));
      });
      it('should allow separate watchers to have different cwds', function(done) {
        var spy1 = sinon.spy();
        var spy2 = sinon.spy();
        options.cwd = fixturesPath;
        var options2 = {};
        Object.keys(options).forEach(function(key) { options2[key] = options[key] });
        options2.cwd = getFixturePath('subdir');
        watcher = chokidar.watch(getFixturePath('**'), options)
          .on('all', spy1)
          .on('ready', d(function() {
            watcher2 = chokidar.watch(fixturesPath, options2)
              .on('all', spy2)
              .on('ready', d(function() {
                fs.writeFileSync(getFixturePath('change.txt'), 'c');
                fs.unlinkSync(getFixturePath('unlink.txt'));
                waitFor([spy1.withArgs('unlink'), spy2.withArgs('unlink')], function() {
                  spy1.should.have.been.calledWith('change', 'change.txt');
                  spy1.should.have.been.calledWith('unlink', 'unlink.txt');
                  spy2.should.have.been.calledWith('add', sysPath.join('..', 'change.txt'));
                  spy2.should.have.been.calledWith('add', sysPath.join('..', 'unlink.txt'));
                  spy2.should.have.been.calledWith('change', sysPath.join('..', 'change.txt'));
                  spy2.should.have.been.calledWith('unlink', sysPath.join('..', 'unlink.txt'));
                  done();
                });
              }));
          }, true));
      });
      it('should ignore files even with cwd', function(done) {
        fs.writeFileSync(getFixturePath('change.txt'), 'hello');
        fs.writeFileSync(getFixturePath('ignored.txt'), 'ignored');
        fs.writeFileSync(getFixturePath('ignored-option.txt'), 'ignored option');
        var spy = sinon.spy();
        options.cwd = fixturesPath;
        var files = [
          '*.txt',
          '!ignored.txt'
        ];
        options.ignored = 'ignored-option.txt';
        watcher = chokidar.watch(files, options)
          .on('all', spy)
          .on('ready', d(function() {
            fs.writeFileSync(getFixturePath('ignored.txt'), 'ignored');
            fs.writeFileSync(getFixturePath('ignored-option.txt'), 'ignored option');
            fs.unlinkSync(getFixturePath('ignored.txt'));
            fs.unlinkSync(getFixturePath('ignored-option.txt'));
            fs.writeFileSync(getFixturePath('change.txt'), 'change');
            waitFor([spy.withArgs('change', 'change.txt')], function() {
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.not.have.been.calledWith('add', 'ignored.txt');
              spy.should.not.have.been.calledWith('add', 'ignored-option.txt');
              spy.should.not.have.been.calledWith('unlink', 'ignored.txt');
              spy.should.not.have.been.calledWith('unlink', 'ignored-option.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              done();
            });
          }), true);
      });
    });
    describe('ignorePermissionErrors', function() {
      var filePath;
      beforeEach(function() {
        filePath = getFixturePath('add.txt');
        fs.writeFileSync(filePath, 'b', {mode: 128});
      });
      describe('false', function() {
        beforeEach(function() { options.ignorePermissionErrors = false; });
        it('should not watch files without read permissions', function(done) {
          if (os === 'win32') return done();
          var spy = sinon.spy();
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              spy.should.not.have.been.calledWith('add', filePath);
              fs.writeFileSync(filePath, 'a');
              dd(function() {
                spy.should.not.have.been.calledWith('change', filePath);
                done();
              })();
            });
        });
      });
      describe('true', function() {
        beforeEach(function() { options.ignorePermissionErrors = true; });
        it('should watch unreadable files if possible', function(done) {
          var spy = sinon.spy();
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              spy.should.have.been.calledWith('add', filePath);
              if (!options.useFsEvents) return done();
              fs.writeFileSync(filePath, 'a');
              dd(function() {
                spy.should.have.been.calledWith('change', filePath);
                done();
              })();
            });
        });
        it('should not choke on non-existent files', function(done) {
          chokidar.watch(getFixturePath('nope.txt'), options).on('ready', done);
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
      it('should not emit add event before a file is fully written', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', simpleCb);
            w(function() {
              spy.should.not.have.been.calledWith('add');
              done();
            }, 200)();
          });
      });
      it('should wait for the file to be fully written before emitting the add event', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', w(function() {
              spy.should.not.have.been.called;
            }, 300));
            waitFor([spy], function() {
              spy.should.have.been.calledWith('add', testPath);
              done();
            });
          });
      });
      it('should not emit change event while a file has not been fully written', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', simpleCb);
            w(function() {
              fs.writeFile(testPath, 'edit', simpleCb);
              w(function() {
                spy.should.not.have.been.calledWith('change', testPath);
                done();
              }, 200)();
            }, 100)();
          });
      });
      it('should not emit change event before an existing file is fully updated', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('change.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', simpleCb);
            w(function() {
              spy.should.not.have.been.calledWith('change', testPath);
              done();
            }, 300)();
          });
      });
      it('should wait for an existing file to be fully updated before emitting the change event', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('change.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', w(function() {
              spy.should.not.have.been.called;
            }, 300));
            waitFor([spy], function() {
              spy.should.have.been.calledWith('change', testPath);
              done();
            });
          });
      });
      it('should emit change event after the file is fully written', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            waitFor([spy], function() {
              spy.should.have.been.calledWith('add', testPath);
              waitFor([spy.withArgs('change')], function() {
                spy.should.have.been.calledWith('change', testPath);
                done();
              });
              fs.writeFile(testPath, 'edit', simpleCb);
            });
            w(fs.writeFile.bind(fs, testPath, 'hello', simpleCb))();
          });
      });
      it('should not raise any event for a file that was deleted before fully written', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello', simpleCb);
            w(function() {
              fs.unlink(testPath, simpleCb);
              w(function() {
                spy.should.not.have.been.calledWith(sinon.match.string, testPath);
                done();
              }, 400)();
            }, 400)();
          });
      });
      it('should be compatible with the cwd option', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('subdir/add.txt');
        var filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        fs.mkdir(options.cwd, w(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              waitFor([spy.withArgs('add')], function() {
                spy.should.have.been.calledWith('add', filename);
                done();
              });
              w(fs.writeFile.bind(fs, testPath, 'hello', simpleCb), 400)();
            });
        }, 200));
      });
      it('should still emit initial add events', function(done) {
        options.ignoreInitial = false;
        var spy = sinon.spy();
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            spy.should.have.been.calledWith('add');
            spy.should.have.been.calledWith('addDir');
            done();
          });
      });
    });
  });
  describe('unwatch', function() {
    before(closeWatchers);
    beforeEach(function(done) {
      options.ignoreInitial = true;
      fs.mkdir(getFixturePath('subdir'), 0x1ed, done);
    });
    it('should stop watching unwatched paths', function(done) {
      var spy = sinon.spy();
      var watchPaths = [getFixturePath('subdir'), getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', function() {
          watcher.unwatch(getFixturePath('subdir'));
          waitFor([spy], function() {
            spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
            spy.should.not.have.been.calledWith('add');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          });
          w(function() {
            fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
            fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
          })();
        });
    });
    it('should ignore unwatched paths that are a subset of watched paths', function(done) {
      var spy = sinon.spy();
      watcher = chokidar.watch(fixturesPath, options)
        .on('all', spy)
        .on('ready', d(function() {
          // test with both relative and absolute paths
          var subdirRel = sysPath.relative(process.cwd(), getFixturePath('subdir'));
          watcher.unwatch([subdirRel, getFixturePath('unl*')]);
          dd(function() {
            fs.unlinkSync(getFixturePath('unlink.txt'));
            fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
            fs.writeFileSync(getFixturePath('change.txt'), 'c');
            waitFor([spy.withArgs('change')], function() {
              spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
              spy.should.not.have.been.calledWith('add', getFixturePath('subdir/add.txt'));
              spy.should.not.have.been.calledWith('unlink');
              if (!osXFsWatch) spy.should.have.been.calledOnce;
              done();
            });
          })();
        }, true));
    });
    it('should unwatch relative paths', function(done) {
      var spy = sinon.spy();
      var fixturesDir = sysPath.relative(process.cwd(), fixturesPath);
      var subdir = sysPath.join(fixturesDir, 'subdir');
      var changeFile = sysPath.join(fixturesDir, 'change.txt');
      var watchPaths = [subdir, changeFile];
      dd(function() {
        watcher = chokidar.watch(watchPaths, options)
          .on('all', spy)
          .on('ready', d(function() {
            watcher.unwatch(subdir);
            fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
            fs.writeFileSync(getFixturePath('change.txt'), 'c');
            waitFor([spy], function() {
              spy.should.have.been.calledWith('change', changeFile);
              spy.should.not.have.been.calledWith('add');
              if (!osXFsWatch) spy.should.have.been.calledOnce;
              done();
            });
          }));
      })();
    });
    it('should watch paths that were unwatched and added again', function(done) {
      var spy = sinon.spy();
      var watchPaths = [getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options)
        .on('ready', d(function() {
          watcher.unwatch(getFixturePath('change.txt'));
          dd(function() {
            watcher.on('all', spy).add(getFixturePath('change.txt'));
            dd(function() {
              fs.writeFileSync(getFixturePath('change.txt'), 'c');
              waitFor([spy], function() {
                spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
                spy.should.have.been.calledOnce;
                done();
              });
            })();
          })();
        }));
    });
  });
  describe('close', function() {
    it('should ignore further events on close', function(done) {
      var spy = sinon.spy();
      watcher = chokidar.watch(fixturesPath, options).once('add', function() {
        watcher.once('add', function() {
          watcher.on('add', spy).close();
          fs.writeFileSync(getFixturePath('add.txt'), 'hello world');
          dd(function() {
            spy.should.not.have.been.called;
            done();
          })();
        });
      });
      fs.writeFileSync(getFixturePath('add.txt'), 'hello world');
      fs.unlinkSync(getFixturePath('add.txt'));
    });
  });
}
