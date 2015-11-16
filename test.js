'use strict';

var chokidar = require('./');
var chai = require('chai');
var expect = chai.expect;
var should = chai.should();
var sinon = require('sinon');
chai.use(require('sinon-chai'));
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

var watcher, watcher2, fixturesPath = getFixturePath(''), subdir = 0;

var testCount = 100; // to-do: count dynamically

before(function(done) {
  try { fs.mkdirSync(fixturesPath, 0x1ed); } catch(err) {}
  var writtenCount = 0;
  function wrote(err) {
    if (err) throw err;
    if (++writtenCount === testCount * 2) {
      subdir = 0;
      done();
    }
  }
  while (subdir < testCount) {
    subdir++;
    fixturesPath = getFixturePath('');
    fs.mkdir(fixturesPath, 0x1ed, function() {
      fs.writeFile(sysPath.join(this, 'change.txt'), 'b', wrote);
      fs.writeFile(sysPath.join(this, 'unlink.txt'), 'b', wrote);
    }.bind(fixturesPath));
  }
  subdir = 0;
});

beforeEach(function() {
  subdir++;
  fixturesPath = getFixturePath('');
});

afterEach(function() {
  watcher && watcher.close && watcher.close();
  watcher2 && watcher2.close && watcher2.close();
});

after(function() {
  // to-do: rimraf the whole thing
});


describe('chokidar', function() {
  this.timeout(6000);
  it('should expose public API methods', function() {
    chokidar.FSWatcher.should.be.a('function');
    chokidar.watch.should.be.a('function');
  });

  describe('non-polling', runTests.bind(this, {usePolling: false, useFsEvents: false}));
  describe('polling', runTests.bind(this, {usePolling: true}));
  if (os === 'darwin') describe('fsevents', runTests.bind(this, {useFsEvents: true}));
});

function runTests(options) {
  if (!options) options = {};

  function stdWatcher() {
    return watcher = chokidar.watch(fixturesPath, options);
  }

  // use to prevent failures caused by known issue with fs.watch on OS X
  // unpredictably emitting extra change and unlink events
  var osXFsWatch = os === 'darwin' && !options.usePolling && !options.useFsEvents;

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
  function wait(timeout, fn) {
    setTimeout(fn, timeout);
  }

  options.persistent = true;

  function clean(done) {
    delete options.ignored;
    delete options.ignoreInitial;
    delete options.alwaysStat;
    delete options.followSymlinks;
    delete options.cwd;
    delete options.depth;
    delete options.ignorePermissionErrors;
    done && d(done, true)();
  }

  describe('watch a directory', function() {
    var readySpy, rawSpy;
    before(clean);
    beforeEach(function() {
      readySpy = sinon.spy(function readySpy(){});
      rawSpy = sinon.spy(function rawSpy(){});
      options.ignoreInitial = true;
      options.alwaysStat = true;
      stdWatcher().on('ready', readySpy).on('raw', rawSpy);
    });
    afterEach(function(done) {
      dd(function() {
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
      watcher.on('add', spy).on('ready', d(function() {
        fs.writeFileSync(testPath, 'hello');
        waitFor([spy], function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      }, true));
    });
    it('should emit `addDir` event when directory was added', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      watcher.on('addDir', spy).on('ready', d(function() {
        spy.should.not.have.been.called;
        fs.mkdirSync(testDir, 0x1ed);
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
        fs.writeFileSync(testPath, 'c');
        waitFor([spy], function() {
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      });
    });
    it('should emit `unlink` event when file was removed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      watcher.on('unlink', spy).on('ready', function() {
        spy.should.not.have.been.called;
        fs.unlinkSync(testPath);
        waitFor([spy], function() {
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.not.be.ok; // no stats
          rawSpy.should.have.been.called;
          done();
        });
      });
    });
    it('should emit `unlinkDir` event when a directory was removed', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir, 0x1ed);
      watcher.on('unlinkDir', spy).on('ready', d(function() {
        fs.rmdirSync(testDir);
        waitFor([spy], function() {
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testDir);
          expect(spy.args[0][1]).to.not.be.ok; // no stats
          rawSpy.should.have.been.called;
          done();
        });
      }));
    });
    it('should emit `unlink` and `add` events when a file is renamed', function(done) {
      var unlinkSpy = sinon.spy(function unlink(){});
      var addSpy = sinon.spy(function add(){});
      var testPath = getFixturePath('change.txt');
      var newPath = getFixturePath('moved.txt');
      watcher
        .on('unlink', unlinkSpy)
        .on('add', addSpy)
        .on('ready', d(function() {
          unlinkSpy.should.not.have.been.called;
          addSpy.should.not.have.been.called;
          fs.renameSync(testPath, newPath);
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
        }));
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
          fs.unlinkSync(testPath);
          waitFor([unlinkSpy.withArgs(testPath)], function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            waitFor([addSpy.withArgs(testPath)], function() {
              addSpy.should.have.been.calledWith(testPath);
              changeSpy.should.not.have.been.called;
              done();
            });
            d(fs.writeFileSync.bind(fs, testPath, 'b'))();
          });
        });
    });
    it('should not emit `unlink` for previously moved files', function(done) {
      var unlinkSpy = sinon.spy(function unlink(){});
      var addSpy = sinon.spy(function add(){});
      var testPath = getFixturePath('start.txt');
      var newPath1 = getFixturePath('moved.txt');
      var newPath2 = getFixturePath('moved-again.txt');
      fs.writeFileSync(testPath, 'b');
      watcher
        .on('add', addSpy)
        .on('unlink', unlinkSpy)
        .on('ready', d(function() {
          waitFor([unlinkSpy, addSpy.withArgs(newPath1)], d(function() {
            waitFor([unlinkSpy.withArgs(newPath1)], dd(function() {
              unlinkSpy.withArgs(testPath).should.have.been.calledOnce;
              unlinkSpy.withArgs(newPath1).should.have.been.calledOnce;
              unlinkSpy.withArgs(newPath2).should.not.have.been.called;
              addSpy.withArgs(newPath1).should.have.been.calledOnce;
              addSpy.withArgs(newPath2).should.have.been.calledOnce;
              done();
            }));
            fs.rename(newPath1, newPath2);
          }, true));
          fs.rename(testPath, newPath1);
        }, true));
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
      watcher.on('add', spy).on('ready', d(function() {
        spy.should.not.have.been.called;
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(testPath, 'hello');
        waitFor([spy], function() {
          fs.unlinkSync(testPath);
          fs.rmdirSync(testDir);
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      }));
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
    beforeEach(clean);
    it('should detect changes', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      watcher = chokidar.watch(testPath, options)
        .on('change', spy)
        .on('ready', d(function() {
          fs.writeFileSync(testPath, 'c');
          waitFor([spy], function() {
            spy.should.have.always.been.calledWith(testPath);
            done();
          });
        }));
    });
    it('should detect unlinks', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      watcher = chokidar.watch(testPath, options)
        .on('unlink', spy)
        .on('ready', d(function() {
          fs.unlinkSync(testPath);
          waitFor([spy], function() {
            spy.should.have.been.calledWith(testPath);
            done();
          });
        }, true));
    });
    it('should detect unlink and re-add', function(done) {
      var unlinkSpy = sinon.spy(function unlinkSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      var testPath = getFixturePath('unlink.txt');
      options.ignoreInitial = true;
      watcher = chokidar.watch(testPath, options)
        .on('unlink', unlinkSpy)
        .on('add', addSpy)
        .on('ready', d(function() {
          waitFor([unlinkSpy], d(function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            waitFor([addSpy], function() {
              addSpy.should.have.been.calledWith(testPath);
              done();
            });
            d(function() { fs.writeFileSync(testPath, 'ra'); })();
          }, true));
          fs.unlinkSync(testPath);
        }));
    });
    it('should ignore unwatched siblings', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      var siblingPath = getFixturePath('change.txt');
      d(function() {
        watcher = chokidar.watch(testPath, options)
          .on('all', spy)
          .on('ready', dd(function() {
            fs.writeFileSync(siblingPath, 'c');
            fs.writeFileSync(testPath, 'a');
            waitFor([spy], function() {
              spy.should.have.always.been.calledWith('add', testPath);
              done();
            });
          }));
      })();
    });
  });
  describe('watch non-existent paths', function() {
    beforeEach(clean);
    it('should watch non-existent file and detect add', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      d(function() {
        watcher = chokidar.watch(testPath, options)
          .on('add', spy)
          .on('ready', dd(function() {
            waitFor([spy], function() {
              spy.should.have.been.calledWith(testPath);
              done();
            });
            fs.writeFileSync(testPath, 'a');
          }));
      })();
    });
    it('should watch non-existent dir and detect addDir/add', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      var testPath = getFixturePath('subdir/add.txt');
      d(function() {
        watcher = chokidar.watch(testDir, options)
          .on('all', spy)
          .on('ready', dd(function() {
            spy.should.not.have.been.called;
            waitFor([[spy, 2]], function() {
              spy.should.have.been.calledWith('addDir', testDir);
              spy.should.have.been.calledWith('add', testPath);
              done();
            });
            fs.mkdirSync(testDir, 0x1ed);
            fs.writeFileSync(testPath, 'hello');
          }));
      })();
    });
  });
  describe('watch glob patterns', function() {
    beforeEach(clean);
    it('should correctly watch and emit based on glob input', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('*a*.txt');
      var addPath = getFixturePath('add.txt');
      var changePath = getFixturePath('change.txt');
      d(function() {
        watcher = chokidar.watch(testPath, options)
          .on('all', spy)
          .on('ready', dd(function() {
            spy.should.have.been.calledWith('add', changePath);
            fs.writeFileSync(addPath, 'a');
            fs.writeFileSync(changePath, 'c');
            waitFor([[spy, 3], spy.withArgs('add', addPath)], function() {
              spy.should.have.been.calledWith('add', addPath);
              spy.should.have.been.calledWith('change', changePath);
              spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
              spy.should.not.have.been.calledWith('addDir');
              done();
            });
          }));
      })();
    });
    it('should respect negated glob patterns', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('*');
      var negatedPath = '!' + getFixturePath('*a*.txt');
      var unlinkPath = getFixturePath('unlink.txt');
      dd(function() {
        watcher = chokidar.watch([testPath, negatedPath], options)
          .on('all', spy)
          .on('ready', d(function() {
            spy.should.have.been.calledOnce;
            spy.should.have.been.calledWith('add', unlinkPath);
            fs.unlinkSync(unlinkPath);
            waitFor([[spy, 2], spy.withArgs('unlink')], function() {
              if (!osXFsWatch) spy.should.have.been.calledTwice;
              spy.should.have.been.calledWith('unlink', unlinkPath);
              done();
            });
          }, true));
      })();
    });
    it('should traverse subdirs to match globstar patterns', function(done) {
      var spy = sinon.spy();
      spy.withArgs('add');
      spy.withArgs('unlink');
      spy.withArgs('change');
      fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
      fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
      fs.writeFileSync(getFixturePath('subdir/a.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/b.txt'), 'b');
      fs.writeFileSync(getFixturePath('subdir/subsub/ab.txt'), 'b');
      dd(function() {
        var watchPath = getFixturePath('../test-*/**/a*.txt');
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
      })();
    });
    it('should resolve relative paths with glob patterns', function(done) {
      var spy = sinon.spy();
      var testPath = 'test-*/*a*.txt';
      var addPath = sysPath.join('test-fixtures', 'add.txt');
      var changePath = sysPath.join('test-fixtures', 'change.txt');
      var unlinkPath = sysPath.join('test-fixtures', 'unlink.txt');
      watcher = chokidar.watch(testPath, options)
        .on('all', spy)
        .on('ready', d(function() {
          spy.should.have.been.calledWith('add', changePath);
          fs.writeFileSync(addPath, 'a');
          fs.writeFileSync(changePath, 'c');
          waitFor([[spy, 3], spy.withArgs('add', addPath)], function() {
            spy.should.have.been.calledWith('add', addPath);
            spy.should.have.been.calledWith('change', changePath);
            spy.should.not.have.been.calledWith('add', unlinkPath);
            spy.should.not.have.been.calledWith('addDir');
            if (!osXFsWatch) spy.should.have.been.calledThrice;
            done();
          });
        }));
    });
    it('should correctly handle conflicting glob patterns', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var unlinkPath = getFixturePath('unlink.txt');
      var addPath = getFixturePath('add.txt');
      var watchPaths = [getFixturePath('change*'), getFixturePath('unlink*')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', d(function() {
          spy.should.have.been.calledWith('add', changePath);
          spy.should.have.been.calledWith('add', unlinkPath);
          if (!osXFsWatch) spy.should.have.been.calledTwice;
          fs.writeFileSync(addPath, 'a');
          fs.writeFileSync(changePath, 'c');
          fs.unlinkSync(unlinkPath);
          waitFor([[spy, 4], spy.withArgs('unlink', unlinkPath)], function() {
            spy.should.have.been.calledWith('change', changePath);
            spy.should.have.been.calledWith('unlink', unlinkPath);
            spy.should.not.have.been.calledWith('add', addPath);
            if (!osXFsWatch) spy.callCount.should.equal(4);
            done();
          });
        }));
    });
    it('should correctly handle intersecting glob patterns', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var watchPaths = [getFixturePath('cha*'), getFixturePath('*nge.*')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', d(function() {
          spy.should.have.been.calledWith('add', changePath);
          if (!osXFsWatch) spy.should.have.been.calledOnce;
          fs.writeFileSync(changePath, 'c');
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('change', changePath);
            if (!osXFsWatch) spy.should.have.been.calledTwice;
            done();
          });
        }));
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
              fs.unlinkSync(filePath);
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
      dd(function() {
        var watchPath = getFixturePath('../test-*/**/subsubsub/*.txt');
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
      })();
    });
  });
  describe('watch symlinks', function() {
    if (os === 'win32') return;
    var linkedDir = sysPath.resolve(fixturesPath, '..', 'test-fixtures-link');
    function symlinkClean() {
      try { fs.unlinkSync(getFixturePath('link.txt')); } catch(err) {}
      try { fs.unlinkSync(getFixturePath('subdir/link.txt')); } catch(err) {}
      try { fs.unlinkSync(getFixturePath('subdir/circular')); } catch(err) {}
      try { fs.unlinkSync(getFixturePath('link')); } catch(err) {}
      try { fs.unlinkSync(getFixturePath('subdir/subsub')); } catch(err) {}
      try { fs.unlinkSync(getFixturePath('outside/text.txt')); } catch(err) {}
      try { fs.rmdirSync(getFixturePath('outside')); } catch(err) {}
    }
    beforeEach(function(done) {
      clean(function() {
        try { fs.symlinkSync(fixturesPath, linkedDir); } catch(err) {}
        try { fs.mkdirSync(getFixturePath('subdir'), 0x1ed); } catch(err) {}
        fs.writeFileSync(getFixturePath('subdir/add.txt'), 'b');
        symlinkClean();
        done();
      });
    });
    after(function() {
      symlinkClean();
      try { fs.unlinkSync(linkedDir); } catch(err) {}
      try { fs.unlinkSync(getFixturePath('subdir/add.txt')); } catch(err) {}
      try { fs.rmdirSync(getFixturePath('subdir')); } catch(err) {}
    });
    it('should watch symlinked dirs', function(done) {
      var dirSpy = sinon.spy(function dirSpy(){});
      var addSpy = sinon.spy(function addSpy(){});
      watcher = chokidar.watch(linkedDir, options)
        .on('addDir', dirSpy)
        .on('add', addSpy)
        .on('ready', d(function() {
          dirSpy.should.have.been.calledWith(linkedDir);
          addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'change.txt'));
          addSpy.should.have.been.calledWith(sysPath.join(linkedDir, 'unlink.txt'));
          done();
        }));
    });
    it('should watch symlinked files', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var linkPath = getFixturePath('link.txt');
      fs.symlinkSync(changePath, linkPath);
      watcher = chokidar.watch(linkPath, options)
        .on('all', spy)
        .on('ready', d(function() {
          fs.writeFileSync(changePath, 'c');
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
        }));
    });
    it('should follow symlinked files within a normal dir', function(done) {
      var spy = sinon.spy();
      var changePath = getFixturePath('change.txt');
      var linkPath = getFixturePath('subdir/link.txt');
      fs.symlinkSync(changePath, linkPath);
      watcher = chokidar.watch(getFixturePath('subdir'), options)
        .on('all', spy)
        .on('ready', d(function() {
          fs.writeFileSync(changePath, 'c');
          waitFor([spy.withArgs('change', linkPath)], function() {
            spy.should.have.been.calledWith('add', linkPath);
            spy.should.have.been.calledWith('change', linkPath);
            done();
          });
        }));
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
      stdWatcher()
        .on('ready', function() {
          done();
        });
    });
    it('should recognize changes following symlinked dirs', function(done) {
      var spy = sinon.spy(function changeSpy(){});
      d(function() {
        watcher = chokidar.watch(linkedDir, options)
          .on('change', spy)
          .on('ready', function() {
            fs.writeFileSync(getFixturePath('change.txt'), 'c');
            var linkedFilePath = sysPath.join(linkedDir, 'change.txt');
            waitFor([spy.withArgs(linkedFilePath)], function() {
              spy.should.have.been.calledWith(linkedFilePath);
              done();
            });
          });
      })();
    });
    it('should follow newly created symlinks', function(done) {
      var spy = sinon.spy();
      options.ignoreInitial = true;
      d(function() {
        stdWatcher()
          .on('all', spy)
          .on('ready', d(function() {
            fs.symlinkSync(getFixturePath('subdir'), getFixturePath('link'));
            waitFor([
              spy.withArgs('add', getFixturePath('link/add.txt')),
              spy.withArgs('addDir', getFixturePath('link'))
            ], function() {
              spy.should.have.been.calledWith('addDir', getFixturePath('link'));
              spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
              done();
            });
          }, true));
      })();
    });
    it('should watch symlinks as files when followSymlinks:false', function(done) {
      var spy = sinon.spy();
      options.followSymlinks = false;
      watcher = chokidar.watch(linkedDir, options)
        .on('all', spy)
        .on('ready', d(function() {
          spy.should.not.have.been.calledWith('addDir');
          spy.should.have.been.calledWith('add', linkedDir);
          spy.should.have.been.calledOnce;
          done();
        }));
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
    beforeEach(clean);
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
          fs.writeFileSync(testPath, Date.now());
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
      fs.mkdirSync(testDir);
      watcher = chokidar.watch([[testDir], [testPath]], options)
        .on('all', spy)
        .on('ready', function() {
          spy.should.have.been.calledWith('add', testPath);
          spy.should.have.been.calledWith('addDir', testDir);
          spy.should.not.have.been.calledWith('add', getFixturePath('unlink.txt'));
          fs.writeFileSync(testPath, Date.now());
          waitFor([spy.withArgs('change')], function() {
            spy.should.have.been.calledWith('change', testPath);
            done();
          });
        });
    });
    it('should throw if provided any non-string paths', function() {
      expect(chokidar.watch.bind(null, [[fixturesPath], /notastring/]))
        .to.throw(TypeError, /non-string/i);
    });
  });
  describe('watch options', function() {
    beforeEach(clean);
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
          fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
          fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed);
          d(function() {
            watcher = chokidar.watch(fixturesPath, options)
              .on('addDir', spy)
              .on('ready', function() {
                spy.should.have.been.calledWith(fixturesPath);
                spy.should.have.been.calledWith(getFixturePath('subdir'));
                spy.should.have.been.calledWith(getFixturePath('subdir/subsub'));
                if (!osXFsWatch) spy.should.have.been.calledThrice;
                done();
              });
          })();
        });
      });
      describe('true', function() {
        beforeEach(function() { options.ignoreInitial = true; });
        it('should ignore inital add events', function(done) {
          var spy = sinon.spy();
          stdWatcher()
            .on('add', spy)
            .on('ready', d(function() {
              spy.should.not.have.been.called;
              done();
            }));
        });
        it('should ignore add events on a subsequent .add()', function(done) {
          var spy = sinon.spy();
          dd(function() {
            watcher = chokidar.watch(getFixturePath('subdir'), options)
              .on('add', spy)
              .on('ready', function() {
                watcher.add(fixturesPath);
                dd(function() {
                  spy.should.not.have.been.called;
                  done();
                })();
            });
          })();
        });
        it('should notice when a file appears in an empty directory', function(done) {
          var spy = sinon.spy();
          var testDir = getFixturePath('subdir');
          var testPath = getFixturePath('subdir/add.txt');
          stdWatcher()
            .on('add', spy)
            .on('ready', function() {
              spy.should.not.have.been.called;
              fs.mkdirSync(testDir, 0x1ed);
              fs.writeFileSync(testPath, 'hello');
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
            .on('ready', d(function() {
              spy.should.not.have.been.called;
              fs.writeFileSync(testPath, 'c');
              waitFor([spy.withArgs('change', testPath)], function() {
                spy.should.have.been.calledWith('change', testPath);
                spy.should.not.have.been.calledWith('add');
                done();
              });
            }));
        });
        it('should not emit for preexisting dirs when depth is 0', function(done) {
          var spy = sinon.spy();
          var testPath = getFixturePath('add.txt');
          fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
          options.depth = 0
          dd(function() {
            stdWatcher()
              .on('all', spy)
              .on('ready', d(function() {
                fs.writeFileSync(testPath, 'c');
                waitFor([spy], dd(function() {
                  spy.should.have.been.calledWith('add', testPath);
                  spy.should.not.have.been.calledWith('addDir');
                  done();
                }));
              }));
          })();
        });
      });
    });
    describe('ignored', function() {
      it('should check ignore after stating', function(done) {
        var spy = sinon.spy();
        var testDir = getFixturePath('subdir');
        try { fs.mkdirSync(testDir, 0x1ed); } catch(e) {}
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
        try { fs.mkdirSync(testDir, 0x1ed); } catch(e) {}
        fs.writeFileSync(testFile, 'b');
        options.ignored = testDir;
        watcher = chokidar.watch(fixturesPath, options)
          .on('all', spy)
          .on('ready', d(function() {
            fs.writeFileSync(testFile, 'a');
            dd(function() {
              spy.should.not.have.been.calledWith('addDir', testDir);
              spy.should.not.have.been.calledWith('add', testFile);
              spy.should.not.have.been.calledWith('change', testFile);
              done();
            })();
          }));
      });
      it('should allow regex/fn ignores', function(done) {
        var spy = sinon.spy();
        fs.writeFileSync(getFixturePath('add.txt'), 'b');
        options.cwd = fixturesPath;
        options.ignored = /add/;
        watcher = chokidar.watch(fixturesPath, options)
          .on('all', spy)
          .on('ready', d(function() {
            fs.writeFileSync(getFixturePath('add.txt'), 'a');
            fs.writeFileSync(getFixturePath('change.txt'), 'a');
            waitFor([spy.withArgs('change', 'change.txt')], function() {
              spy.should.not.have.been.calledWith('add', 'add.txt');
              spy.should.not.have.been.calledWith('change', 'add.txt');
              spy.should.have.been.calledWith('add', 'change.txt');
              spy.should.have.been.calledWith('change', 'change.txt');
              done();
            });
          }));
      });
    });
    describe('depth', function() {
      beforeEach(function(done) {
        clean();
        try { fs.mkdirSync(getFixturePath('subdir'), 0x1ed); } catch(err) {}
        try { fs.mkdirSync(getFixturePath('subdir/subsub'), 0x1ed); } catch(err) {}
        try { fs.writeFileSync(getFixturePath('subdir/add.txt'), 'b'); } catch(err) {}
        try { fs.writeFileSync(getFixturePath('subdir/subsub/ab.txt'), 'b'); } catch(err) {}
        d(done, true)();
      });
      it('should not recurse if depth is 0', function(done) {
        options.depth = 0;
        var spy = sinon.spy();
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', function() {
              fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
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
        })();
      });
      it('should recurse to specified depth', function(done) {
        options.depth = 1;
        var spy = sinon.spy();
        var addPath = getFixturePath('subdir/add.txt');
        var changePath = getFixturePath('change.txt');
        var ignoredPath = getFixturePath('subdir/subsub/ab.txt');
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', d(function() {
              fs.writeFileSync(getFixturePath('change.txt'), 'c');
              fs.writeFileSync(addPath, 'c');
              fs.writeFileSync(ignoredPath, 'c');
              waitFor([spy.withArgs('change', addPath), spy.withArgs('change', changePath)], function() {
                spy.should.have.been.calledWith('addDir', getFixturePath('subdir/subsub'));
                spy.should.have.been.calledWith('change', changePath);
                spy.should.have.been.calledWith('change', addPath);
                spy.should.not.have.been.calledWith('add', ignoredPath);
                spy.should.not.have.been.calledWith('change', ignoredPath);
                if (options.usePolling || options.useFsEvents) spy.callCount.should.equal(8);
                done();
              });
            }));
        })();
      });
      it('should respect depth setting when following symlinks', function(done) {
        if (os === 'win32') return done(); // skip on windows
        options.depth = 1;
        var spy = sinon.spy();
        fs.symlinkSync(getFixturePath('subdir'), getFixturePath('link'));
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', d(function() {
              spy.should.have.been.calledWith('addDir', getFixturePath('link'));
              spy.should.have.been.calledWith('addDir', getFixturePath('link/subsub'));
              spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
              spy.should.not.have.been.calledWith('add', getFixturePath('link/subsub/ab.txt'));
              done();
            }));
        }, true)();
      });
      it('should respect depth setting when following a new symlink', function(done) {
        if (os === 'win32') return done(); // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        var spy = sinon.spy();
        var linkPath = getFixturePath('link');
        var dirPath = getFixturePath('link/subsub');
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', d(function() {
              fs.symlinkSync(getFixturePath('subdir'), linkPath);
              waitFor([[spy, 3], spy.withArgs('addDir', dirPath)], function() {
                spy.should.have.been.calledWith('addDir', linkPath);
                spy.should.have.been.calledWith('addDir', dirPath);
                spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
                if (!osXFsWatch) spy.should.have.been.calledThrice;
                done();
              });
            }));
        })();
      });
      it('should correctly handle dir events when depth is 0', function(done) {
        options.depth = 0;
        var spy = sinon.spy();
        var addSpy = spy.withArgs('addDir');
        var unlinkSpy = spy.withArgs('unlinkDir');
        var subdir2 = getFixturePath('subdir2');
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', d(function() {
              spy.should.have.been.calledWith('addDir', fixturesPath);
              spy.should.have.been.calledWith('addDir', getFixturePath('subdir'));
              fs.mkdirSync(subdir2, 0x1ed);
              waitFor([[addSpy, 3]], d(function() {
                addSpy.should.have.been.calledThrice;
                fs.rmdirSync(subdir2);
                waitFor([unlinkSpy], dd(function() {
                  unlinkSpy.should.have.been.calledOnce;
                  unlinkSpy.should.have.been.calledWith('unlinkDir', subdir2);
                  done();
                }));
              }));
            }));
        })();
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
        options2.cwd = sysPath.join('..', 'chokidar');
        watcher = chokidar.watch('**', options)
          .on('all', spy1)
          .on('ready', d(function() {
            watcher2 = chokidar.watch('test-fixtures', options2)
              .on('all', spy2)
              .on('ready', d(function() {
                fs.writeFileSync(getFixturePath('change.txt'), 'c');
                fs.unlinkSync(getFixturePath('unlink.txt'));
                waitFor([spy1.withArgs('unlink'), spy2.withArgs('unlink')], function() {
                  spy1.should.have.been.calledWith('change', 'change.txt');
                  spy1.should.have.been.calledWith('unlink', 'unlink.txt');
                  spy2.should.have.been.calledWith('add', sysPath.join('test-fixtures', 'change.txt'));
                  spy2.should.have.been.calledWith('add', sysPath.join('test-fixtures', 'unlink.txt'));
                  spy2.should.have.been.calledWith('change', sysPath.join('test-fixtures', 'change.txt'));
                  spy2.should.have.been.calledWith('unlink', sysPath.join('test-fixtures', 'unlink.txt'));
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
      var filePath = getFixturePath('add.txt');
      beforeEach(function() { fs.writeFileSync(filePath, 'b', {mode: 128}); });
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
            fs.writeFileSync(testPath, 'hello');
            wait(200, function() {
              spy.should.not.have.been.calledWith('add');
              done();
            });
          });
      });
      it('should wait for the file to be fully written before emitting the add event', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(testPath, 'hello');
            wait(700, function() {
              spy.should.have.been.calledWith('add', testPath);
              done();
            });
          }.bind(this));
      });
      it('should not emit change event while a file has not been fully written', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(testPath, 'hello');
            wait(100, function() {
              fs.writeFileSync(testPath, 'edit');
              wait(200, function() {
                spy.should.not.have.been.calledWith('change', testPath);
                done();
              });
            });
          }.bind(this));
      });
      it('should not emit change event before an existing file is fully updated', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('change.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(testPath, 'hello');
            wait(300, function() {
              spy.should.not.have.been.calledWith('change', testPath);
              done();
            });
          }.bind(this));
      });
      it('should wait for an existing file to be fully updated before emitting the change event', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('change.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(testPath, 'hello');
            wait(700, function() {
              spy.should.have.been.calledWith('change', testPath);
              done();
            });
          }.bind(this));
      });
      it('should emit change event after the file is fully written', function(done) {
        var spy = sinon.spy();
        var changeSpy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(testPath, 'hello');
            wait(700, function() {
              spy.should.have.been.calledWith('add', testPath);
              fs.writeFileSync(testPath, 'edit');
              wait(700, function() {
                spy.should.have.been.calledWith('change', testPath);
                done();
              })
            });
          }.bind(this))
      });
      it('should not raise any event for a file that was deleted before fully written', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('add.txt');
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            fs.writeFileSync(testPath, 'hello');
            wait(400, function() {
              fs.unlinkSync(testPath);
              wait(400, function() {
                spy.should.not.have.been.calledWith(sinon.match.string, testPath);
                done();
              });
            });
          });
      });
      it('should be compatible with the cwd option', function(done) {
        var spy = sinon.spy();
        var testPath = getFixturePath('subdir/add.txt');
        var filename = sysPath.basename(testPath);
        options.cwd = sysPath.dirname(testPath);
        fs.mkdirSync(options.cwd);
        stdWatcher()
          .on('all', spy)
          .on('ready', function() {
            waitFor([spy.withArgs('add', filename)], function() {
              spy.should.have.been.calledWith('add', filename);
              done();
            });
            d(fs.writeFileSync.bind(fs, testPath, 'hello'))();
          });
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
    beforeEach(function(done) {
      clean(function() {
        try { fs.mkdirSync(getFixturePath('subdir'), 0x1ed); } catch(err) {}
        options.ignoreInitial = true;
        d(done)();
      });
    });
    it('should stop watching unwatched paths', function(done) {
      var spy = sinon.spy();
      var watchPaths = [getFixturePath('subdir'), getFixturePath('change.txt')];
      watcher = chokidar.watch(watchPaths, options)
        .on('all', spy)
        .on('ready', d(function() {
          watcher.unwatch(getFixturePath('subdir'));
          fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
          fs.writeFileSync(getFixturePath('change.txt'), 'c');
          waitFor([spy], function() {
            spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
            spy.should.not.have.been.calledWith('add');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          });
        }));
    });
    it('should ignore unwatched paths that are a subset of watched paths', function(done) {
      var spy = sinon.spy();
      watcher = chokidar.watch(fixturesPath, options)
        .on('all', spy)
        .on('ready', d(function() {
          // test with both relative and absolute paths
          var subdirRel = sysPath.join(sysPath.basename(fixturesPath), 'subdir');
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
      var fixturesDir = sysPath.basename(fixturesPath);
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
    beforeEach(clean);
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
