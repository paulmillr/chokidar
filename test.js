'use strict';

var chokidar = require('./');
var chai = require('chai');
var expect = chai.expect;
var should = chai.should();
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var fs = require('fs');
var sysPath = require('path');
var os = require('os').platform();

function getFixturePath (subPath) {
  return sysPath.join(__dirname, 'test-fixtures', subPath);
}

var fixturesPath = getFixturePath('');

var watcher, watcher2;

before(function() {
  try { fs.mkdirSync(fixturesPath, 0x1ed); } catch(err) {}
});

afterEach(function() {
  watcher && watcher.close && watcher.close();
  watcher2 && watcher2.close && watcher2.close();
});

function rmFixtures() {
  try { fs.unlinkSync(getFixturePath('link')); } catch(err) {}
  try { fs.unlinkSync(getFixturePath('add.txt')); } catch(err) {}
  try { fs.unlinkSync(getFixturePath('moved.txt')); } catch(err) {}
  try { fs.unlinkSync(getFixturePath('subdir/add.txt')); } catch(err) {}
  try { fs.unlinkSync(getFixturePath('subdir/dir/ignored.txt')); } catch(err) {}
  try { fs.rmdirSync(getFixturePath('subdir/dir')); } catch(err) {}
  try { fs.unlinkSync(getFixturePath('subdir/subsub/ab.txt')); } catch(err) {}
  try { fs.rmdirSync(getFixturePath('subdir/subsub')); } catch(err) {}
  try { fs.rmdirSync(getFixturePath('subdir')); } catch(err) {}
}

after(function() {
  rmFixtures();
  try { fs.unlinkSync(getFixturePath('change.txt')); } catch(err) {}
  try { fs.unlinkSync(getFixturePath('unlink.txt')); } catch(err) {}
  try { fs.rmdirSync(fixturesPath); } catch(err) {}
});


describe('chokidar', function() {
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
    var intrvl = setInterval(function() {
      if (spies.every(isSpyReady)) {
        clearInterval(intrvl);
        fn();
        fn = Function.prototype;
      }
    }, 5);
  }
  function d(fn, quicker, forceTimeout) {
    if (options.usePolling || forceTimeout) {
      return setTimeout.bind(null, fn, quicker ? 300 : 900);
    } else if (process.version.substr(0, 4) === 'v0.8.') {
    } else {
      return process.nextTick.bind(process, fn);
    }
  }
  function dd(fn) {
    return d(fn, true, true);
  }

  options.persistent = true;

  function clean(done) {
    delete options.ignored;
    delete options.ignoreInitial;
    delete options.alwaysStat;
    delete options.followSymlinks;
    delete options.cwd;
    delete options.depth;
    fs.writeFileSync(getFixturePath('change.txt'), 'b');
    fs.writeFileSync(getFixturePath('unlink.txt'), 'b');
    rmFixtures();
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
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          expect(spy.args[0][1]).to.be.ok; // stats
          rawSpy.should.have.been.called;
          done();
        });
      }));
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
        .on('ready', function() {
          waitFor([unlinkSpy], d(function() {
            unlinkSpy.should.have.been.calledWith(testPath);
            waitFor([addSpy], function() {
              addSpy.should.have.been.calledWith(testPath);
              done();
            });
            fs.writeFileSync(testPath, 'ra');
          }));
          fs.unlinkSync(testPath);
        });
    });
    it('should ignore unwatched siblings', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      var siblingPath = getFixturePath('change.txt');
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
    });
  });
  describe('watch non-existent paths', function() {
    beforeEach(clean);
    it('should watch non-existent file and detect add', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      watcher = chokidar.watch(testPath, options)
        .on('add', spy)
        .on('ready', d(function() {
          waitFor([spy], function() {
            spy.should.have.been.calledWith(testPath);
            done();
          });
          fs.writeFileSync(testPath, 'a');
        }));
    });
    it('should watch non-existent dir and detect addDir/add', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      var testPath = getFixturePath('subdir/add.txt');
      watcher = chokidar.watch(testDir, options)
        .on('all', spy)
        .on('ready', d(function() {
          spy.should.not.have.been.called;
          waitFor([[spy, 2]], function() {
            spy.should.have.been.calledWith('addDir', testDir);
            spy.should.have.been.calledWith('add', testPath);
            done();
          });
          fs.mkdirSync(testDir, 0x1ed);
          fs.writeFileSync(testPath, 'hello');
        }));
    });
  });
  describe('watch glob patterns', function() {
    beforeEach(clean);
    it('should correctly watch and emit based on glob input', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('*a*.txt');
      var addPath = getFixturePath('add.txt');
      var changePath = getFixturePath('change.txt');
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
          fs.unlinkSync(unlinkPath);
          waitFor([[spy, 2]], function() {
            if (!osXFsWatch) spy.should.have.been.calledTwice;
            spy.should.have.been.calledWith('unlink', unlinkPath);
            done();
          });
        });
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
            waitFor([[spy, 5], [spy.withArgs('add'), 3], spy.withArgs('unlink', getFixturePath('subdir/a.txt')), spy.withArgs('change', getFixturePath('subdir/subsub/ab.txt'))], function() {
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
      var readySpy = sinon.spy(function ready() {});
      var filePath = getFixturePath('notaglob[*].txt');
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
      d(function(){
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
            waitFor([spy.withArgs('add'), spy.withArgs('addDir')], function() {
              spy.should.have.been.calledWith('addDir', getFixturePath('link'));
              spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
              done();
            });
          }));
      })();
    });
    it('should watch symlinks as files when followSymlinks:false', function(done) {
      // TODO: figure out why fsevents watcher.close() hangs after this test
      if (options.useFsEvents) return done();
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
  describe('watch options', function() {
    beforeEach(clean);
    describe('ignoreInitial:true', function() {
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
        watcher = chokidar.watch(getFixturePath('subdir'), options)
          .on('add', spy)
          .on('ready', function() {
            watcher.add(fixturesPath);
            dd(function() {
              spy.should.not.have.been.called;
              done();
            })();
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
        stdWatcher()
          .on('all', spy)
          .on('ready', d(function() {
            spy.should.not.have.been.called;
            fs.writeFileSync(getFixturePath('change.txt'), 'c');
            waitFor([spy.withArgs('change', getFixturePath('change.txt'))], function() {
              spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
              spy.should.not.have.been.calledWith('add');
              done();
            });
          }));
      });
    });
    describe('ignoreInitial:false', function() {
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
        fs.mkdirSync(getFixturePath('subdir/dir'), 0x1ed);
        d(function() {
          watcher = chokidar.watch(fixturesPath, options)
            .on('addDir', spy)
            .on('ready', function(){
              spy.should.have.been.calledWith(fixturesPath);
              spy.should.have.been.calledWith(getFixturePath('subdir'));
              spy.should.have.been.calledWith(getFixturePath('subdir/dir'));
              if (!osXFsWatch) spy.should.have.been.calledThrice;
              done();
            });
        })();
      });
    });
    describe('ignored', function() {
      it('should check ignore after stating', function(done) {
        var testDir = getFixturePath('subdir');
        var spy = sinon.spy();
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(testDir + '/add.txt', '');
        fs.mkdirSync(testDir + '/dir', 0x1ed);
        fs.writeFileSync(testDir + '/dir/ignored.txt', '');
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
        stdWatcher()
          .on('ready', function() {
            done();
          });
      });
    });
    describe('depth', function() {
      beforeEach(function(done) {
        clean();
        try { fs.mkdirSync(getFixturePath('subdir'), 0x1ed); } catch(err) {}
        try { fs.mkdirSync(getFixturePath('subdir/dir'), 0x1ed); } catch(err) {}
        try { fs.writeFileSync(getFixturePath('subdir/add.txt'), 'b'); } catch(err) {}
        try { fs.writeFileSync(getFixturePath('subdir/dir/ignored.txt'), 'b'); } catch(err) {}
        d(done, true)();
      });
      it('should not recurse if depth is 0', function(done) {
        options.depth = 0;
        var spy = sinon.spy();
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
      });
      it('should recurse to specified depth', function(done) {
        options.depth = 1;
        var spy = sinon.spy();
        var addPath = getFixturePath('subdir/add.txt');
        var changePath = getFixturePath('change.txt');
        dd(function() {
          stdWatcher()
            .on('all', spy)
            .on('ready', d(function() {
              fs.writeFileSync(getFixturePath('change.txt'), 'c');
              fs.writeFileSync(addPath, 'c');
              fs.writeFileSync(getFixturePath('subdir/dir/ignored.txt'), 'c');
              waitFor([spy.withArgs('change', addPath), spy.withArgs('change', changePath)], function() {
                spy.should.have.been.calledWith('addDir', getFixturePath('subdir/dir'));
                spy.should.have.been.calledWith('change', changePath);
                spy.should.have.been.calledWith('change', addPath);
                spy.should.not.have.been.calledWith('add', getFixturePath('subdir/dir/ignored.txt'));
                spy.should.not.have.been.calledWith('change', getFixturePath('subdir/dir/ignored.txt'));
                if (!osXFsWatch) spy.callCount.should.equal(8);
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
        stdWatcher()
          .on('all', spy)
          .on('ready', d(function() {
            spy.should.have.been.calledWith('addDir', getFixturePath('link'));
            spy.should.have.been.calledWith('addDir', getFixturePath('link/dir'));
            spy.should.have.been.calledWith('add', getFixturePath('link/add.txt'));
            spy.should.not.have.been.calledWith('add', getFixturePath('link/dir/ignored.txt'));
            done();
          }, true));
      });
      it('should respect depth setting when following a new symlink', function(done) {
        if (os === 'win32') return done(); // skip on windows
        options.depth = 1;
        options.ignoreInitial = true;
        var spy = sinon.spy();
        var linkPath = getFixturePath('link');
        var dirPath = getFixturePath('link/dir');
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
            }, true));
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
              }, true));
          }, true));
      });
    });
  });
  describe('unwatch', function() {
    var watcher;
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
          watcher.unwatch([getFixturePath('subdir'), getFixturePath('unl*')]);
          fs.writeFileSync(getFixturePath('subdir/add.txt'), 'c');
          fs.writeFileSync(getFixturePath('change.txt'), 'c');
          fs.unlinkSync(getFixturePath('unlink.txt'));
          waitFor([spy], function() {
            spy.should.have.been.calledWith('change', getFixturePath('change.txt'));
            spy.should.not.have.been.calledWith('add');
            spy.should.not.have.been.calledWith('unlink');
            if (!osXFsWatch) spy.should.have.been.calledOnce;
            done();
          });
        }, true));
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
