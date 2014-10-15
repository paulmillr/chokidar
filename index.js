'use strict';
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var os = require('os');
var sysPath = require('path');

var fsevents, recursiveReaddir;
try {
  fsevents = require('fsevents');
  recursiveReaddir = require('recursive-readdir');
} catch (error) {}

var isWindows = os.platform() === 'win32';
var canUseFsEvents = os.platform() === 'darwin' && !!fsevents;

// To disable FSEvents completely.
// var canUseFsEvents = false;

// Binary file handling code.
var _binExts = ['adp', 'au', 'mid', 'mp4a', 'mpga', 'oga', 's3m', 'sil', 'eol', 'dra', 'dts', 'dtshd', 'lvp', 'pya', 'ecelp4800', 'ecelp7470', 'ecelp9600', 'rip', 'weba', 'aac', 'aif', 'caf', 'flac', 'mka', 'm3u', 'wax', 'wma', 'wav', 'xm', 'flac', '3gp', '3g2', 'h261', 'h263', 'h264', 'jpgv', 'jpm', 'mj2', 'mp4', 'mpeg', 'ogv', 'qt', 'uvh', 'uvm', 'uvp', 'uvs', 'dvb', 'fvt', 'mxu', 'pyv', 'uvu', 'viv', 'webm', 'f4v', 'fli', 'flv', 'm4v', 'mkv', 'mng', 'asf', 'vob', 'wm', 'wmv', 'wmx', 'wvx', 'movie', 'smv', 'ts', 'bmp', 'cgm', 'g3', 'gif', 'ief', 'jpg', 'jpeg', 'ktx', 'png', 'btif', 'sgi', 'svg', 'tiff', 'psd', 'uvi', 'sub', 'djvu', 'dwg', 'dxf', 'fbs', 'fpx', 'fst', 'mmr', 'rlc', 'mdi', 'wdp', 'npx', 'wbmp', 'xif', 'webp', '3ds', 'ras', 'cmx', 'fh', 'ico', 'pcx', 'pic', 'pnm', 'pbm', 'pgm', 'ppm', 'rgb', 'tga', 'xbm', 'xpm', 'xwd', 'zip', 'rar', 'tar', 'bz2', 'eot', 'ttf', 'woff'];

var binExts = Object.create(null);
_binExts.forEach(function(ext) { binExts[ext] = true; });

function isBinary(extension) {
  if (extension === '') return false;
  return !!binExts[extension];
}

function isBinaryPath(path) {
  return isBinary(sysPath.extname(path).slice(1));
}

exports.isBinaryPath = isBinaryPath;

// Main code.
//
// Watches files & directories for changes.
//
// Emitted events: `add`, `change`, `unlink`, `error`.
//
// Examples
//
//   var watcher = new FSWatcher()
//     .add(directories)
//     .on('add', function(path) {console.log('File', path, 'was added');})
//     .on('change', function(path) {console.log('File', path, 'was changed');})
//     .on('unlink', function(path) {console.log('File', path, 'was removed');})
//
function FSWatcher(_opts) {
  var opts = {};
  // in case _opts that is passed in is a frozen object
  if (_opts != null) for (var opt in _opts) opts[opt] = _opts[opt];
  this.watched = Object.create(null);
  this.watchers = [];
  this.closed = false;

  // Set up default options.
  if (opts.persistent == null) opts.persistent = false;
  if (opts.ignoreInitial == null) opts.ignoreInitial = false;
  if (opts.ignorePermissionErrors == null) opts.ignorePermissionErrors = false;
  if (opts.interval == null) opts.interval = 100;
  if (opts.binaryInterval == null) opts.binaryInterval = 300;
  this.enableBinaryInterval = opts.binaryInterval !== opts.interval;

  // Enable fsevents on OS X when polling is disabled.
  // Which is basically super fast watcher.
  if (opts.useFsEvents == null) opts.useFsEvents = !opts.usePolling;
  // If we can't use fs events, disable it in any case.
  if (!canUseFsEvents) opts.useFsEvents = false;

  // Use polling by default on Linux and Mac (if not using fsevents).
  // Disable polling on Windows.
  if (opts.usePolling == null && !opts.useFsEvents) opts.usePolling = !isWindows;

  this._isIgnored = (function(ignored) {
    switch (toString.call(ignored)) {
      case '[object RegExp]':
        return function(string) {
          return ignored.test(string);
        };
      case '[object Function]':
        return ignored;
      default:
        return function() {
          return false;
        };
    }
  })(opts.ignored);

  this.options = opts;

  // You’re frozen when your heart’s not open.
  Object.freeze(opts);
}

FSWatcher.prototype = Object.create(EventEmitter.prototype);

// Directory helpers
// -----------------
FSWatcher.prototype._getWatchedDir = function(directory) {
  var dir = directory.replace(/[\\\/]$/, '');
  if (!(dir in this.watched)) this.watched[dir] = [];
  return this.watched[dir];
};

FSWatcher.prototype._addToWatchedDir = function(directory, basename) {
  var watchedFiles = this._getWatchedDir(directory);
  watchedFiles.push(basename);
};

FSWatcher.prototype._removeFromWatchedDir = function(directory, file) {
  var watchedFiles = this._getWatchedDir(directory);
  watchedFiles.some(function(watchedFile, index) {
    if (watchedFile === file) return watchedFiles.splice(index, 1);
  });
};

// File helpers
// ------------

// Private: Check for read permissions
// Based on this answer on SO: http://stackoverflow.com/a/11781404/1358405
//
// stats - fs.Stats object
//
// Returns Boolean
FSWatcher.prototype._hasReadPermissions = function(stats) {
  return Boolean(4 & parseInt((stats.mode & 0x1ff).toString(8)[0]));
};

// Private: Handles emitting unlink events for
// files and directories, and via recursion, for
// files and directories within directories that are unlinked
//
// directory - string, directory within which the following item is located
// item      - string, base path of item/directory
//
// Returns nothing.
FSWatcher.prototype._remove = function(directory, item) {
  // if what is being deleted is a directory, get that directory's paths
  // for recursive deleting and cleaning of watched object
  // if it is not a directory, nestedDirectoryChildren will be empty array
  var fullPath = sysPath.join(directory, item);
  var absolutePath = sysPath.resolve(fullPath);
  var isDirectory = this.watched[fullPath];

  // prevent duplicate handling in case of arriving here nearly simultaneously
  // via multiple paths (such as _handleFile and _handleDir)
  var _removing = this._removing = this._removing || {};
  if (_removing[fullPath]) return;
  _removing[fullPath] = setTimeout(function() {
    delete _removing[fullPath];
  }, 5);

  // This will create a new entry in the watched object in either case
  // so we got to do the directory check beforehand
  var nestedDirectoryChildren = this._getWatchedDir(fullPath).slice();

  // Remove directory / file from watched list.
  this._removeFromWatchedDir(directory, item);

  // Recursively remove children directories / files.
  nestedDirectoryChildren.forEach(function(nestedItem) {
    this._remove(fullPath, nestedItem);
  }, this);

  if (this.options.usePolling) {
    fs.unwatchFile(absolutePath, this.listeners[absolutePath]);
    delete this.listeners[absolutePath];
  }

  // The Entry will either be a directory that just got removed
  // or a bogus entry to a file, in either case we have to remove it
  delete this.watched[fullPath];
  var eventName = isDirectory ? 'unlinkDir' : 'unlink';
  this.emit(eventName, fullPath);
};

// FS Events helper.
function createFSEventsInstance(path, callback) {
  return (new fsevents(path)).on('fsevent', callback).start();
}

FSWatcher.prototype._watchWithFsEvents = function(path) {
  if (this._isIgnored(path)) return;
  var _this = this;
  var watcher = createFSEventsInstance(path, function(path, flags) {
    var info = fsevents.getInfo(path, flags);

    // ensure directories are tracked
    var parent = sysPath.dirname(path);
    var item = sysPath.basename(path);
    var watchedDir = _this._getWatchedDir(
      info.type === 'directory' ? path : parent
    );

    function emit (event) {
      if (event === 'add') {
        _this._addToWatchedDir(parent, item);
      } else if (event === 'unlink') {
        _this._remove(parent, item);
        return; // Don't emit event twice.
      }
      var eventName = info.type === 'file' ? event : event + 'Dir';
      _this.emit(eventName, path);
    }

    // correct for wrong events emitted
    function addOrChange() {
      emit(watchedDir.indexOf(item) !== -1 ? 'change' : 'add');
    }
    var wrongEventFlags = [69888, 70400, 71424, 131328, 131840];
    if (wrongEventFlags.indexOf(flags) !== -1) {
      if (info.event === 'deleted') {
        fs.stat(path, function(error, stats) {
          if (stats) {
            addOrChange();
          } else {
            emit('unlink');
          }
        });
      } else {
        addOrChange();
      }
      return;
    }

    switch (info.event) {
      case 'created':
        return emit('add');
      case 'modified':
        return emit('change');
      case 'deleted':
        return emit('unlink');
      case 'moved':
        return fs.stat(path, function(error, stats) {
          emit(stats ? flags === 72960 ? 'change' : 'add' : 'unlink');
        });
    }
  });
  return this.watchers.push(watcher);
};

// Private: Watch file for changes with fs.watchFile or fs.watch.

// item     - string, path to file or directory.
// callback - function that will be executed on fs change.

// Returns nothing.
FSWatcher.prototype._watch = function(item, callback) {
  var directory = sysPath.dirname(item);
  var basename = sysPath.basename(item);
  var parent = this._getWatchedDir(directory);
  if (parent.indexOf(basename) !== -1) return;
  var absolutePath = sysPath.resolve(item);
  var options = {persistent: this.options.persistent};
  this._addToWatchedDir(directory, basename);
  if (!callback) callback = Function.prototype; // empty function

  if (this.options.usePolling) {
    options.interval = this.enableBinaryInterval && isBinaryPath(basename) ?
      this.options.binaryInterval : this.options.interval;
    var listener = this.listeners[absolutePath] = function(curr, prev) {
      if (curr.mtime.getTime() > prev.mtime.getTime() || curr.mtime.getTime() === 0) {
        callback(item, curr);
      }
    };
    fs.watchFile(absolutePath, options, listener);
  } else {
    var watcher = fs.watch(item, options, function(event, path) {
      if (!isWindows || !path) return callback(item);

      var self = this;

      // Ignore the event if it's currently being throttled
      if (!self.throttling) {
        self.throttling = {};
      }
      if (self.throttling[path]) {
        return;
      }
      self.throttling[path] = true;
      setTimeout(function() {
        delete self.throttling[path];
        callback(item);
      }, 0);
    });
    var _emitError = this._emitError;
    watcher.on('error', function(error) {
      // Workaround for the "Windows rough edge" regarding the deletion of directories
      // (https://github.com/joyent/node/issues/4337)
      if (isWindows && error.code === 'EPERM') {
        fs.exists(item, function(exists) {
          if (exists) _emitError(error);
        });
      } else {
        _emitError(error);
      }
    });
    this.watchers.push(watcher);
  }
};

FSWatcher.prototype._emitError = function(error) {
  this.emit('error', error);
};

// Private: Emit `change` event once and watch file to emit it in the future
// once the file is changed.

// file       - string, fs path.
// stats      - object, result of executing stat(1) on file.
// initialAdd - boolean, was the file added at the launch?

// Returns nothing.
FSWatcher.prototype._handleFile = function(file, stats, initialAdd) {
  var _this = this;
  if (!initialAdd) initialAdd = false;
  this._watch(file, function(file, newStats) {
    if (newStats && newStats.mtime.getTime() === 0) {
      fs.exists(file, function(exists) {
        // Fix issues where mtime is null but file is still present
        if (!exists) {
          _this._remove(sysPath.dirname(file), sysPath.basename(file));
        } else {
          _this.emit('change', file, newStats);
        }
      });
    } else {
      _this.emit('change', file, newStats);
    }
  });
  if (!(initialAdd && this.options.ignoreInitial)) {
    this.emit('add', file, stats);
  }
};

// Private: Read directory to add / remove files from `@watched` list
// and re-read it on change.

// directory - string, fs path.

// Returns nothing.
FSWatcher.prototype._handleDir = function(directory, stats, initialAdd) {
  var _this = this;
  if (!this._reading) this._reading = {};
  function read(directory, initialAdd) {
    if (_this._reading[directory]) return;
    _this._reading[directory] = true;
    fs.readdir(directory, function(error, current) {
      if (error != null) return _this._emitError(error);
      if (!current) return;
      // Normalize the directory name on Windows
      directory = sysPath.join(directory, '');
      var previous = _this._getWatchedDir(directory);

      // Files that absent in current directory snapshot
      // but present in previous emit `remove` event
      // and are removed from @watched[directory].
      previous.filter(function(file) {
        return current.indexOf(file) === -1;
      }).forEach(function(file) {
        _this._remove(directory, file);
      });

      // Files that present in current directory snapshot
      // but absent in previous are added to watch list and
      // emit `add` event.
      current.filter(function(file) {
        return previous.indexOf(file) === -1;
      }).forEach(function(file) {
        _this._handle(sysPath.join(directory, file), initialAdd);
      });

      delete _this._reading[directory]
    });
  }
  read(directory, initialAdd);
  this._watch(directory, function(dir, stats) {
    // Current directory is removed, do nothing
    if (stats && stats.mtime.getTime() === 0) return;

    read(dir, false);
  });
  if (!(initialAdd && this.options.ignoreInitial)) {
    this.emit('addDir', directory, stats);
  }
};

// Private: Handle added file or directory.
// Delegates call to _handleFile / _handleDir after checks.

// item - string, path to file or directory.

// Returns nothing.
FSWatcher.prototype._handle = function(item, initialAdd) {
  var _this = this;
  if (this._isIgnored(item) || _this.closed) return;

  fs.realpath(item, function(error, path) {
    if (_this.closed || error && error.code === 'ENOENT') return;
    if (error) return _this._emitError(error);
    fs.stat(path, function(error, stats) {
      if (_this.closed || error && error.code === 'ENOENT') return;
      if (error) return _this._emitError(error);
      if ((
        _this.options.ignorePermissionErrors &&
        !_this._hasReadPermissions(stats)
      ) || (
        _this._isIgnored.length === 2 &&
        _this._isIgnored(item, stats)
      )) return;
      if (stats.isFile() || stats.isCharacterDevice()) {
        _this._handleFile(item, stats, initialAdd);
      } else if (stats.isDirectory()) {
        _this._handleDir(item, stats, initialAdd);
      }
    });
  });
};

FSWatcher.prototype.emit = function(event) {
  var realEmit = EventEmitter.prototype.emit;
  var args = [].slice.apply(arguments);
  realEmit.apply(this, args);
  if (event !== 'error') realEmit.apply(this, ['all'].concat(args));
  return this;
};

FSWatcher.prototype._addToFsEvents = function(file) {
  var _this = this;
  var handle = function(path) {
    _this.emit('add', path);
  };
  if (!_this.options.ignoreInitial) {
    fs.stat(file, function(error, stats) {
      if (error && error.code === 'ENOENT') return;
      if (error != null) return _this._emitError(error);

      if (stats.isDirectory()) {
        recursiveReaddir(file, function(error, dirFiles) {
          if (error && error.code === 'ENOENT') return;
          if (error != null) return _this._emitError(error);
          dirFiles.filter(function(path) {
            return !_this._isIgnored(path);
          }).forEach(handle);
        });
      } else {
        handle(file);
      }
    });
  }
  _this._watchWithFsEvents(file);
  return this;
};

// Public: Adds directories / files for tracking.

// * files - array of strings (file paths).

// Examples

//   add ['app', 'vendor']

// Returns an instance of FSWatcher for chaining.
FSWatcher.prototype.add = function(files) {
  if (this._initialAdd == null) this._initialAdd = true;
  if (!Array.isArray(files)) files = [files];

  files.forEach(function(file) {
    if (this.options.useFsEvents) {
      this._addToFsEvents(file);
    } else {
      this._handle(file, this._initialAdd);
    }
  }, this);

  this._initialAdd = false;
  return this;
};

// Public: Remove all listeners from watched files.
// Returns an instance of FSWatcher for chaining.
FSWatcher.prototype.close = function() {
  if(this.closed) return this;
  var listeners = this.listeners;
  var watched = this.watched;
  var useFsEvents = this.options.useFsEvents;
  var method = useFsEvents ? 'stop' : 'close';

  this.closed = true;
  this.watchers.forEach(function(watcher) {
    watcher[method]();
  });

  if (this.options.usePolling) {
    Object.keys(watched).forEach(function(directory) {
      watched[directory].forEach(function(file) {
        var absolutePath = sysPath.resolve(directory, file)
        fs.unwatchFile(absolutePath, listeners[absolutePath]);
        delete listeners[absolutePath];
      });
    });
  }
  this.watched = Object.create(null);

  this.removeAllListeners();
  return this;
};

exports.FSWatcher = FSWatcher;

exports.watch = function(files, options) {
  return new FSWatcher(options).add(files);
};
