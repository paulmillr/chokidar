'use strict'

{EventEmitter} = require 'events'
fs = require 'fs'
sysPath = require 'path'

nodeVersion = process.versions.node.substring(0, 3)

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
  constructor: (@options = {}) ->
    @watched = Object.create(null)
    @watchers = []
    @options.persistent ?= no
    @_ignored = do =>
      switch toString.call(@options.ignored)
        when '[object RegExp]' then (string) -> @options.ignored.test(string)
        when '[object Function]' then @options.ignored
        else -> no

  _getWatchedDir: (directory) =>
    dir = directory.replace(/[\\\/]$/, '')
    @watched[dir] ?= []

  _addToWatchedDir: (directory, file) =>
    watchedFiles = @_getWatchedDir directory
    watchedFiles.push file

  _removeFromWatchedDir: (directory, file) =>
    watchedFiles = @_getWatchedDir directory
    watchedFiles.some (watchedFile, index) =>
      if watchedFile is file
        watchedFiles.splice(index, 1)
        yes

  # Private: Handles emitting unlink events for
  # files and directories, and via recursion, for
  # files and directories within directories that are unlinked
  #
  # directory - string, directory within which the following item is located
  # item      - string, base path of item/directory
  #
  # Returns nothing.
  _remove: (directory, item) =>
    # if what is being deleted is a directory, get that directory's paths
    # for recursive deleting and cleaning of watched object
    # if it is not a directory, nestedDirectoryChildren will be empty array
    fullPath = sysPath.join(directory, item)
    nestedDirectoryChildren = @_getWatchedDir(fullPath).slice()

    # Remove directory / file from watched list.
    @_removeFromWatchedDir directory, item

    # Recursively remove children directories / files.
    nestedDirectoryChildren.forEach (nestedItem) =>
      @_remove fullPath, nestedItem
    fs.unwatchFile fullPath
    @emit 'unlink', fullPath

  # Private: Watch file for changes with fs.watchFile or fs.watch.
  #
  # item     - string, path to file or directory.
  # callback - function that will be executed on fs change.
  #
  # Returns nothing.
  _watch: (item, itemType, callback = (->)) =>
    directory = sysPath.dirname(item)
    basename = sysPath.basename(item)
    parent = @_getWatchedDir directory
    options = {persistent: @options.persistent}
  
    # Prevent memory leaks.
    return if parent.indexOf(basename) >= 0

    @_addToWatchedDir directory, basename
    if process.platform is 'win32' and nodeVersion is '0.6'
      watcher = fs.watch item, options, (event, path) =>
        callback item
      @watchers.push watcher
    else
      options.interval = 100
      fs.watchFile item, options, (curr, prev) =>
        callback item if curr.mtime.getTime() isnt prev.mtime.getTime()
    @emit 'add', item if itemType is 'file'

  # Private: Emit `change` event once and watch file to emit it in the future
  # once the file is changed.
  #
  # file - string, fs path.
  #
  # Returns nothing.
  _handleFile: (file) =>
    @_watch file, 'file', (file) =>
      @emit 'change', file

  # Private: Read directory to add / remove files from `@watched` list
  # and re-read it on change.
  #
  # directory - string, fs path.
  #
  # Returns nothing.
  _handleDir: (directory) =>
    read = (directory) =>
      fs.readdir directory, (error, current) =>
        return @emit 'error', error if error?
        return unless current
        previous = @_getWatchedDir(directory)

        # Files that absent in current directory snapshot
        # but present in previous emit `remove` event
        # and are removed from @watched[directory].
        previous
          .filter (file) =>
            current.indexOf(file) < 0
          .forEach (file) =>
            @_remove directory, file

        # Files that present in current directory snapshot
        # but absent in previous are added to watch list and
        # emit `add` event.
        current
          .filter (file) =>
            previous.indexOf(file) < 0
          .forEach (file) =>
            @_handle sysPath.join(directory, file)

    read directory
    @_watch directory, 'directory', read

  # Private: Handle added file or directory.
  # Delegates call to _handleFile / _handleDir after checks.
  #
  # item - string, path to file or directory.
  #
  # Returns nothing.
  _handle: (item) =>
    # Don't handle invalid files, dotfiles etc.
    return if @_ignored item

    # Get the canonicalized absolute pathname.
    fs.realpath item, (error, path) =>
      return @emit 'error', error if error?
      # Get file info, check is it file, directory or something else.
      fs.stat item, (error, stats) =>
        return @emit 'error', error if error?
        @_handleFile item if stats.isFile()
        @_handleDir item if stats.isDirectory()

  emit: (event, args...) ->
    super
    super 'all', event, args... if event in ['add', 'change', 'unlink']

  # Public: Adds directories / files for tracking.
  #
  # * files - array of strings (file paths).
  #
  # Examples
  #
  #   add ['app', 'vendor']
  #
  # Returns an instance of FSWatcher for chaning.
  add: (files) =>
    files = [files] unless Array.isArray files
    files.forEach @_handle
    this

  # Public: Remove all listeners from watched files.
  # Returns an instance of FSWatcher for chaning.
  close: =>
    @watchers.forEach (watcher) -> watcher.close()
    Object.keys(@watched).forEach (directory) =>
      @watched[directory].forEach (file) =>
        fs.unwatchFile sysPath.join(directory, file)
    @watched = Object.create(null)
    this

exports.watch = (files, options) ->
  new FSWatcher(options).add(files)
