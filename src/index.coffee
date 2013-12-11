'use strict'

{EventEmitter} = require 'events'
fs = require 'fs'
os = require 'os'
sysPath = require 'path'
isBinary = require './is-binary'
try
  fsevents = require 'fsevents'
  recursiveReaddir = require 'recursive-readdir'
catch
  fsevents = null
  recursiveReaddir = null

nodeVersion = process.versions.node.substring(0, 3)

createFSEventsInstance = (path, callback) ->
  watcher = new fsevents.FSEvents path
  watcher.on 'fsevent', callback
  watcher

directoryEndRe = /[\\\/]$/

isDarwin = os.platform() is 'darwin'

# Helloo, I am coffeescript file.
# Chokidar is written in coffee because it uses OOP.
# JS is fucking horrible with OOP. At least until ES6.

# Watches files & directories for changes.
#
# Emitted events: `add`, `change`, `unlink`, `error`.
#
# Examples
#
#   var watcher = new FSWatcher()
#     .add(directories)
#     .on('add', function(path) {console.log('File', path, 'was added');})
#     .on('change', function(path) {console.log('File', path, 'was changed');})
#     .on('unlink', function(path) {console.log('File', path, 'was removed');})
#
exports.FSWatcher = class FSWatcher extends EventEmitter
  constructor: (options = {}) ->
    super
    @watched = Object.create(null)
    @watchers = []

    # Set up default options.
    options.persistent ?= false
    options.ignoreInitial ?= false
    options.ignorePermissionErrors ?= false
    options.interval ?= 100
    options.binaryInterval ?= 300
    options.usePolling ?= false
    options.useFsEvents ?= not options.usePolling and isDarwin

    @enableBinaryInterval = options.binaryInterval isnt options.interval

    @_isIgnored = do (ignored = options.ignored) ->
      switch toString.call ignored
        when '[object RegExp]' then (string) -> ignored.test string
        when '[object Function]' then ignored
        else -> false

    @options = options

    # You’re frozen when your heart’s not open.
    Object.freeze options

  _getWatchedDir: (directory) ->
    dir = directory.replace(directoryEndRe, '')
    @watched[dir] ?= []

  _addToWatchedDir: (directory, basename) ->
    watchedFiles = @_getWatchedDir directory
    watchedFiles.push basename

  _removeFromWatchedDir: (directory, file) ->
    watchedFiles = @_getWatchedDir directory
    watchedFiles.some (watchedFile, index) ->
      if watchedFile is file
        watchedFiles.splice(index, 1)
        yes

  # Private: Check for read permissions
  # Based on this answer on SO: http://stackoverflow.com/a/11781404/1358405
  #
  # stats - fs.Stats object
  #
  # Returns Boolean
  _hasReadPermissions: (stats) ->
    Boolean (4 & parseInt (stats.mode & 0o777).toString(8)[0])

  # Private: Handles emitting unlink events for
  # files and directories, and via recursion, for
  # files and directories within directories that are unlinked
  #
  # directory - string, directory within which the following item is located
  # item      - string, base path of item/directory
  #
  # Returns nothing.
  _remove: (directory, item) ->
    # if what is being deleted is a directory, get that directory's paths
    # for recursive deleting and cleaning of watched object
    # if it is not a directory, nestedDirectoryChildren will be empty array
    fullPath = sysPath.join(directory, item)

    # Check if it actually is a directory
    isDirectory = @watched[fullPath]

    # This will create a new entry in the watched object in either case
    # so we got to do the directory check beforehand
    nestedDirectoryChildren = @_getWatchedDir(fullPath).slice()

    # Remove directory / file from watched list.
    @_removeFromWatchedDir directory, item

    # Recursively remove children directories / files.
    nestedDirectoryChildren.forEach (nestedItem) =>
      @_remove fullPath, nestedItem

    fs.unwatchFile fullPath if @options.usePolling

    # The Entry will either be a directory that just got removed
    # or a bogus entry to a file, in either case we have to remove it
    delete @watched[fullPath]

    if isDirectory
      @emit 'unlinkDir', fullPath
    else
      @emit 'unlink', fullPath

  _watchWithFsEvents: (path) ->
    watcher = createFSEventsInstance path, (path, flags) =>
      return if @_isIgnored path
      info = fsevents.getInfo path, flags
      emit = (event) =>
        name = if info.type is 'file' then event else "#{event}Dir"
        if event is 'add' or event is 'addDir'
          @_addToWatchedDir sysPath.dirname(path), sysPath.basename(path)
        else if event is 'unlink' or event is 'unlinkDir'
          @_remove sysPath.dirname(path), sysPath.basename(path)
          return # Do not “emit” event twice.
        @emit name, path

      switch info.event
        when 'created' then emit 'add'
        when 'modified' then emit 'change'
        when 'deleted' then emit 'unlink'
        when 'moved'
          fs.stat path, (error, stats) =>
            emit (if error or not stats then 'unlink' else 'add')
    @watchers.push watcher

  # Private: Watch file for changes with fs.watchFile or fs.watch.
  #
  # item     - string, path to file or directory.
  # callback - function that will be executed on fs change.
  #
  # Returns nothing.
  _watch: (item, callback = (->)) ->
    directory = sysPath.dirname(item)
    basename = sysPath.basename(item)
    parent = @_getWatchedDir directory
    # Prevent memory leaks.
    return if parent.indexOf(basename) isnt -1
    @_addToWatchedDir directory, basename

    options = {persistent: @options.persistent}
    if @options.usePolling
      options.interval = if @enableBinaryInterval and isBinary basename
        @options.binaryInterval
      else
        @options.interval
      fs.watchFile item, options, (curr, prev) ->
        callback item, curr if curr.mtime.getTime() > prev.mtime.getTime()
    else
      watcher = fs.watch item, options, (event, path) ->
        callback item
      @watchers.push watcher

  # Private: Emit `change` event once and watch file to emit it in the future
  # once the file is changed.
  #
  # file       - string, fs path.
  # stats      - object, result of executing stat(1) on file.
  # initialAdd - boolean, was the file added at the launch?
  #
  # Returns nothing.
  _handleFile: (file, stats, initialAdd = no) ->
    @_watch file, (file, newStats) =>
      @emit 'change', file, newStats
    @emit 'add', file, stats unless initialAdd and @options.ignoreInitial

  # Private: Read directory to add / remove files from `@watched` list
  # and re-read it on change.
  #
  # directory - string, fs path.
  #
  # Returns nothing.
  _handleDir: (directory, stats, initialAdd) ->
    read = (directory, initialAdd) =>
      fs.readdir directory, (error, current) =>
        return @emit 'error', error if error?
        return unless current
        previous = @_getWatchedDir(directory)

        # Files that absent in current directory snapshot
        # but present in previous emit `remove` event
        # and are removed from @watched[directory].
        previous
          .filter (file) =>
            current.indexOf(file) is -1
          .forEach (file) =>
            @_remove directory, file

        # Files that present in current directory snapshot
        # but absent in previous are added to watch list and
        # emit `add` event.
        current
          .filter (file) =>
            previous.indexOf(file) is -1
          .forEach (file) =>
            @_handle sysPath.join(directory, file), initialAdd

    read directory, initialAdd
    @_watch directory, (dir) -> read dir, no
    @emit 'addDir', directory, stats unless initialAdd and @options.ignoreInitial

  # Private: Handle added file or directory.
  # Delegates call to _handleFile / _handleDir after checks.
  #
  # item - string, path to file or directory.
  #
  # Returns nothing.
  _handle: (item, initialAdd) ->
    # Don't handle invalid files, dotfiles etc.
    return if @_isIgnored item

    # Get the canonicalized absolute pathname.
    fs.realpath item, (error, path) =>
      return if error and error.code is 'ENOENT'
      return @emit 'error', error if error?
      # Get file info, check is it file, directory or something else.
      fs.stat path, (error, stats) =>
        return @emit 'error', error if error?
        if @options.ignorePermissionErrors and (not @_hasReadPermissions stats)
          return

        return if @_isIgnored.length is 2 and @_isIgnored item, stats

        @_handleFile item, stats, initialAdd if stats.isFile()
        @_handleDir item, stats, initialAdd if stats.isDirectory()

  emit: (event, args...) ->
    super event, args...
    if (event is 'add' or event is 'addDir' or event is 'change' or
    event is 'unlink' or event is 'unlinkDir')
      super 'all', event, args...

  _addToFsEvents: (files) ->
    handle = (path) =>
      @emit 'add', path
    files.forEach (file) =>
      unless @options.ignoreInitial
        fs.stat file, (error, stats) =>
          return @emit 'error', error if error?
          if stats.isDirectory()
            recursiveReaddir file, (error, dirFiles) =>
              return @emit 'error', error if error?
              dirFiles
                .filter (path) =>
                  not @_isIgnored path
                .forEach handle
          else
            handle file
      @_watchWithFsEvents file
    this

  # Public: Adds directories / files for tracking.
  #
  # * files - array of strings (file paths).
  #
  # Examples
  #
  #   add ['app', 'vendor']
  #
  # Returns an instance of FSWatcher for chaning.
  add: (files) ->
    @_initialAdd ?= true
    files = [files] unless Array.isArray files
    return @_addToFsEvents files if @options.useFsEvents
    files.forEach (file) => @_handle file, @_initialAdd
    @_initialAdd = false
    this

  # Public: Remove all listeners from watched files.
  # Returns an instance of FSWatcher for chaning.
  close: =>
    @watchers.forEach (watcher) =>
      if @options.useFsEvents
        watcher.stop()
      else
        watcher.close()

    if @options.usePolling
      Object.keys(@watched).forEach (directory) =>
        @watched[directory].forEach (file) =>
          fs.unwatchFile sysPath.join(directory, file)
    @watched = Object.create(null)
    @removeAllListeners()
    this

exports.watch = (files, options) ->
  new FSWatcher(options).add(files)
