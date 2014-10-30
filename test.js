'use strict';

var chokidar = require('./');
var chai = require('chai');
var expect = chai.expect;
var should = chai.should();
var sinon = require('sinon');
chai.use(require('sinon-chai'));
var fs = require('fs');
var sysPath = require('path');

function getFixturePath (subPath) {
  return sysPath.join(__dirname, 'test-fixtures', subPath);
}

var fixturesPath = getFixturePath('');

before(function() {
  try {fs.mkdirSync(fixturesPath, 0x1ed);} catch(err) {}
});

after(function() {
  try {fs.unlinkSync(getFixturePath('change.txt'));} catch(err) {}
  try {fs.unlinkSync(getFixturePath('unlink.txt'));} catch(err) {}
  try {fs.rmdirSync(fixturesPath, 0x1ed);} catch(err) {}
});

describe('chokidar', function() {
  it('should expose public API methods', function() {
    chokidar.FSWatcher.should.be.a('function');
    chokidar.watch.should.be.a('function');
  });

  describe('fsevents', runTests.bind(this, {useFsEvents: true}));
  describe('non-polling', runTests.bind(this, {usePolling: false, useFsEvents: false}));
  describe('polling', runTests.bind(this, {usePolling: true}));
});

function runTests (options) {
  if (!options) options = {};

  var delayTime = options.usePolling ? 350 : options.useFsEvents ? 205 : 250;
  function delay (fn) { return setTimeout(fn, delayTime); }
  function ddelay (fn) { return setTimeout(fn, delayTime * (options.usePolling ? 3 : 1)); }

  options.persistent = true;

  describe('watch', function() {
    beforeEach(function(done) {
      this.watcher = chokidar.watch(fixturesPath, options);
      delay(done);
    });
    afterEach(function(done) {
      this.watcher.close();
      delete this.watcher;
      delay(done);
    });
    before(function(done) {
      try {fs.unlinkSync(getFixturePath('add.txt'));} catch(err) {}
      try {fs.unlinkSync(getFixturePath('moved.txt'));} catch(err) {}
      try {fs.unlinkSync(getFixturePath('subdir/add.txt'));} catch(err) {}
      try {fs.rmdirSync(getFixturePath('subdir'));} catch(err) {}
      fs.writeFileSync(getFixturePath('change.txt'), 'b');
      fs.writeFileSync(getFixturePath('unlink.txt'), 'b');
      delay(done);
    });
    after(function() {
      try {fs.unlinkSync(getFixturePath('add.txt'));} catch(err) {}
      try {fs.unlinkSync(getFixturePath('moved.txt'));} catch(err) {}
      fs.writeFileSync(getFixturePath('change.txt'), 'a');
      fs.writeFileSync(getFixturePath('unlink.txt'), 'a');
    });
    it('should produce an instance of chokidar.FSWatcher', function() {
      this.watcher.should.be.an["instanceof"](chokidar.FSWatcher);
    });
    it('should expose public API methods', function() {
      this.watcher.on.should.be.a('function');
      this.watcher.emit.should.be.a('function');
      this.watcher.add.should.be.a('function');
      this.watcher.close.should.be.a('function');
    });
    it('should emit `add` event when file was added', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      this.watcher.on('add', spy);
      delay(function() {
        spy.should.not.have.been.called;
        fs.writeFileSync(testPath, 'hello');
        delay(function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          done();
        });
      });
    });
    it('should emit `addDir` event when directory was added', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      this.watcher.on('addDir', spy);
      delay(function() {
        spy.should.not.have.been.called;
        fs.mkdirSync(testDir, 0x1ed);
        delay(function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testDir);
          done();
        });
      });
    });
    it('should emit `change` event when file was changed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      this.watcher.on('change', spy);
      delay(function() {
        spy.should.not.have.been.called;
        fs.writeFileSync(testPath, 'c');
        delay(function() {
          // prevent stray unpredictable fs.watch events from making test fail
          if (options.usePolling || options.useFsEvents) {
            spy.should.have.been.calledOnce;
          }
          spy.should.have.been.calledWith(testPath);
          done();
        });
      });
    });
    it('should emit `unlink` event when file was removed', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      this.watcher.on('unlink', spy);
      delay(function() {
        spy.should.not.have.been.called;
        fs.unlinkSync(testPath);
        delay(function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          done();
        });
      });
    });
    it('should emit `unlinkDir` event when a directory was removed', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      this.watcher.on('unlinkDir', spy);
      delay(function() {
        fs.rmdirSync(testDir);
        delay(function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testDir);
          done();
        });
      });
    });
    it('should emit `unlink` and `add` events when a file is renamed', function(done) {
      var unlinkSpy = sinon.spy(function unlink(){});
      var addSpy = sinon.spy(function add(){});
      var testPath = getFixturePath('change.txt');
      var newPath = getFixturePath('moved.txt');
      this.watcher.on('unlink', unlinkSpy);
      this.watcher.on('add', addSpy);
      delay(function() {
        unlinkSpy.should.not.have.been.called;
        addSpy.should.not.have.been.called;
        fs.renameSync(testPath, newPath);
        delay(function() {
          unlinkSpy.should.have.been.calledOnce;
          unlinkSpy.should.have.been.calledWith(testPath);
          addSpy.should.have.been.calledOnce;
          addSpy.should.have.been.calledWith(newPath);
          fs.renameSync(newPath, testPath);
          done();
        });
      });
    });
    it('should survive ENOENT for missing subdirectories', function() {
      var testDir;
      testDir = getFixturePath('subdir');
      this.watcher.add(testDir);
    });
    it('should notice when a file appears in a new directory', function(done) {
      var spy = sinon.spy();
      var testDir = getFixturePath('subdir');
      var testPath = getFixturePath('subdir/add.txt');
      this.watcher.on('add', spy);
      delay(function() {
        spy.should.not.have.been.callled;
        fs.mkdirSync(testDir, 0x1ed);
        fs.writeFileSync(testPath, 'hello');
        delay(function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(testPath);
          done();
        });
      });
    });
  });
  describe('watch individual files', function() {
    function clean(done) {
      fs.writeFileSync(getFixturePath('change.txt'), 'b');
      fs.writeFileSync(getFixturePath('unlink.txt'), 'b');
      try {fs.unlinkSync(getFixturePath('add.txt'));} catch(err) {}
      delay(done);
    }
    beforeEach(clean);
    after(clean);
    it('should detect changes', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('change.txt');
      var watcher = chokidar.watch(testPath, options).on('change', spy);
      ddelay(function() {
        fs.writeFileSync(testPath, 'c');
        delay(function() {
          watcher.close();
          spy.should.have.always.been.calledWith(testPath);
          done();
        });
      });
    });
    it('should detect unlinks', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('unlink.txt');
      var watcher = chokidar.watch(testPath, options).on('unlink', spy);
      delay(function() {
        fs.unlinkSync(testPath);
        delay(function() {
          spy.should.have.been.calledWith(testPath);
          watcher.close();
          done();
        });
      });
    });
    it('should watch non-existent file and detect add', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      var watcher = chokidar.watch(testPath, options).on('add', spy);
      // polling takes a bit longer here
      ddelay(function() {
        fs.writeFileSync(testPath, 'a');
        delay(function() {
          spy.should.have.been.calledWith(testPath);
          watcher.close();
          done();
        });
      });
    });
    it('should detect unlink and re-add', function(done) {
      var unlinkSpy = sinon.spy(function unlink(){});
      var addSpy = sinon.spy(function add(){});
      var testPath = getFixturePath('unlink.txt');
      var watcher = chokidar.watch(testPath, options)
        .on('unlink', unlinkSpy).on('add', addSpy);
      delay(function() {
        fs.unlinkSync(testPath);
        delay(function() {
          unlinkSpy.should.have.been.calledWith(testPath);
          delay(function() {
            addSpy.should.have.been.calledWith(testPath);
            watcher.close();
            done();
          });
        });
      });
    });
    it('should ignore unwatched siblings', function(done) {
      var spy = sinon.spy();
      var testPath = getFixturePath('add.txt');
      var siblingPath = getFixturePath('change.txt');
      var watcher = chokidar.watch(testPath, options).on('all', spy);
      delay(function() {
        fs.writeFileSync(siblingPath, 'c');
        delay(function() {
          spy.should.not.have.been.called;
          fs.writeFileSync(testPath, 'a');
          delay(function() {
            spy.should.have.been.calledWith('add', testPath);
            watcher.close();
            done();
          });
        });
      });
    });
  });
  describe('watch options', function() {
    function clean (done) {
      try {fs.unlinkSync(getFixturePath('subdir/add.txt'));} catch(err) {}
      try {fs.unlinkSync(getFixturePath('subdir/dir/ignored.txt'));} catch(err) {}
      try {fs.rmdirSync(getFixturePath('subdir/dir'));} catch(err) {}
      try {fs.rmdirSync(getFixturePath('subdir'));} catch(err) {}
      delay(done);
    }
    beforeEach(clean);
    after(clean);
    describe('ignoreInitial:true', function() {
      before(function() { options.ignoreInitial = true; });
      after(function() { delete options.ignoreInitial; });
      it('should ignore inital add events', function(done) {
        var spy = sinon.spy();
        var watcher = chokidar.watch(fixturesPath, options);
        watcher.on('add', spy);
        delay(function() {
          watcher.close();
          spy.should.not.have.been.called;
          done();
        });
      });
      it('should notice when a file appears in an empty directory', function(done) {
        var spy = sinon.spy();
        var testDir = getFixturePath('subdir');
        var testPath = getFixturePath('subdir/add.txt');
        var watcher = chokidar.watch(fixturesPath, options);
        watcher.on('add', spy);
        delay(function() {
          spy.should.not.have.been.called;
          fs.mkdirSync(testDir, 0x1ed);
          watcher.add(testDir);
          fs.writeFileSync(testPath, 'hello');
          delay(function() {
            watcher.close();
            spy.should.have.been.calledOnce;
            spy.should.have.been.calledWith(testPath);
            done();
          });
        });
      });
    });
    describe('ignoreInitial:false', function() {
      var watcher;
      before(function() { options.ignoreInitial = false; });
      afterEach(function() { watcher.close(); });
      after(function() { delete options.ignoreInitial; });
      it('should emit `add` events for preexisting files', function(done) {
        var spy = sinon.spy();
        watcher = chokidar.watch(fixturesPath, options).on('add', spy);
        delay(function() {
          spy.should.have.been.calledTwice;
          done();
        });
      });
      it('should emit `addDir` event for watched dir', function(done) {
        var spy = sinon.spy();
        watcher = chokidar.watch(fixturesPath, options).on('addDir', spy);
        delay(function() {
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(fixturesPath);
          done();
        });
      });
      it('should emit `addDir` events for preexisting dirs', function(done) {
        var spy = sinon.spy();
        fs.mkdirSync(getFixturePath('subdir'), 0x1ed);
        fs.mkdirSync(getFixturePath('subdir/dir'), 0x1ed);
        delay(function() {
          watcher = chokidar.watch(fixturesPath, options).on('addDir', spy);
          delay(function(){
            spy.should.have.been.calledThrice;
            done();
          });
        });
      });
    });
    describe('ignored', function() {
      after(function() { delete options.ignored; });
      it('should check ignore after stating', function(done) {
        var testDir = getFixturePath('subdir');
        var spy = sinon.spy();
        function ignoredFn(path, stats) {
          if (path === testDir || !stats) return false;
          return stats.isDirectory();
        }
        options.ignored = ignoredFn;
        var watcher = chokidar.watch(testDir, options);
        watcher.on('add', spy);
        try {fs.mkdirSync(testDir, 0x1ed);} catch(err) {}
        fs.writeFileSync(testDir + '/add.txt', '');
        fs.mkdirSync(testDir + '/dir', 0x1ed);
        fs.writeFileSync(testDir + '/dir/ignored.txt', '');
        delay(function() {
          watcher.close();
          spy.should.have.been.calledOnce;
          spy.should.have.been.calledWith(sysPath.join(testDir, 'add.txt'));
          done();
        });
      });
    });
  });

  describe('close', function() {
    before(function() {
      try {fs.unlinkSync(getFixturePath('add.txt'));} catch(err) {}
    });
    after(function() {
      this.watcher.close();
      try {fs.unlinkSync(getFixturePath('add.txt'));} catch(err) {}
    });
    it('should ignore further events on close', function(done) {
      var watcher = this.watcher = chokidar.watch(fixturesPath, options);
      var spy = sinon.spy();
      watcher.once('add', function() {
        watcher.once('add', function() {
          watcher.close();
          delay(function() {
            watcher.on('add', spy);
            fs.writeFileSync(getFixturePath('add.txt'), 'hello world');
            delay(function() {
              spy.should.not.have.been.called;
              done();
            });
          });
        });
      });
      fs.writeFileSync(getFixturePath('add.txt'), 'hello world');
      fs.unlinkSync(getFixturePath('add.txt'));
    });
  });
}

describe('is-binary', function() {
  var isBinary = chokidar.isBinaryPath;
  it('should be a function', function() {
    isBinary.should.be.a('function');
  });
  it('should correctly determine binary files', function() {
    isBinary('a.jpg').should.equal(true);
    isBinary('a.jpeg').should.equal(true);
    isBinary('a.zip').should.equal(true);
    isBinary('ajpg').should.equal(false);
    isBinary('a.txt').should.equal(false);
  });
});
