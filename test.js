'use strict';

var chokidar = require('./');
var chai = require('chai');
var expect = chai.expect;
var should = chai.should();
var sinon = require('sinon');
var rimraf = require('rimraf');
var fs = require('graceful-fs');
var sysPath = require('path');
var upath = require("upath");
var cp = require('child_process');
chai.use(require('sinon-chai'));
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
    node010 = process.version.slice(0, 5) === 'v0.10',
    osXFsWatch,
    osXFsWatch010,
    win32Polling,
    win32Polling010,
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

function closeWatchers(done) {
  var u;
  while (u = usedWatchers.pop()) u.close();
  if (done) {
    process.env.TRAVIS && os === 'darwin' ? setTimeout(done, 500) : done();
  }
}
function disposeWatcher(watcher) {
  if (!watcher || !watcher.close) return;
  os === 'darwin' ? usedWatchers.push(watcher) : watcher.close();
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

  if (os === 'darwin') {
    describe('fsevents (native extension)', runTests.bind(this, {useFsEvents: true}));
  }
  if (os !== 'darwin' || !node010) {
    describe('fs.watch (non-polling)', runTests.bind(this, {usePolling: false, useFsEvents: false}));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, {usePolling: true, interval: 10}));
});

function simpleCb(err) { if (err) throw err; }
function w(fn, to) {
  return setTimeout.bind(null, fn, to || slowerDelay || 50);
}

function runTests(baseopts) {
  baseopts.persistent = true;

  before(function() {
    // flags for bypassing special-case test failures on CI
    osXFsWatch = os === 'darwin' && !baseopts.usePolling && !baseopts.useFsEvents;
    osXFsWatch010 = osXFsWatch && node010;
    win32Polling = os === 'win32' && baseopts.usePolling;
    win32Polling010 = win32Polling && node010;

    if (win32Polling010) {
      slowerDelay = 900;
    } else if (node010 || osXFsWatch) {
      slowerDelay = 200;
    } else {
      slowerDelay = undefined;
    }
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
    var to = setTimeout(finish, 3500);
  }

  describe('watch a directory', function() {
    var readySpy, rawSpy;
    beforeEach(function() {
      options.ignoreInitial = true;
      options.alwaysStat = true;
      readySpy = sinon.spy(function readySpy(){});
      rawSpy = sinon.spy(function rawSpy(){});
      stdWatcher().on('ready', readySpy).on('raw', rawSpy);
    });
    afterEach(function(done) {
      waitFor([readySpy], function() {
        readySpy.should.have.been.calledOnce;
        rawSpy = undefined;
        closeWatchers(done);
      });
    });
    it('should produce an instance of chokidar.FSWatcher', function() {
      watcher.should.be.an['instanceof'](chokidar.FSWatcher);
    });
    it('should expose public API methods', function() {
      watcher.on.should.be.a('function');
      watcher.emit.should.be.a('function');
      watcher.add.should.be.a('function');
      watcher.close.should.be.a('function');
      watcher.getWatched.should.be.a('function');
    });
    it('should emit `add` event when file was added', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      watcher.on('add', spy).on('ready', w(function() {
        fs.writeFile(testPath, Date.now(), simpleCb);
        waitFor([spy], function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      }));
    });
    it('should emit `addDir` event when directory was added', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      watcher.on('addDir', spy).on('ready', w(function() {
        spy.should.not.have.been.called;
        fs.mkdir(testDir, 0x1ed, simpleCb);
        waitFor([spy], function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testDir);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      }));
    });
    it('should emit `change` event when file was changed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      watcher.on('change', spy).on('ready', function() {
        spy.should.not.have.been.called;
        fs.writeFile(testPath, Date.now(), simpleCb);
        waitFor([spy], function() {
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          if (!osXFsWatch010) spy.should.have.been.calledOnce;
          done();
        });
      });
    });
    it('should emit `unlink` event when file was removed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      watcher.on('unlink', spy).on('ready', function() {
        spy.should.not.have.been.called;
        fs.unlink(testPath, simpleCb);
        waitFor([spy], function() {
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.not.be.ok; // no stats
          rawSpy.should.have.been.called;
          if (!osXFsWatch010) spy.should.have.been.calledOnce;
          done();
        });
      });
    });
    it('should emit `unlinkDir` event when a directory was removed', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir, 0x1ed);
      watcher.on('unlinkDir', spy).on('ready', function() {
        w(fs.rmdir.bind(fs, testDir, simpleCb))();
        waitFor([spy], function() {
          spy.should.have.been.calledWith(testDir);
          expect(spy.args[0][1]).to.not.be.ok; // no stats
          rawSpy.should.have.been.called;
          if (!osXFsWatch010) spy.should.have.been.calledOnce;
          done();
        });
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
          w(fs.rename.bind(fs, testPath, newPath, simpleCb))();
          waitFor([unlinkSpy, addSpy], function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            expect(unlinkSpy.args[0][1]).to.not.be.ok; // no stats
            addSpy.should.have.been.calledOnce;
            addSpy.should.have.been.calledWith(newPath);
            expect(addSpy.args[0][1]).to.be.ok; // stats
            rawSpy.should.have.been.called;
            if (!osXFsWatch) unlinkSpy.should.have.been.calledOnce;
            done();
          });
        });
    });
    it('should emit `add`, not `change`, when previously deleted file is re-added', function(done) {
      if (win32Polling010) return done();
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
          fs.unlink(testPath, simpleCb);
          waitFor([unlinkSpy.withArgs(testPath)], function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            w(fs.writeFile.bind(fs, testPath, Date.now(), simpleCb))();
            waitFor([addSpy.withArgs(testPath)], function() {
              addSpy.should.have.been.calledWith(testPath);
              changeSpy.should.not.have.been.called;
              done();
            });
          });
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
          fs.rename(testPath, newPath1, w(function() {
            fs.rename(newPath1, newPath2, simpleCb);
          }, 300));
          waitFor([unlinkSpy.withArgs(newPath1)], function() {
            unlinkSpy.withArgs(testPath).should.have.been.calledOnce;
            unlinkSpy.withArgs(newPath1).should.have.been.calledOnce;
            unlinkSpy.withArgs(newPath2).should.not.have.been.called;
            done();
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
        fs.mkdir(testDir, 0x1ed, function() {
          fs.writeFile(testPath, Date.now(), simpleCb);
        });
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
      if (win32Polling010) return done();
      var unlinkSpy = sinon.spy(function unlinkSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      var parentPath = getFixturePath('subdir2');
      var subPath = getFixturePath('subdir2/subsub');
      watcher
        .on('unlinkDir', unlinkSpy)
        .on('addDir', addSpy)
        .on('ready', function() {
          fs.mkdir(parentPath, 0x1ed, w(function() {
            fs.rmdir(parentPath, simpleCb);
          }, win32Polling ? 900 : 300));
          waitFor([unlinkSpy.withArgs(parentPath)], function() {
            unlinkSpy.should.have.been.calledWith(parentPath);
            fs.mkdir(parentPath, 0x1ed, w(function() {
              fs.mkdir(subPath, 0x1ed, simpleCb);
            }, win32Polling ? 2200 : 1200));
            waitFor([[addSpy, 3]], function() {
              addSpy.should.have.been.calledWith(parentPath);
              addSpy.should.have.been.calledWith(subPath);
              done();
            });
          });
        });
    });
  });
  describe('watch individual files', function() {
    before(closeWatchers);
    it('should detect changes', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options)
        .on('change', spy)
        .on('ready', function() {
          fs.writeFile(testPath, Date.now(), simpleCb);
          waitFor([spy], function() {
            spy.should.have.always.been.calledWith(testPath);
            done();
          });
        });
    });
    it('should detect unlinks', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      watcher = chokidar.watch(testPath, options)
        .on('unlink', spy)
        .on('ready', function() {
          w(fs.unlink.bind(fs, testPath, simpleCb))();
          waitFor([spy], function() {
            spy.should.have.been.calledWith(testPath);
            done();
          });
        });
    });
    it('should detect unlink and re-add', function(done) {
      options.ignoreInitial = true;
      var unlinkSpy = sinon.spy(function unlinkSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      var testPath = getFixturePath('unlink.txt');
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
          fs.writeFile(siblingPath, Date.now(), simpleCb);
          fs.writeFile(testPath, Date.now(), simpleCb);
          waitFor([spy], function() {
            spy.should.have.always.been.calledWith('add', testPath);
            done();
          });
        }));
    });
  });
  describe('renamed directory', function() {
    it('should emit `add` for a file in a renamed directory', function(done) {
      options.ignoreInitial = true;
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      var testPath = getFixturePath('subdir/add.txt');
      var renamedDir = getFixturePath('subdir-renamed');
      var expectedPath = sysPath.join(renamedDir, 'add.txt')
      fs.mkdir(testDir, 0x1ed, function() {
        fs.writeFile(testPath, Date.now(), function() {
          watcher = chokidar.watch(fixturesPath, options)
            .on('add', spy)
            .on('ready', function() {
              w(function() {
                fs.rename(testDir, renamedDir, simpleCb);
              }, 1000)();
              waitFor([spy], function() {
                spy.should.have.been.calledOnce;
                spy.should.have.been.calledWith(expectedPath);
                done();
              });
            });
        });
      });
    });
  });
  describe('watch non-existent paths', function() {
    it('should watch non-existent file and detect add', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      watcher = chokidar.watch(testPath, options)
        .on('add', spy)
        .on('ready', function() {
          w(fs.writeFile.bind(fs, testPath, Date.now(), simpleCb))();
          waitFor([spy], function() {
            spy.should.have.been.calledWith(testPath);
            done();
          });
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
          w(function() {
            fs.mkdir(testDir, 0x1ed, w(function() {
              fs.writeFile(testPath, 'hello', simpleCb);
            }, win32Polling010 ? 900 : undefined));
          }, win32Polling010 ? 900 : undefined)();
          waitFor([spy.withArgs('add')], function() {
            spy.should.have.been.calledWith('addDir', testDir);
            spy.should.have.been.calledWith('add', testPath);
            done();
          });
        });
    });
  });
  describe('watch glob patterns', function() {
    before(closeWatchers);
    it('should correctly watch and emit based on glob input', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('*a*.txt');
      var addPath = getFixturePath('add.txt');
      var changePath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', changePath);
          w(function() {
            fs.writeFile(addPath, Date.now(), simpleCb);
            fs.writeFile(changePath, Date.now(), simpleCb);
          })();
          waitFor([[spy, 3], spy.withArgs('add', addPath)], function() {
            spy.should.have.been.calledWith('add', addPath);
            spy.should.have.been.calledWith('change', changePath);
            spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
            spy.should.not.have.been.calledWith('addDir');
            done();
          });
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
          w(fs.unlink.bind(fs, unlinkPath, simpleCb))();
          waitFor([[spy, 2], spy.withArgs('unlink')], function() {
            if (!osXFsWatch010) spy.should.have.been.calledTwice;
            spy.should.have.been.calledWith('unlink', unlinkPath);
            done();
          });
        });
    });
    it('should traverse subdirs to match globstar patterns', function(done) {
      var spy = sinon.spy();
      var watchPath = getFixturePath('../../test-*/' + subdir + '/**/a*.txt');
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      fs.writeFileSync(getFixturePath('subdir/a.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/b.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/subsub/ab.txt'), 'b');
      w(function() {
        watcher = chokidar.watch(watchPath, options)
          .on('all', spy)
          .on('ready', function() {
            w(function() {
              fs.writeFile(getFixturePath('add.txt'), Date.now(), simpleCb);
              fs.writeFile(getFixturePath('subdir/subsub/ab.txt'), Date.now(), simpleCb);
              fs.unlink(getFixturePath('subdir/a.txt'), simpleCb);
              fs.unlink(getFixturePath('subdir/b.txt'), simpleCb);
            })();
            waitFor([[spy.withArgs('add'), 3], spy.withArgs('unlink'), spy.withArgs('change')], function() {
              spy.withArgs('add').should.have.been.calledThrice;
              spy.should.have.been.calledWith('unlink', getFixturePath('subdir/a.txt'));
              spy.should.have.been.calledWith('change', getFixturePath('subdir/subsub/ab.txt'));
              if (!node010) {
                spy.withArgs('unlink').should.have.been.calledOnce;
                spy.withArgs('change').should.have.been.calledOnce;
              }
              done();
            });
          });
      }, win32Polling010 ? 300 : undefined)();
    });
    it('should resolve relative paths with glob patterns', function(done) {
      var spy = sinon.spy();
      var testPath = 'test-*/' + subdir + '/*a*.txt';
      // getFixturePath() returns absolute paths, so use sysPath.join() instead
      var addPath = sysPath.join('test-fixtures', subdir.toString(), 'add.txt');
      var changePath = sysPath.join('test-fixtures', subdir.toString(), 'change.txt');
      var unlinkPath = sysPath.join('test-fixtures', subdir.toString(), 'unlink.txt');
      watcher = chokidar.watch(testPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', changePath);
          w(function() {
            fs.writeFile(addPath, Date.now(), simpleCb);
            fs.writeFile(changePath, Date.now(), simpleCb);
          })();
          waitFor([[spy, 3], spy.withArgs('add', addPath)], function() {
            spy.should.have.been.calledWith('add', addPath);
            spy.should.have.been.calledWith('change', changePath);
            spy.should.not.have.been.calledWith('add', unlinkPath);
            spy.should.not.have.been.calledWith('addDir');
            if (!osXFsWatch) spy.should.have.been.calledThrice;
            done();
          });
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
          w(function() {
            fs.writeFile(addPath, Date.now(), simpleCb);
            fs.writeFile(changePath, Date.now(), simpleCb);
            fs.unlink(unlinkPath, simpleCb);
          })();
          waitFor([[spy, 4], spy.withArgs('unlink', unlinkPath)], function() {
            spy.should.have.been.calledWith('change', changePath);
            spy.should.have.been.calledWith('unlink', unlinkPath);
            spy.should.not.have.been.calledWith('add', addPath);
            if (!osXFsWatch010) spy.callCount.should.equal(4);
            done();
          });
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
          if (!osXFsWatch010) spy.should.have.been.calledOnce;
          w(fs.writeFile.bind(fs, changePath, Date.now(), simpleCb))();
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('change', changePath);
            if (!osXFsWatch010) spy.should.have.been.calledTwice;
            done();
          });
        });
    });
    it('should not confuse glob-like filenames with globs', function(done) {
      var spy = sinon.spy();
      var filePath = getFixturePath('nota[glob].txt');
      fs.writeFile(filePath, 'b', w(function() {
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            spy.should.have.been.calledWith('add', filePath);
            w(fs.writeFile.bind(fs, filePath, Date.now(), simpleCb))();
            waitFor([spy.withArgs('change', filePath)], function() {
              spy.should.have.been.calledWith('change', filePath);
              done();
            });
          });
      }));
    });
    it('should treat glob-like directory names as literal directory names when globbing is disabled', function(done) {
      options.disableGlobbing = true;
      var spy = sinon.spy();
      var filePath = getFixturePath('nota[glob]/a.txt');
      var watchPath = getFixturePath('nota[glob]');
      var matchingDir = getFixturePath('notag');
      var matchingFile = getFixturePath('notag/b.txt');
      var matchingFile2 = getFixturePath('notal');
      fs.mkdirSync(watchPath, 0x1ed);
      fs.writeFileSync(filePath, 'b');
      fs.mkdirSync(matchingDir, 0x1ed);
      fs.writeFileSync(matchingFile, 'c');
      fs.writeFileSync(matchingFile2, 'd');
      watcher = chokidar.watch(watchPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', filePath);
          spy.should.not.have.been.calledWith('addDir', matchingDir);
          spy.should.not.have.been.calledWith('add', matchingFile);
          spy.should.not.have.been.calledWith('add', matchingFile2);
          w(fs.writeFile.bind(fs, filePath, Date.now(), simpleCb))();
          waitFor([spy.withArgs('change', filePath)], function() {
            spy.should.have.been.calledWith('change', filePath);
            done();
          });
        });
    });
    it('should treat glob-like filenames as literal filenames when globbing is disabled', function(done) {
      options.disableGlobbing = true;
      var spy = sinon.spy();
      var filePath = getFixturePath('nota[glob]');
      var watchPath = getFixturePath('nota[glob]');
      var matchingDir = getFixturePath('notag');
      var matchingFile = getFixturePath('notag/a.txt');
      var matchingFile2 = getFixturePath('notal');
      fs.writeFileSync(filePath, 'b');
      fs.mkdirSync(matchingDir, 0x1ed);
      fs.writeFileSync(matchingFile, 'c');
      fs.writeFileSync(matchingFile2, 'd');
      watcher = chokidar.watch(watchPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', filePath);
          spy.should.not.have.been.calledWith('addDir', matchingDir);
          spy.should.not.have.been.calledWith('add', matchingFile);
          spy.should.not.have.been.calledWith('add', matchingFile2);
          w(fs.writeFile.bind(fs, filePath, Date.now(), simpleCb))();
          waitFor([spy.withArgs('change', filePath)], function() {
            spy.should.have.been.calledWith('change', filePath);
            done();
          });
        });
    });
    it('should not prematurely filter dirs against complex globstar patterns', function(done) {
      var spy = sinon.spy();
      var deepFile = getFixturePath('subdir/subsub/subsubsub/a.txt');
      var watchPath = getFixturePath('../../test-*/' + subdir + '/**/subsubsub/*.txt');
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), 0x1ed);
      fs.writeFileSync(deepFile, 'b');
      watcher = chokidar.watch(watchPath, options)
        .on('all', spy)
        .on('ready', function() {
          w(fs.writeFile.bind(fs, deepFile, Date.now(), simpleCb))();
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('add', deepFile);
            spy.should.have.been.calledWith('change', deepFile);
            done();
          });
        });
    });
    it('should emit matching dir events', function(done) {
      var spy = sinon.spy();
      // test with and without globstar matches
      var watchPaths = [getFixturePath('*'), getFixturePath('subdir/subsub/**/*')];
      var deepDir = getFixturePath('subdir/subsub/subsubsub');
      var deepFile = sysPath.join(deepDir, 'a.txt');
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
          spy.withArgs('addDir').should.have.been.calledOnce;
          fs.mkdirSync(deepDir, 0x1ed);
          fs.writeFileSync(deepFile, Date.now());
          waitFor([[spy.withArgs('addDir'), 2], spy.withArgs('add', deepFile)], function() {
            if (win32Polling) return done();
            spy.should.have.been.calledWith('addDir', deepDir);
            fs.unlinkSync(deepFile);
            fs.rmdirSync(deepDir);
            waitFor([spy.withArgs('unlinkDir')], function() {
              spy.should.have.been.calledWith('unlinkDir', deepDir);
              done();
            });
          });
        });
    });
    it('should correctly handle glob with braces', function(done) {
      var spy = sinon.spy();
      var watchPath = upath.normalizeSafe(getFixturePath('{subdir/*,subdir1/subsub1}/subsubsub/*.txt'));
      var deepFileA = getFixturePath('subdir/subsub/subsubsub/a.txt');
      var deepFileB = getFixturePath('subdir1/subsub1/subsubsub/a.txt');
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir1'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir1/subsub1'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir1/subsub1/subsubsub'), 0x1ed);
      fs.writeFileSync(deepFileA, Date.now());
      fs.writeFileSync(deepFileB, Date.now());
      watcher = chokidar.watch(watchPath, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', deepFileA);
          spy.should.have.been.calledWith('add', deepFileB);
          fs.appendFileSync(deepFileA, Date.now());
          fs.appendFileSync(deepFileB, Date.now());
          waitFor([[spy, 4]], function() {
            spy.should.have.been.calledWith('change', deepFileA);
            spy.should.have.been.calledWith('change', deepFileB);
            done();
          });
        });
    });
  });
  describe('watch symlinks', function() {
    if (os === 'win32') return;
    before(closeWatchers);
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
          fs.writeFile(changePath, Date.now(), simpleCb);
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
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
          fs.writeFile(changePath, Date.now(), simpleCb);
          waitFor([spy.withArgs('change', linkPath)], function() {
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
        });
    });
    it('should watch paths with a symlinked parent', function(done) {
      var spy = sinon.spy();
      var testDir = sysPath.join(linkedDir, 'subdir');
      var testFile = sysPath.join(testDir, 'add.txt');
      watcher = chokidar.watch(testDir, options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('addDir', testDir);
          spy.should.have.been.calledWith('add', testFile);
          fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('change', testFile);
            done();
          });
        });
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
          fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
          waitFor([spy.withArgs(linkedFilePath)], function() {
            spy.should.have.been.calledWith(linkedFilePath);
            done();
          });
        });
    });
    it('should follow newly created symlinks', function(done) {
      options.ignoreInitial = true;
      var spy = sinon.spy();
      stdWatcher()
        .on('all', spy)
        .on('ready', function() {
          w(fs.symlink.bind(fs, getFixturePath('subdir'), getFixturePath('link'), simpleCb))();
          waitFor([
            spy.withArgs('add', getFixturePath('link/add.txt')),
            spy.withArgs('addDir', getFixturePath('link'))
          ], function() {
            spy.should.have.been.calledWith('addDir', getFixturePath('link'));
            spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
            done();
          });
        });
    });
    it('should watch symlinks as files when followSymlinks:false', function(done) {
      options.followSymlinks = false;
      var spy = sinon.spy();
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
      options.followSymlinks = false;
      var spy = sinon.spy();
      var linkPath = getFixturePath('link');
      fs.symlinkSync(getFixturePath('subdir'), linkPath);
      stdWatcher()
        .on('all', spy)
        .on('ready', function() {
          w(function() {
            fs.writeFileSync(getFixturePath('subdir/add.txt'), Date.now());
            fs.unlinkSync(linkPath);
            fs.symlinkSync(getFixturePath('subdir/add.txt'), linkPath);
          }, options.usePolling ? 1200 : 300)();
          waitFor([spy.withArgs('change', linkPath)], function() {
            spy.should.not.have.been.calledWith('addDir', linkPath);
            spy.should.not.have.been.calledWith('add', getFixturePath('link/add.txt'));
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
        });
    });
    it('should not reuse watcher when following a symlink to elsewhere', function(done) {
      var spy = sinon.spy();
      var linkedPath = getFixturePath('outside');
      var linkedFilePath = sysPath.join(linkedPath, 'text.txt');
      var linkPath = getFixturePath('subdir/subsub');
      fs.mkdirSync(linkedPath, 0x1ed);
      fs.writeFileSync(linkedFilePath, 'b');
      fs.symlinkSync(linkedPath, linkPath);
      watcher2 = chokidar.watch(getFixturePath('subdir'), options)
        .on('ready', w(function() {
          var watchedPath = getFixturePath('subdir/subsub/text.txt');
          watcher = chokidar.watch(watchedPath, options)
            .on('all', spy)
            .on('ready', w(function() {
              fs.writeFile(linkedFilePath, Date.now(), simpleCb);
              waitFor([spy.withArgs('change')], function() {
                spy.should.have.been.calledWith('change', watchedPath);
                done();
              });
            }));
        }, options.usePolling ? 900 : undefined));
    });
    it('should properly match glob patterns that include a symlinked dir', function(done) {
      var dirSpy = sinon.spy(function dirSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      // test with relative path to ensure proper resolution
      var watchDir = sysPath.relative(process.cwd(), linkedDir);
      watcher = chokidar.watch(sysPath.join(watchDir, '**/*'), options)
        .on('addDir', dirSpy)
        .on('add', addSpy)
        .on('ready', function() {
          // only the children are matched by the glob pattern, not the link itself
          addSpy.should.have.been.calledWith(sysPath.join(watchDir, 'change.txt'));
          addSpy.should.have.been.calledThrice; // also unlink.txt & subdir/add.txt
          dirSpy.should.have.been.calledWith(sysPath.join(watchDir, 'subdir'));
          fs.writeFile(sysPath.join(watchDir, 'add.txt'), simpleCb);
          waitFor([[addSpy, 4]], function() {
            addSpy.should.have.been.calledWith(sysPath.join(watchDir, 'add.txt'));
            done();
          });
        });
    });
  });
  describe('watch arrays of paths/globs', function() {
    before(closeWatchers);
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
          fs.writeFile(testPath, Date.now(), simpleCb);
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('change', testPath);
            done();
          });
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
            fs.writeFile(testPath, Date.now(), simpleCb);
            waitFor([spy.withArgs('change')], function() {
              spy.should.have.been.calledWith('change', testPath);
              done();
            });
          });
      });
    });
    it('should throw if provided any non-string paths', function() {
      expect(chokidar.watch.bind(null, [[fixturesPath], /notastring/]))
        .to.throw(TypeError, /non-string/i);
    });
  });
  describe('watch options', function() {
    before(closeWatchers);
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
                  spy.should.have.been.calledThrice;
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
              }, 1000)();
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
              fs.mkdir(testDir, 0x1ed, function() {
                fs.writeFile(testPath, Date.now(), simpleCb);
              });
              waitFor([spy], function() {
                spy.should.have.been.calledOnce;
                spy.should.have.been.calledWith(testPath);
                done();
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
              fs.writeFile(testPath, Date.now(), simpleCb);
              waitFor([spy.withArgs('change', testPath)], function() {
                spy.should.have.been.calledWith('change', testPath);
                spy.should.not.have.been.calledWith('add');
                done();
              });
            });
        });
        it('should not emit for preexisting dirs when depth is 0', function(done) {
          options.depth = 0
          var spy = sinon.spy();
          var testPath = getFixturePath('add.txt');
          fs.mkdir(getFixturePath('subdir'), 0x1ed, w(function() {
            stdWatcher()
              .on('all', spy)
              .on('ready', function() {
                fs.writeFile(testPath, Date.now(), simpleCb);
                waitFor([spy], w(function() {
                  spy.should.have.been.calledWith('add', testPath);
                  spy.should.not.have.been.calledWith('addDir');
                  done();
                }, win32Polling010 ? 1000 : 200));
              });
          }, win32Polling010 ? 1000 : 200));
        });
      });
    });
    describe('ignored', function() {
      it('should check ignore after stating', function(done) {
        options.ignored = function(path, stats) {
          if (upath.normalizeSafe(path) === upath.normalizeSafe(testDir) || !stats) return false;
          return stats.isDirectory();
        };
        var spy = sinon.spy();
        var testDir = getFixturePath('subdir');
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(sysPath.join(testDir, 'add.txt'), '');
        fs.mkdirSync(sysPath.join(testDir, 'subsub'), 0x1ed);
        fs.writeFileSync(sysPath.join(testDir, 'subsub', 'ab.txt'), '');
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
        options.ignored = testDir;
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(testFile, 'b');
        watcher = chokidar.watch(fixturesPath, options)
          .on('all', spy)
          .on('ready', w(function() {
            fs.writeFile(testFile, Date.now(), w(function() {
              spy.should.not.have.been.calledWith('addDir', testDir);
              spy.should.not.have.been.calledWith('add', testFile);
              spy.should.not.have.been.calledWith('change', testFile);
              done();
            }, 300));
          }));
      });
      it('should allow regex/fn ignores', function(done) {
        options.cwd = fixturesPath;
        options.ignored = /add/;
        var spy = sinon.spy();
        fs.writeFileSync(getFixturePath('add.txt'), 'b');
        watcher = chokidar.watch(fixturesPath, options)
          .on('all', spy)
          .on('ready', function() {
            w(function() {
              fs.writeFile(getFixturePath('add.txt'), Date.now(), simpleCb);
              fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
            })();
            waitFor([spy.withArgs('change', 'change.txt')], function() {
              spy.should.not.have.been.calledWith('add', 'add.txt');
              spy.should.not.have.been.calledWith('change', 'add.txt');
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              done();
            });
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
            fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
            waitFor([[spy, 4]], function() {
              spy.should.have.been.calledWith('addDir', fixturesPath);
              spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
              spy.should.have.been.calledWith('add', getFixturePath('change.txt'));
              spy.should.have.been.calledWith('add', getFixturePath('unlink.txt'));
              spy.should.not.have.been.calledWith('change');
              if (!osXFsWatch) spy.callCount.should.equal(4);
              done();
            });
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
            w(function() {
              fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
              fs.writeFile(addPath, Date.now(), simpleCb);
              fs.writeFile(ignoredPath, Date.now(), simpleCb);
            })();
            waitFor([spy.withArgs('change', addPath), spy.withArgs('change', changePath)], function() {
              spy.should.have.been.calledWith('addDir', getFixturePath('subdir/subsub'));
              spy.should.have.been.calledWith('change', changePath);
              spy.should.have.been.calledWith('change', addPath);
              spy.should.not.have.been.calledWith('add', ignoredPath);
              spy.should.not.have.been.calledWith('change', ignoredPath);
              if (!osXFsWatch) spy.callCount.should.equal(8);
              done();
            });
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
            fs.symlink(getFixturePath('subdir'), linkPath, simpleCb);
            waitFor([[spy, 3], spy.withArgs('addDir', dirPath)], function() {
              spy.should.have.been.calledWith('addDir', linkPath);
              spy.should.have.been.calledWith('addDir', dirPath);
              spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
              if (!osXFsWatch010) spy.should.have.been.calledThrice;
              done();
            });
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
            fs.mkdir(subdir2, 0x1ed, simpleCb);
            waitFor([[addSpy, 3]], function() {
              addSpy.should.have.been.calledThrice;
              if (win32Polling010) return done();
              fs.rmdir(subdir2, simpleCb);
              waitFor([unlinkSpy], w(function() {
                unlinkSpy.should.have.been.calledWith('unlinkDir', subdir2);
                unlinkSpy.should.have.been.calledOnce;
                done();
              }));
            });
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
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(getFixturePath('.change.txt.swp'), 'a', simpleCb); // vim
            fs.writeFile(getFixturePath('add.txt\~'), 'a', simpleCb); // vim/emacs
            fs.writeFile(getFixturePath('.subl5f4.tmp'), 'a', simpleCb); // sublime
            w(function() {
              fs.writeFile(getFixturePath('.change.txt.swp'), 'c', simpleCb);
              fs.writeFile(getFixturePath('add.txt\~'), 'c', simpleCb);
              fs.writeFile(getFixturePath('.subl5f4.tmp'), 'c', simpleCb);
              w(function() {
                fs.unlink(getFixturePath('.change.txt.swp'), simpleCb);
                fs.unlink(getFixturePath('add.txt\~'), simpleCb);
                fs.unlink(getFixturePath('.subl5f4.tmp'), simpleCb);
                w(function() {
                  spy.should.not.have.been.called;
                  done();
                }, 300)();
              }, 300)();
            }, 300)();
          });
      });
      it('should ignore stale tilde files', function(done) {
        options.ignoreInitial = false;
        var spy = sinon.spy();
        fs.writeFile(getFixturePath('old.txt~'), 'a', w(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              spy.should.not.have.been.calledWith(getFixturePath('old.txt'));
              spy.should.not.have.been.calledWith(getFixturePath('old.txt~'));
              done();
            });
        }));
      });
    });
    describe('cwd', function() {
      it('should emit relative paths based on cwd', function(done) {
        options.cwd = fixturesPath;
        var spy = sinon.spy();
        watcher = chokidar.watch('**', options)
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(getFixturePath('change.txt'), Date.now(), function() {
              fs.unlink(getFixturePath('unlink.txt'), simpleCb);
            });
            waitFor([spy.withArgs('unlink')], function() {
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.have.been.calledWith('add', 'unlink.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              spy.should.have.been.calledWith('unlink', 'unlink.txt');
              done();
            });
          });
      });
      it('should emit `addDir` with alwaysStat for renamed directory', function(done) {
        options.cwd = fixturesPath;
        options.alwaysStat = true;
        options.ignoreInitial = true;
        var spy = sinon.spy();
        var testDir = getFixturePath('subdir');
        var renamedDir = getFixturePath('subdir-renamed');
        fs.mkdir(testDir, 0x1ed, function() {
          watcher = chokidar.watch('.', options)
            .on('ready', function() {
              w(function() {
                watcher.on('addDir', spy)
                fs.rename(testDir, renamedDir, simpleCb);
              }, 1000)();
              waitFor([spy], function() {
                spy.should.have.been.calledOnce;
                spy.should.have.been.calledWith('subdir-renamed');
                expect(spy.args[0][1]).to.be.ok; // stats
                done();
              });
            });
        });
      });
      it('should allow separate watchers to have different cwds', function(done) {
        options.cwd = fixturesPath;
        var spy1 = sinon.spy();
        var spy2 = sinon.spy();
        var options2 = {};
        Object.keys(options).forEach(function(key) { options2[key] = options[key] });
        options2.cwd = getFixturePath('subdir');
        watcher = chokidar.watch(getFixturePath('**'), options)
          .on('all', spy1)
          .on('ready', w(function() {
            watcher2 = chokidar.watch(fixturesPath, options2)
              .on('all', spy2)
              .on('ready', function() {
                fs.writeFile(getFixturePath('change.txt'), Date.now(), function() {
                  fs.unlink(getFixturePath('unlink.txt'), simpleCb);
                });
                waitFor([spy1.withArgs('unlink'), spy2.withArgs('unlink')], function() {
                  spy1.should.have.been.calledWith('change', 'change.txt');
                  spy1.should.have.been.calledWith('unlink', 'unlink.txt');
                  spy2.should.have.been.calledWith('add', sysPath.join('..', 'change.txt'));
                  spy2.should.have.been.calledWith('add', sysPath.join('..', 'unlink.txt'));
                  spy2.should.have.been.calledWith('change', sysPath.join('..', 'change.txt'));
                  spy2.should.have.been.calledWith('unlink', sysPath.join('..', 'unlink.txt'));
                  done();
                });
              });
          }));
      });
      it('should ignore files even with cwd', function(done) {
        options.cwd = fixturesPath;
        options.ignored = 'ignored-option.txt';
        var spy = sinon.spy();
        var files = [
          '*.txt',
          '!ignored.txt'
        ];
        fs.writeFileSync(getFixturePath('change.txt'), 'hello');
        fs.writeFileSync(getFixturePath('ignored.txt'), 'ignored');
        fs.writeFileSync(getFixturePath('ignored-option.txt'), 'ignored option');
        watcher = chokidar.watch(files, options)
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(getFixturePath('ignored.txt'), Date.now());
            fs.writeFileSync(getFixturePath('ignored-option.txt'), Date.now());
            fs.unlink(getFixturePath('ignored.txt'), simpleCb);
            fs.unlink(getFixturePath('ignored-option.txt'), simpleCb);
            w(function() {
              fs.writeFile(getFixturePath('change.txt'), 'change', simpleCb);
            }, (win32Polling010) ? 1000 : undefined)();
            waitFor([spy.withArgs('change', 'change.txt')], function() {
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.not.have.been.calledWith('add', 'ignored.txt');
              spy.should.not.have.been.calledWith('add', 'ignored-option.txt');
              spy.should.not.have.been.calledWith('change', 'ignored.txt');
              spy.should.not.have.been.calledWith('change', 'ignored-option.txt');
              spy.should.not.have.been.calledWith('unlink', 'ignored.txt');
              spy.should.not.have.been.calledWith('unlink', 'ignored-option.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              done();
            });
          });
      });
    });
    describe('ignorePermissionErrors', function() {
      var filePath;
      beforeEach(function(done) {
        filePath = getFixturePath('add.txt');
        fs.writeFile(filePath, 'b', {mode: 128}, w(done));
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
              fs.writeFile(filePath, Date.now(), w(function() {
                spy.should.not.have.been.calledWith('change', filePath);
                done();
              }, 500));
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
              fs.writeFile(filePath, Date.now(), simpleCb);
              waitFor([spy.withArgs('change')], function() {
                spy.should.have.been.calledWith('change', filePath);
                done();
              });
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
      it('should emit with the final stats', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFile(testPath, 'hello ', w(function() {
              fs.appendFileSync(testPath, 'world!');
            }, 300));
            waitFor([spy], function() {
              spy.should.have.been.calledWith('add', testPath);
              expect(spy.args[0][2].size).to.equal(12);
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
            w(fs.writeFile.bind(fs, testPath, 'hello', simpleCb))();
            waitFor([spy], function() {
              spy.should.have.been.calledWith('add', testPath);
              fs.writeFile(testPath, 'edit', simpleCb);
              waitFor([spy.withArgs('change')], function() {
                spy.should.have.been.calledWith('change', testPath);
                done();
              });
            });
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
              w(fs.writeFile.bind(fs, testPath, 'hello', simpleCb), 400)();
              waitFor([spy.withArgs('add')], function() {
                spy.should.have.been.calledWith('add', filename);
                done();
              });
            });
        }, win32Polling010 ? 900 : 200));
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
      it('should emit an unlink event when a file is updated and deleted just after that', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('subdir/add.txt');
        var filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        fs.mkdir(options.cwd, w(function() {
          fs.writeFile(testPath, 'hello', w(function() {
            stdWatcher()
              .on('all', spy)
              .on('ready', function() {
                fs.writeFile(testPath, 'edit', w(function() {
                  fs.unlink(testPath, simpleCb);
                  waitFor([spy.withArgs('unlink')], function() {
                    spy.should.have.been.calledWith('unlink', filename);
                    if (win32Polling010) return done();
                    spy.should.not.have.been.calledWith('change', filename);
                    done();
                  });
                }));
              });
          }));
        }));
      });
    });
  });
  describe('getWatched', function() {
    before(closeWatchers);
    it('should return the watched paths', function(done) {
      var expected = {};
      expected[sysPath.dirname(fixturesPath)] = [subdir.toString()];
      expected[fixturesPath] = ['change.txt', 'unlink.txt'];
      stdWatcher().on('ready', function() {
        expect(watcher.getWatched()).to.deep.equal(expected);
        done();
      });
    });
    it('should set keys relative to cwd & include added paths', function(done) {
      options.cwd = fixturesPath;
      var expected = {
        '.': ['change.txt', 'subdir', 'unlink.txt'],
        '..': [subdir.toString()],
        'subdir': []
      };
      fs.mkdir(getFixturePath('subdir'), 0x1ed, function() {
        stdWatcher().on('ready', function() {
          expect(watcher.getWatched()).to.deep.equal(expected);
          done();
        })
      });
    });
  });
  describe('unwatch', function() {
    before(closeWatchers);
    beforeEach(function(done) {
      options.ignoreInitial = true;
      fs.mkdir(getFixturePath('subdir'), 0x1ed, w(done));
    });
    it('should stop watching unwatched paths', function(done) {
      var spy = sinon.spy();
      var watchPaths = [getFixturePath('subdir'), getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', function() {
          watcher.unwatch(getFixturePath('subdir'));
          w(function() {
            fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
            fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
          })();
          waitFor([spy], w(function() {
            spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
            spy.should.not.have.been.calledWith('add');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          }, 300));
        });
    });
    it('should ignore unwatched paths that are a subset of watched paths', function(done) {
      var spy = sinon.spy();
      watcher = chokidar.watch(fixturesPath, options)
        .on('all', spy)
        .on('ready', w(function() {
          // test with both relative and absolute paths
          var subdirRel = sysPath.relative(process.cwd(), getFixturePath('subdir'));
          watcher.unwatch([subdirRel, getFixturePath('unl*')]);
          w(function() {
            fs.unlink(getFixturePath('unlink.txt'), simpleCb);
            fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
            fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
          })();
          waitFor([spy.withArgs('change')], w(function() {
            spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
            spy.should.not.have.been.calledWith('add', getFixturePath('subdir/add.txt'));
            spy.should.not.have.been.calledWith('unlink');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          }, 300));
        }));
    });
    it('should unwatch relative paths', function(done) {
      var spy = sinon.spy();
      var fixturesDir = sysPath.relative(process.cwd(), fixturesPath);
      var subdir = sysPath.join(fixturesDir, 'subdir');
      var changeFile = sysPath.join(fixturesDir, 'change.txt');
      var watchPaths = [subdir, changeFile];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', w(function() {
          watcher.unwatch(subdir);
          fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
          fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
          waitFor([spy], w(function() {
            spy.should.have.been.calledWith('change', changeFile);
            spy.should.not.have.been.calledWith('add');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          }, 300));
        }));
    });
    it('should watch paths that were unwatched and added again', function(done) {
      var spy = sinon.spy();
      var watchPaths = [getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options)
        .on('ready', w(function() {
          watcher.unwatch(getFixturePath('change.txt'));
          w(function() {
            watcher.on('all', spy).add(getFixturePath('change.txt'));
            w(function() {
              fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
              waitFor([spy], function() {
                spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
                if (!osXFsWatch) spy.should.have.been.calledOnce;
                done();
              });
            })();
          })();
        }));
    });
    it('should unwatch paths that are relative to options.cwd', function(done) {
      options.cwd = fixturesPath;
      var spy = sinon.spy();
      watcher = chokidar.watch('.', options)
        .on('all', spy)
        .on('ready', function() {
          watcher.unwatch(['subdir', getFixturePath('unlink.txt')]);
          w(function() {
            fs.unlink(getFixturePath('unlink.txt'), simpleCb);
            fs.writeFile(getFixturePath('subdir/add.txt'), Date.now(), simpleCb);
            fs.writeFile(getFixturePath('change.txt'), Date.now(), simpleCb);
          })();
          waitFor([spy], w(function() {
            spy.should.have.been.calledWith('change', 'change.txt');
            spy.should.not.have.been.calledWith('add');
            spy.should.not.have.been.calledWith('unlink');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          }, 300));
        });
    });
  });
  describe('close', function() {
    it('should ignore further events on close', function(done) {
      var spy = sinon.spy();
      watcher = chokidar.watch(fixturesPath, options).once('add', function() {
        watcher.once('add', function() {
          watcher.on('add', spy).close();
          fs.writeFile(getFixturePath('add.txt'), Date.now(), simpleCb);
          w(function() {
            spy.should.not.have.been.called;
            done();
          }, 900)();
        });
      }).on('ready', function() {
        fs.writeFile(getFixturePath('add.txt'), 'hello', function() {
          fs.unlink(getFixturePath('add.txt'), simpleCb);
        });
      });
    });
    it('should not prevent the process from exiting', function(done) {
        var scriptFile = getFixturePath('script.js');
        var scriptContent = '\
        var chokidar = require("' + __dirname.replace(/\\/g, '\\\\') + '");\n\
        var watcher = chokidar.watch("' + scriptFile.replace(/\\/g, '\\\\') + '");\n\
        watcher.close();\n\
        process.stdout.write("closed");\n';
        fs.writeFile(scriptFile, scriptContent, function (err) {
            if (err) throw err;
            cp.exec('node ' + scriptFile, function (err, stdout) {
                if (err) throw err;
                expect(stdout.toString()).to.equal('closed');
                done();
            });
        });
    });
  });
  describe('env variable option override', function() {
    describe('CHOKIDAR_USEPOLLING', function() {
      afterEach(function() {
        delete process.env.CHOKIDAR_USEPOLLING;
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to true', function(done) {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = true;

        watcher = chokidar.watch(fixturesPath, options).on('ready', function() {
          watcher.options.usePolling.should.be.true;
          done();
        });
      });

      it('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to 1', function(done) {
        options.usePolling = false;
        process.env.CHOKIDAR_USEPOLLING = 1;

        watcher = chokidar.watch(fixturesPath, options).on('ready', function() {
          watcher.options.usePolling.should.be.true;
          done();
        });
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to false', function(done) {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = false;

        watcher = chokidar.watch(fixturesPath, options).on('ready', function() {
          watcher.options.usePolling.should.be.false;
          done();
        });
      });

      it('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to 0', function(done) {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = false;

        watcher = chokidar.watch(fixturesPath, options).on('ready', function() {
          watcher.options.usePolling.should.be.false;
          done();
        });
      });

      it('should not attenuate options.usePolling when CHOKIDAR_USEPOLLING is set to an arbitrary value', function(done) {
        options.usePolling = true;
        process.env.CHOKIDAR_USEPOLLING = 'foo';

        watcher = chokidar.watch(fixturesPath, options).on('ready', function() {
          watcher.options.usePolling.should.be.true;
          done();
        });
      });
    });
    describe('CHOKIDAR_INTERVAL', function() {
      afterEach(function() {
        delete process.env.CHOKIDAR_INTERVAL;
      });

      it('should make options.interval = CHOKIDAR_INTERVAL when it is set', function(done) {
        options.interval = 100;
        process.env.CHOKIDAR_INTERVAL = 1500;

        watcher = chokidar.watch(fixturesPath, options).on('ready', function() {
          watcher.options.interval.should.be.equal(1500);
          done();
        });
      });
    });
  });
}
