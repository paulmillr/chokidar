{EventEmitter} = require 'events'
fs = require 'fs'
sysPath = require 'path'

# Watches files & directories for changes.
#
# Emitted events: `add`, `change`, `unlink`, `error`.
# 
# Examples
# 
#   watcher = (new FSWatcher)
#     .add(directories)
#     .on('change', (path) -> console.log 'File', path, 'was added / changed')
#     .on('unlink', (path) -> console.log 'File', path, 'was removed')
# 
class FSWatcher extends EventEmitter
  # Files that wouldn't be watched.

  constructor: (files, @options = {}) ->
    @watched = {}
    @watchers = []
    @options.persistent ?= no
    @_ignored = switch toString.call(options.ignored)
      when '[object RegExp]'
        (string) -> options.ignored.test(string)
      when '[object Function]'
        options.ignored
      else
        (-> no)
    @add(files)

  _getWatchedDir: (directory) ->
    @watched[directory] ?= []

  # Private: Watch file for changes with fs.watchFile or fs.watch.
  # 
  # item     - string, path to file or directory.
  # callback - function that will be executed on fs change.
  # 
  # Returns nothing.
  _watch: (item, callback) ->
    parent = @_getWatchedDir sysPath.dirname item
    basename = sysPath.basename item
    # Prevent memory leaks.
    return if basename in parent
    parent.push basename
    # @watchers.push fs.watch item, persistent: yes, =>
    #   callback? item
    if process.platform is 'win32'
      @watchers.push fs.watch item, persistent: @options.persistent, =>
        callback? item
    else
      options = persistent: @options.persistent, interval: 100
      fs.watchFile item, options, (curr, prev) =>
        callback item if curr.mtime.getTime() isnt prev.mtime.getTime()

  # Private: Emit `change` event once and watch file to emit it in the future
  # once the file is changed.
  # 
  # file - string, fs path.
  # 
  # Returns nothing.
  _handleFile: (file) ->
    @_watch file, (file) =>
      @emit 'change', file
    @emit 'add', file

  # Private: Read directory to add / remove files from `@watched` list
  # and re-read it on change.
  # 
  # directory - string, fs path.
  # 
  # Returns nothing.
  _handleDir: (directory) ->
    read = (directory) =>
      fs.readdir directory, (error, current) =>
        return @emit 'error', error if error?
        return unless current
        previous = @_getWatchedDir directory

        # Files that absent in current directory snapshot
        # but present in previous emit `remove` event
        # and are removed from @watched[directory].
        previous
          .filter (file) =>
            file not in current
          .forEach (file, index) =>
            path = sysPath.join directory, file
            previous.splice(index, 1)
            @emit 'unlink', path

        # Files that present in current directory snapshot
        # but absent in previous are added to watch list and
        # emit `add` event.
        current
          .filter (file) ->
            file not in previous
          .forEach (file) =>
            @_handle sysPath.join directory, file
    read directory
    @_watch directory, read

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
    files = [files] unless Array.isArray(files)
    files.forEach @_handle
    this

  # Public: Emit event. Delegates to superclass & also emits 'all' event.
  # 
  # * event   - event name.
  # * args... - event arguments.
  # 
  # Returns an instance of FSWatcher for chaning. 
  emit: (event, args...) ->
    super 'all', event, args...
    super
    this

  # Public: Call EventEmitter's event listening function.
  # Returns an instance of FSWatcher for chaning.
  on: ->
    super
    this

  # Public: Remove all listeners from watched files.
  # Returns an instance of FSWatcher for chaning.
  close: ->
    @watchers.forEach (watcher) =>
      watcher.close()
    Object.keys(@watched).forEach (directory) =>
      @watched[directory].forEach (file) =>
        fs.unwatchFile sysPath.join directory, file
    @watched = {}
    this

exports.watch = (files, options) ->
  new FSWatcher(files, options)
