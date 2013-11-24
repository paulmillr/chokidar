chokidar = require '..'
isBinary = require '../lib/is-binary'
fs = require 'fs'
sysPath = require 'path'
rimraf = require 'rimraf'

getFixturePath = (subPath) ->
  sysPath.join __dirname, 'fixtures', subPath

fixturesPath = getFixturePath ''
delay = (fn) ->
  setTimeout fn, 200

describe 'chokidar', ->
  it 'should expose public API methods', ->
    chokidar.FSWatcher.should.be.a 'function'
    chokidar.watch.should.be.a 'function'

  describe 'watch', ->
    options = {}

    beforeEach (done) ->
      try rimraf.sync getFixturePath ''
      fs.mkdirSync getFixturePath ''
      fs.writeFileSync (getFixturePath 'change.txt'), 'b'
      fs.writeFileSync (getFixturePath 'unlink.txt'), 'b'
      fs.mkdirSync (getFixturePath 'subdir')
      setTimeout =>
        @watcher = chokidar.watch fixturesPath, options
        setTimeout done, 300
      , 1500

    afterEach (done) ->
      @watcher.close()
      delete @watcher
      rimraf.sync getFixturePath ''
      delay ->
        done()

    it 'should produce an instance of chokidar.FSWatcher', ->
      @watcher.should.be.an.instanceof chokidar.FSWatcher

    it 'should expose public API methods', ->
      @watcher.on.should.be.a 'function'
      @watcher.emit.should.be.a 'function'
      @watcher.add.should.be.a 'function'
      @watcher.close.should.be.a 'function'

    it 'should emit `add` event when file was added', (done) ->
      spy = sinon.spy()
      testPath = getFixturePath 'add.txt'

      @watcher.on 'add', spy

      delay =>
        spy.should.not.have.been.called
        fs.writeFileSync testPath, 'hello'
        delay =>
          spy.should.have.been.calledOnce
          spy.should.have.been.calledWith testPath
          done()

    it.only 'should emit `change` event when file was changed', (done) ->
      spy = sinon.spy()
      testPath = getFixturePath 'change.txt'

      @watcher.on 'change', spy

      delay =>
        spy.should.not.have.been.called
        fs.writeFileSync testPath, 'c'
        delay =>
          spy.should.have.been.calledOnce
          spy.should.have.been.calledWith testPath
          done()

    it 'should emit `unlink` event when file was removed', (done) ->
      spy = sinon.spy()
      testPath = getFixturePath 'unlink.txt'

      @watcher.on 'unlink', ->
        console.error 124
        spy testPath
      console.error 13515, fs.existsSync testPath

      delay =>
        spy.should.not.have.been.called
        fs.unlinkSync testPath
        console.error 13515, fs.existsSync testPath
        delay =>
          spy.should.have.been.calledOnce
          spy.should.have.been.calledWith testPath
          done()

    # it 'should not emit `unlink` event when a empty directory was removed', (done) ->
    #   spy = sinon.spy()
    #   testDir = getFixturePath 'subdir'

    #   @watcher.on 'unlink', spy

    #   delay =>
    #     fs.mkdirSync testDir, 0o755
    #     fs.rmdirSync testDir
    #     delay =>
    #       spy.should.not.have.been.called
    #       done()

    # it 'should survive ENOENT for missing subdirectories', ->
    #   testDir = getFixturePath 'subdir'

    #   @watcher.add testDir

    it 'should notice when a file appears in a new directory', (done) ->
      spy = sinon.spy()
      testDir = getFixturePath 'subdir'
      testPath = getFixturePath 'subdir/add.txt'

      @watcher.on 'add', spy
      @watcher.add testDir

      delay =>
        spy.should.not.have.been.callled
        fs.writeFileSync testPath, 'hello'
        delay =>
          spy.should.have.been.calledOnce
          spy.should.have.been.calledWith testPath
          done()


  describe 'watch options', ->
    describe 'ignoreInitial', ->
      options = { ignoreInitial: yes }

      before (done) ->
        try fs.unlinkSync getFixturePath('subdir/add.txt')
        try fs.unlinkSync getFixturePath('subdir/dir/ignored.txt')
        try fs.rmdirSync getFixturePath('subdir/dir')
        try fs.rmdirSync getFixturePath('subdir')
        done()

      after (done) ->
        try fs.unlinkSync getFixturePath('subdir/add.txt')
        try fs.unlinkSync getFixturePath('subdir/dir/ignored.txt')
        try fs.rmdirSync getFixturePath('subdir/dir')
        try fs.rmdirSync getFixturePath('subdir')
        done()

      it 'should ignore inital add events', (done) ->
        spy = sinon.spy()
        watcher = chokidar.watch fixturesPath, options
        watcher.on 'add', spy
        delay =>
          spy.should.not.have.been.called
          watcher.close()
          done()

      it 'should notice when a file appears in an empty directory', (done) ->
        spy = sinon.spy()
        testDir = getFixturePath 'subdir'
        testPath = getFixturePath 'subdir/add.txt'

        watcher = chokidar.watch fixturesPath, options
        watcher.on 'add', spy

        delay =>
          spy.should.not.have.been.called
          watcher.add testDir

          fs.writeFileSync testPath, 'hello'
          delay =>
            spy.should.have.been.calledOnce
            spy.should.have.been.calledWith testPath
            done()

      it 'should check ignore after stating', (done) ->
        testDir = getFixturePath 'subdir'
        spy = sinon.spy()

        ignoredFn = (path, stats) ->
          return no if path is testDir or not stats
          # ignore directories
          return stats.isDirectory()

        watcher = chokidar.watch testDir, {ignored: ignoredFn}
        watcher.on 'add', spy

        try fs.mkdirSync testDir, 0o755
        fs.writeFileSync testDir + '/add.txt', ''         # this file should be added
        fs.mkdirSync testDir + '/dir', 0o755              # this dir will be ignored
        fs.writeFileSync testDir + '/dir/ignored.txt', '' # so this file should be ignored

        delay =>
          spy.should.have.been.calledOnce
          spy.should.have.been.calledWith testDir + '/add.txt'
          done()


describe 'is-binary', ->
  it 'should be a function', ->
    isBinary.should.be.a 'function'

  it 'should correctly determine binary files', ->
    isBinary('a.jpg').should.equal yes
    isBinary('a.jpeg').should.equal yes
    isBinary('a.zip').should.equal yes
    isBinary('ajpg').should.equal no
    isBinary('a.txt').should.equal no
