'use strict';
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var sysPath = require('path');
var each = require('async-each');
var readdirp = require('readdirp');
var fsevents;
try {
  fsevents = require('fsevents');
} catch (error) {}

var platform = require('os').platform();
var canUseFsEvents = platform === 'darwin' && fsevents;

// To disable FSEvents completely.
// var canUseFsEvents = false;

// Binary file handling code.
var _binExts = [
  'adp', 'au', 'mid', 'mp4a', 'mpga', 'oga', 's3m', 'sil', 'eol', 'dra', 'dts',
  'dtshd', 'lvp', 'pya', 'ecelp4800', 'ecelp7470', 'ecelp9600', 'rip', 'weba',
  'aac', 'aif', 'caf', 'flac', 'mka', 'm3u', 'wax', 'wma', 'wav', 'xm', 'flac',
  '3gp', '3g2', 'h261', 'h263', 'h264', 'jpgv', 'jpm', 'mj2', 'mp4', 'mpeg',
  'ogv', 'qt', 'uvh', 'uvm', 'uvp', 'uvs', 'dvb', 'fvt', 'mxu', 'pyv', 'uvu',
  'viv', 'webm', 'f4v', 'fli', 'flv', 'm4v', 'mkv', 'mng', 'asf', 'vob', 'wm',
  'wmv', 'wmx', 'wvx', 'movie', 'smv', 'ts', 'bmp', 'cgm', 'g3', 'gif', 'ief',
  'jpg', 'jpeg', 'ktx', 'png', 'btif', 'sgi', 'svg', 'tiff', 'psd', 'uvi',
  'sub', 'djvu', 'dwg', 'dxf', 'fbs', 'fpx', 'fst', 'mmr', 'rlc', 'mdi', 'wdp',
  'npx', 'wbmp', 'xif', 'webp', '3ds', 'ras', 'cmx', 'fh', 'ico', 'pcx', 'pic',
  'pnm', 'pbm', 'pgm', 'ppm', 'rgb', 'tga', 'xbm', 'xpm', 'xwd', 'zip', 'rar',
  'tar', 'bz2', 'eot', 'ttf', 'woff'
];

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

// Public: Main class.
// Watches files & directories for changes.
//
// * _opts - object, chokidar options hash
//
// Emitted events:
// `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
//
// Examples
//
//  var watcher = new FSWatcher()
//    .add(directories)
//    .on('add', function(path) {console.log('File', path, 'was added');})
//    .on('change', function(path) {console.log('File', path, 'was changed');})
//    .on('unlink', function(path) {console.log('File', path, 'was removed');})
//    .on('all', function(event, path) {console.log(path, ' emitted ', event);})
//
function FSWatcher(_opts) {
  var opts = {};
  // in case _opts that is passed in is a frozen object
  if (_opts) for (var opt in _opts) opts[opt] = _opts[opt];
  this._watched = Object.create(null);
  this._watchers = [];
  this._ignoredPaths = Object.create(null);
  this.closed = false;
  this._throttled = Object.create(null);

  function undef(key) {
    return opts[key] === undefined;
  }

  // Set up default options.
  if (undef('persistent')) opts.persistent = false;
  if (undef('ignoreInitial')) opts.ignoreInitial = false;
  if (undef('ignorePermissionErrors')) opts.ignorePermissionErrors = false;
  if (undef('interval')) opts.interval = 100;
  if (undef('binaryInterval')) opts.binaryInterval = 300;
  this.enableBinaryInterval = opts.binaryInterval !== opts.interval;

  // Enable fsevents on OS X when polling is disabled.
  // Which is basically super fast watcher.
  if (undef('useFsEvents')) opts.useFsEvents = !opts.usePolling;
  // If we can't use fs events, disable it in any case.
  if (!canUseFsEvents) opts.useFsEvents = false;

  // Use polling by default on Linux and Mac (if not using fsevents).
  // Disable polling on Windows.
  if (undef('usePolling') && !opts.useFsEvents) {
    opts.usePolling = platform !== 'win32';
  }

  this._isntIgnored = function(entry) {
    return !this._isIgnored(entry.path, entry.stat);
  }.bind(this);

  var readyCalls = 0;
  this._emitReady = function() {
    if (++readyCalls >= this._readyCount) {
      this._emitReady = Function.prototype;
      // use process.nextTick to allow time for listener to be bound
      process.nextTick(this.emit.bind(this, 'ready'));
    }
  }.bind(this);

  this.options = opts;

  // You’re frozen when your heart’s not open.
  Object.freeze(opts);
}

FSWatcher.prototype = Object.create(EventEmitter.prototype);

// Common helpers
// --------------
FSWatcher.prototype._emit = function(event) {
  var args = [].slice.apply(arguments);
  this.emit.apply(this, args);
  if (event !== 'error') this.emit.apply(this, ['all'].concat(args));
  return this;
};

FSWatcher.prototype._handleError = function(error) {
  if (error &&
    error.code !== 'ENOENT' &&
    error.code !== 'ENOTDIR'
  ) this.emit('error', error);
  return error || this.closed;
};

FSWatcher.prototype._throttle = function(action, path, timeout) {
  if (!(action in this._throttled)) {
    this._throttled[action] = Object.create(null);
  }
  var throttled = this._throttled[action];
  if (path in throttled) return false;
  function clear() {
    delete throttled[path];
    clearTimeout(timeoutObject);
  }
  var timeoutObject = setTimeout(clear, timeout);
  throttled[path] = {timeoutObject: timeoutObject, clear: clear};
  return throttled[path];
};

FSWatcher.prototype._isIgnored = function(path, stats) {
  var userIgnored = (function(ignored) {
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
  })(this.options.ignored);
  var ignoredPaths = Object.keys(this._ignoredPaths);
  function isParent(ip) {
    return !path.indexOf(ip + sysPath.sep);
  }
  return ignoredPaths.length && ignoredPaths.some(isParent) ||
    userIgnored(path, stats);
};

// Directory helpers
// -----------------
FSWatcher.prototype._getWatchedDir = function(directory) {
  var dir = sysPath.resolve(directory);
  if (!(dir in this._watched)) this._watched[dir] = {
    _items: Object.create(null),
    add: function(item) {this._items[item] = true;},
    remove: function(item) {delete this._items[item];},
    has: function(item) {return item in this._items;},
    children: function() {return Object.keys(this._items);}
  };
  return this._watched[dir];
};

// File helpers
// ------------

// Private: Check for read permissions
// Based on this answer on SO: http://stackoverflow.com/a/11781404/1358405
//
// * stats - object, result of fs.stat
//
// Returns Boolean
FSWatcher.prototype._hasReadPermissions = function(stats) {
  return Boolean(4 & parseInt((stats.mode & 0x1ff).toString(8)[0], 10));
};

// Private: Handles emitting unlink events for
// files and directories, and via recursion, for
// files and directories within directories that are unlinked
//
// * directory - string, directory within which the following item is located
// * item      - string, base path of item/directory
//
// Returns nothing.
FSWatcher.prototype._remove = function(directory, item) {
  // if what is being deleted is a directory, get that directory's paths
  // for recursive deleting and cleaning of watched object
  // if it is not a directory, nestedDirectoryChildren will be empty array
  var fullPath = sysPath.join(directory, item);
  var absolutePath = sysPath.resolve(fullPath);
  var isDirectory = this._watched[fullPath] || this._watched[absolutePath];

  // prevent duplicate handling in case of arriving here nearly simultaneously
  // via multiple paths (such as _handleFile and _handleDir)
  if (!this._throttle('remove', fullPath, 10)) return;

  // if the only watched file is removed, watch for its return
  var watchedDirs = Object.keys(this._watched);
  if (!isDirectory && !this.options.useFsEvents && watchedDirs.length === 1) {
    this.add(directory, item);
  }

  // This will create a new entry in the watched object in either case
  // so we got to do the directory check beforehand
  var nestedDirectoryChildren = this._getWatchedDir(fullPath).children();

  // Recursively remove children directories / files.
  nestedDirectoryChildren.forEach(function(nestedItem) {
    this._remove(fullPath, nestedItem);
  }, this);

  // Remove directory / file from watched list.
  this._getWatchedDir(directory).remove(item);

  // The Entry will either be a directory that just got removed
  // or a bogus entry to a file, in either case we have to remove it
  delete this._watched[fullPath];
  delete this._watched[absolutePath];
  var eventName = isDirectory ? 'unlinkDir' : 'unlink';
  this._emit(eventName, fullPath);
};

// FS Events helpers.
var FSEventsWatchers = Object.create(null);
function createFSEventsInstance(path, callback) {
  return (new fsevents(path)).on('fsevent', callback).start();
}

function setFSEventsListener(path, callback) {
  var watchPath = sysPath.extname(path) ? sysPath.dirname(path) : path;
  var watchContainer;

  var resolvedPath = sysPath.resolve(path);
  function filteredCallback(fullPath, flags) {
    if (
      fullPath === resolvedPath ||
      !fullPath.indexOf(resolvedPath + sysPath.sep)
    ) callback(fullPath, flags);
  }

  if (
    watchPath in FSEventsWatchers ||
    // check if there is already a watcher on a parent path
    Object.keys(FSEventsWatchers).some(function(watchedPath) {
      if (!watchPath.indexOf(watchedPath)) {
        watchPath = watchedPath;
        return true;
      }
    })
  ) {
    watchContainer = FSEventsWatchers[watchPath];
    watchContainer.listeners.push(filteredCallback);
  } else {
    watchContainer = FSEventsWatchers[watchPath] = {
      listeners: [filteredCallback],
      watcher: createFSEventsInstance(watchPath, function(fullPath, flags) {
        watchContainer.listeners.forEach(function(callback) {
          callback(fullPath, flags);
        });
      })
    };
  }
  var listenerIndex = watchContainer.listeners.length - 1;
  return {
    close: function() {
      delete watchContainer.listeners[listenerIndex];
      if (!Object.keys(watchContainer.listeners).length) {
        watchContainer.watcher.stop();
        delete FSEventsWatchers[watchPath];
      }
    }
  };
}

FSWatcher.prototype._watchWithFsEvents = function(watchPath) {
  if (this._isIgnored(watchPath)) return;
  var watcher = setFSEventsListener(watchPath, function(fullPath, flags) {
    var info = fsevents.getInfo(fullPath, flags);
    var path = sysPath.join(watchPath, sysPath.relative(watchPath, fullPath));
    // ensure directories are tracked
    var parent = sysPath.dirname(path);
    var item = sysPath.basename(path);
    var watchedDir = this._getWatchedDir(
      info.type === 'directory' ? path : parent
    );
    var checkIgnored = function (stats) {
      if (this._isIgnored(path, stats)) {
        this._ignoredPaths[fullPath] = true;
        return true;
      } else {
        delete this._ignoredPaths[fullPath];
      }
    }.bind(this);

    var handleEvent = function (event) {
      if (event === 'unlink') {
        // suppress unlink events on never before seen files (from atomic write)
        if (info.type === 'directory' || watchedDir.has(item)) {
          this._remove(parent, item);
        } else {
          fs.stat(path, function(error, stats) {
            if (!stats || checkIgnored(stats)) return;
            info.type = stats.isDirectory() ? 'directory' : 'file';
            handleEvent('add');
          });
        }
        return; // Don't emit event twice.
      }
      if (checkIgnored()) return;
      if (event === 'add') {
        this._getWatchedDir(parent).add(item);
        if (info.type === 'directory') this._getWatchedDir(path);
      }
      var eventName = info.type === 'file' ? event : event + 'Dir';
      this._emit(eventName, path);
    }.bind(this);

    // correct for wrong events emitted
    function addOrChange() {
      handleEvent(watchedDir.has(item) ? 'change' : 'add');
    }
    var wrongEventFlags = [69888, 70400, 71424, 72704, 73472, 131328, 131840];
    if (wrongEventFlags.indexOf(flags) !== -1 || info.event === 'unknown') {
      if (info.event !== 'add' && info.event !== 'change') {
        fs.stat(path, function(error, stats) {
          if (checkIgnored(stats)) return;
          if (stats) {
            addOrChange();
          } else {
            handleEvent('unlink');
          }
        });
      } else {
        addOrChange();
      }
      return;
    }

    switch (info.event) {
    case 'created':
      return handleEvent('add');
    case 'modified':
      return handleEvent('change');
    case 'deleted':
      return handleEvent('unlink');
    case 'moved':
      return fs.stat(path, function(error, stats) {
        stats ? addOrChange() : handleEvent('unlink');
      });
    }
  }.bind(this));
  this._emitReady();
  return this._watchers.push(watcher);
};

// Node.js native watcher helpers
var FsWatchInstances = Object.create(null);
function createFsWatchInstance(item, options, callback, errHandler) {
  var handleEvent = function() {callback(item);};
  try {
    return fs.watch(item, options, handleEvent);
  } catch (error) {
    errHandler(error);
  }
}

function fsWatchBroadcast(absPath, type, value) {
  FsWatchInstances[absPath][type].forEach(function(callback) {
    callback(value);
  });
}

function setFsWatchListener(item, absPath, options, callback, errHandler) {
  var container = FsWatchInstances[absPath];
  if (!options.persistent) {
    return createFsWatchInstance(item, options, callback, errHandler);
  } else if (!container) {
    var watcher = createFsWatchInstance(
      item,
      options,
      fsWatchBroadcast.bind(null, absPath, 'listeners'),
      errHandler // no need to use broadcast here
    );
    if (!watcher) return;
    var broadcastErr = fsWatchBroadcast.bind(null, absPath, 'errHandlers');
    watcher.on('error', function(error) {
      // Workaround for https://github.com/joyent/node/issues/4337
      if (platform === 'win32' && error.code === 'EPERM') {
        fs.exists(item, function(exists) {
          if (exists) broadcastErr(error);
        });
      } else {
        broadcastErr(error);
      }
    });
    container = FsWatchInstances[absPath] = {
      listeners: [callback],
      errHandlers: [errHandler],
      watcher: watcher
    };
  } else {
    container.listeners.push(callback);
    container.errHandlers.push(errHandler);
  }
  var listenerIndex = container.listeners.length - 1;
  return {
    close: function() {
      delete container.listeners[listenerIndex];
      delete container.errHandlers[listenerIndex];
      if (!Object.keys(container.listeners).length) {
        container.watcher.close();
        delete FsWatchInstances[absPath];
      }
    }
  };
}

var FsWatchFileInstances = Object.create(null);
function setFsWatchFileListener(item, absPath, options, callback) {
  var container = FsWatchFileInstances[absPath];
  var listeners = [];
  if (
    container && (
      container.options.persistent < options.persistent ||
      container.options.interval > options.interval
    )
  ) {
    // "Upgrade" the watcher to persistence or a quicker interval.
    // This creates some unlikely edge case issues if the user mixes
    // settings in a very weird way, but solving for those cases
    // doesn't seem worthwhile for the added complexity.
    listeners = container.listeners;
    fs.unwatchFile(absPath);
    container = false;
  }
  if (!container) {
    listeners.push(callback);
    container = FsWatchFileInstances[absPath] = {
      listeners: listeners,
      options: options,
      watcher: fs.watchFile(absPath, options, function(curr, prev) {
        var currmtime = curr.mtime.getTime();
        if (currmtime > prev.mtime.getTime() || currmtime === 0) {
          container.listeners.forEach(function(callback) {
            callback(item, curr);
          });
        }
      })
    };
  } else {
    container.listeners.push(callback);
  }
  var listenerIndex = container.listeners.length - 1;
  return {
    close: function() {
      delete container.listeners[listenerIndex];
      if (!Object.keys(container.listeners).length) {
        fs.unwatchFile(absPath);
        delete FsWatchFileInstances[absPath];
      }
    }
  };
}

// Private: Watch file for changes with fs.watchFile or fs.watch.

// * item     - string, path to file or directory.
// * callback - function that will be executed on fs change.

// Returns nothing.
FSWatcher.prototype._watch = function(item, callback) {
  var directory = sysPath.dirname(item);
  var basename = sysPath.basename(item);
  var parent = this._getWatchedDir(directory);
  if (parent.has(basename)) return;
  parent.add(basename);
  var absolutePath = sysPath.resolve(item);
  var options = {persistent: this.options.persistent};
  if (!callback) callback = Function.prototype; // empty function

  var watcher;
  if (this.options.usePolling) {
    options.interval = this.enableBinaryInterval && isBinaryPath(basename) ?
      this.options.binaryInterval : this.options.interval;
    watcher = setFsWatchFileListener(item, absolutePath, options, callback);
  } else {
    var errHandler = this._handleError.bind(this);
    watcher = setFsWatchListener(item, absolutePath, options, callback, errHandler);
  }
  if (watcher) this._watchers.push(watcher);
};

// Private: Emit `change` event once and watch file to emit it in the future
// once the file is changed.

// * file       - string, fs path.
// * stats      - object, result of fs.stat
// * initialAdd - boolean, was the file added at watch instantiation?

// Returns nothing.
FSWatcher.prototype._handleFile = function(file, stats, initialAdd, target, callback) {
  var dirname = sysPath.dirname(file);
  var basename = sysPath.basename(file);
  var parent = this._getWatchedDir(dirname);
  // if the file is already being watched, do nothing
  if (parent.has(basename)) return;
  this._watch(file, function(file, newStats) {
    if (!this._throttle('watch', file, 5)) return;
    if (!newStats || newStats && newStats.mtime.getTime() === 0) {
      fs.stat(file, function(error, newStats) {
        // Fix issues where mtime is null but file is still present
        if (error) {
          this._remove(dirname, basename);
        } else {
          this._emit('change', file, newStats);
        }
      }.bind(this));
    // add is about to be emitted if file not already tracked in parent
    } else if (parent.has(basename)) {
      this._emit('change', file, newStats);
    }
  }.bind(this));
  if (!(initialAdd && this.options.ignoreInitial)) {
    if (!this._throttle('add', file, 0)) return;
    this._emit('add', file, stats);
  }
  if (callback) callback();
};

// Private: Read directory to add / remove files from `@watched` list
// and re-read it on change.

// * dir        - string, fs path.
// * stats      - object, result of fs.stat
// * initialAdd - boolean, was the file added at watch instantiation?
// * target     - child path actually targeted for watch

// Returns nothing.
FSWatcher.prototype._handleDir = function(dir, stats, initialAdd, target, callback) {
  var _this = this;
  function read(directory, initialAdd, target, done) {
    // Normalize the directory name on Windows
    directory = sysPath.join(directory, '');
    var throttler = _this._throttle('readdir', directory, 1000);
    if (!throttler) return;
    var previous = _this._getWatchedDir(directory);
    var current = [];

    readdirp({
      root: directory,
      entryType: 'both',
      depth: 0
    }).on('data', function(entry) {
      var item = entry.path;
      current.push(item);

      // Files that present in current directory snapshot
      // but absent in previous are added to watch list and
      // emit `add` event.
      if (item === target || !target && !previous.has(item)) {
        _this._readyCount++;
        _this._handle(sysPath.join(directory, item), initialAdd, target);
      }
    }).on('end', function() {
      throttler.clear();
      if (done) done();

      // Files that absent in current directory snapshot
      // but present in previous emit `remove` event
      // and are removed from @watched[directory].
      previous.children().filter(function(item) {
        return item !== directory && current.indexOf(item) === -1;
      }).forEach(function(item) {
        _this._remove(directory, item);
      });
    }).on('error', _this._handleError.bind(_this));
  }
  if (!target) read(dir, initialAdd, null, callback);
  this._watch(dir, function(dirPath, stats) {
    // Current directory is removed, do nothing
    if (stats && stats.mtime.getTime() === 0) return;
    read(dirPath, false, target);
  });
  if (!(initialAdd && this.options.ignoreInitial) && !target) {
    this._emit('addDir', dir, stats);
  }
};

// Private: Handle added file or directory.
// Delegates call to _handleFile / _handleDir after checks.

// * item       - string, path to file or directory.
// * initialAdd - boolean, was the file added at watch instantiation?
// * target     - child path actually targeted for watch
// * callback   - indicates whether the item was found or not

// Returns nothing.
FSWatcher.prototype._handle = function(item, initialAdd, target, callback) {
  if (!callback) callback = Function.prototype;
  if (this._isIgnored(item) || this.closed) {
    this._emitReady();
    return callback(null, item);
  }

  fs.realpath(item, function(error, path) {
    if (this._handleError(error)) return callback(null, item);
    fs.stat(path, function(error, stats) {
      if (this._handleError(error)) return callback(null, item);
      if ((
        this.options.ignorePermissionErrors &&
        !this._hasReadPermissions(stats)
      ) || (
        this._isIgnored.length === 2 &&
        this._isIgnored(item, stats)
      )) {
        this._emitReady();
        return callback(null, false);
      }
      if (stats.isFile() || stats.isCharacterDevice()) {
        this._handleFile(item, stats, initialAdd, target, this._emitReady);
      } else if (stats.isDirectory()) {
        this._handleDir(item, stats, initialAdd, target, this._emitReady);
      }
      callback(null, false);
    }.bind(this));
  }.bind(this));
};

FSWatcher.prototype._addToFsEvents = function(file) {
  var emitAdd = function(path, stats) {
    this._getWatchedDir(sysPath.dirname(path)).add(sysPath.basename(path));
    this._emit(stats.isDirectory() ? 'addDir' : 'add', path, stats);
  }.bind(this);
  if (this.options.ignoreInitial) {
    this._emitReady();
  } else {
    fs.stat(file, function(error, stats) {
      if (this._handleError(error)) return this._emitReady();

      if (stats.isDirectory()) {
        this._emit('addDir', file, stats);
        readdirp({
          root: file,
          entryType: 'both',
          fileFilter: this._isntIgnored,
          directoryFilter: this._isntIgnored
        }).on('data', function(entry) {
          emitAdd(sysPath.join(file, entry.path), entry.stat);
        }).on('end', this._emitReady);
      } else {
        emitAdd(file, stats);
        this._emitReady();
      }
    }.bind(this));
  }
  if (this.options.persistent) this._watchWithFsEvents(file);
  return this;
};

// Public: Adds directories / files for tracking.

// * files    - array of strings (file or directory paths).
// * _origAdd - private argument for handling non-existent paths to be watched

// Returns an instance of FSWatcher for chaining.
FSWatcher.prototype.add = function(files, _origAdd) {
  this.closed = false;
  if (!('_initialAdd' in this)) this._initialAdd = true;
  if (!Array.isArray(files)) files = [files];

  if (this.options.useFsEvents && Object.keys(FSEventsWatchers).length < 128) {
    if (!this._readyCount) this._readyCount = files.length;
    if (this.options.persistent) this._readyCount *= 2;
    files.forEach(this._addToFsEvents, this);
  } else {
    if (!this._readyCount) this._readyCount = 0;
    this._readyCount += files.length;
    each(files, function(file, next) {
      this._handle(file, this._initialAdd, _origAdd, function(err, res) {
        if (res) this._emitReady();
        next(err, res);
      }.bind(this));
    }.bind(this), function(error, results) {
      results.forEach(function(item){
        if (!item) return;
        this.add(sysPath.dirname(item), sysPath.basename(_origAdd || item));
      }, this);
    }.bind(this));
  }

  this._initialAdd = false;
  return this;
};

// Public: Remove all listeners from watched files.

// Returns an instance of FSWatcher for chaining.
FSWatcher.prototype.close = function() {
  if (this.closed) return this;

  this.closed = true;
  this._watchers.forEach(function(watcher) {
    watcher.close();
  });
  this._watched = Object.create(null);

  this.removeAllListeners();
  return this;
};

exports.FSWatcher = FSWatcher;

exports.watch = function(files, options) {
  return new FSWatcher(options).add(files);
};
