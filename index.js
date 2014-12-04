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
  this._symlinkPaths = Object.create(null);

  function undef(key) {
    return opts[key] === undefined;
  }

  // Set up default options.
  if (undef('persistent')) opts.persistent = true;
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

  // vim & atomic save friendly settings
  if (undef('atomic')) {
    opts.atomic = !opts.usePolling && !opts.useFsEvents;
  }
  if (opts.atomic) this._pendingUnlinks = Object.create(null);

  if (undef('followSymlinks')) opts.followSymlinks = true;

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
  if (this.options.atomic) {
    if (event === 'unlink') {
      this._pendingUnlinks[args[1]] = args;
      setTimeout(function() {
        Object.keys(this._pendingUnlinks).forEach(function(path) {
          this.emit.apply(this, this._pendingUnlinks[path]);
          this.emit.apply(this, ['all'].concat(this._pendingUnlinks[path]));
          delete this._pendingUnlinks[path];
        }.bind(this));
      }.bind(this), 100);
      return this;
    } else if (event === 'add' && this._pendingUnlinks[args[1]]) {
      event = args[0] = 'change';
      delete this._pendingUnlinks[args[1]];
    }
    if (event === 'change') {
      if (!this._throttle('change', args[1], 50)) return this;
    }
  }
  this.emit.apply(this, args);
  if (event !== 'error') this.emit.apply(this, ['all'].concat(args));
  return this;
};

FSWatcher.prototype._handleError = function(error) {
  if (error &&
    error.code !== 'ENOENT' &&
    error.code !== 'ENOTDIR' &&
    !(error.code === 'EPERM' && !this.options.ignorePermissionErrors)
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
  if (
    this.options.atomic &&
    /^\..*\.(sw[px])$|\~$|\.subl.*\.tmp/.test(path)
  ) return true;
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
  if (!this._throttle('remove', fullPath, 100)) return;

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

function setFSEventsListener(path, realPath, callback, rawEmitter) {
  var watchPath = sysPath.extname(path) ? sysPath.dirname(path) : path;
  var watchContainer;

  var resolvedPath = sysPath.resolve(path);
  var hasSymlink = resolvedPath !== realPath;
  function filteredCallback(fullPath, flags, info) {
    if (hasSymlink) fullPath = fullPath.replace(realPath, resolvedPath);
    if (
      fullPath === resolvedPath ||
      !fullPath.indexOf(resolvedPath + sysPath.sep)
    ) callback(fullPath, flags, info);
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
      rawEmitters: [rawEmitter],
      watcher: createFSEventsInstance(watchPath, function(fullPath, flags) {
        var info = fsevents.getInfo(fullPath, flags);
        watchContainer.listeners.forEach(function(callback) {
          callback(fullPath, flags, info);
        });
        watchContainer.rawEmitters.forEach(function(emitter) {
          emitter(info.event, fullPath, info);
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

FSWatcher.prototype._watchWithFsEvents = function(watchPath, realPath, pt) {
  if (this._isIgnored(watchPath)) return;
  var watchCallback = function(fullPath, flags, info) {
    var path = pt(sysPath.join(
      watchPath, sysPath.relative(watchPath, fullPath)
    ));
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
        if (info.type === 'directory') {
          this._getWatchedDir(path);
        } else if (info.type === 'symlink' && this.options.followSymlinks) {
          return this._addToFsEvents(path, false, true);
        }
      }
      var eventName = info.type === 'directory' ? event + 'Dir' : event;
      this._emit(eventName, path);
    }.bind(this);

    // correct for wrong events emitted
    function addOrChange() {
      handleEvent(watchedDir.has(item) ? 'change' : 'add');
    }
    var wrongEventFlags = [
      69888, 70400, 71424, 72704, 73472, 131328, 131840, 262912
    ];
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
      return addOrChange();
    case 'modified':
      return addOrChange();
    case 'deleted':
      return handleEvent('unlink');
    case 'moved':
      return fs.stat(path, function(error, stats) {
        stats ? addOrChange() : handleEvent('unlink');
      });
    }
  }.bind(this);

  var watcher = setFSEventsListener(
    watchPath,
    realPath,
    watchCallback,
    this.emit.bind(this, 'raw')
  );

  this._emitReady();
  return this._watchers.push(watcher);
};

// Node.js native watcher helpers
var FsWatchInstances = Object.create(null);
function createFsWatchInstance(item, options, callback, errHandler, emitRaw) {
  var handleEvent = function(rawEvent, path) {
    callback(item);
    emitRaw(rawEvent, path, {watchedPath: item});
    if (path && item !== path) {
      fsWatchBroadcast(sysPath.resolve(item, path), 'listeners', path);
    }
  };
  try {
    return fs.watch(item, options, handleEvent);
  } catch (error) {
    errHandler(error);
  }
}

function fsWatchBroadcast(absPath, type, value1, value2, value3) {
  if (!FsWatchInstances[absPath]) return;
  FsWatchInstances[absPath][type].forEach(function(callback) {
    callback(value1, value2, value3);
  });
}

function setFsWatchListener(item, absPath, options, handlers) {
  var callback = handlers.callback;
  var errHandler = handlers.errHandler;
  var rawEmitter = handlers.rawEmitter;
  var container = FsWatchInstances[absPath];
  if (!options.persistent) {
    return createFsWatchInstance(item, options, callback, errHandler);
  } else if (!container) {
    var watcher = createFsWatchInstance(
      item,
      options,
      fsWatchBroadcast.bind(null, absPath, 'listeners'),
      errHandler, // no need to use broadcast here
      fsWatchBroadcast.bind(null, absPath, 'rawEmitters')
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
      rawEmitters: [rawEmitter],
      watcher: watcher
    };
  } else {
    container.listeners.push(callback);
    container.errHandlers.push(errHandler);
    container.rawEmitters.push(rawEmitter);
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
function setFsWatchFileListener(item, absPath, options, handlers) {
  var callback = handlers.callback;
  var rawEmitter = handlers.rawEmitter;
  var container = FsWatchFileInstances[absPath];
  var listeners = [];
  var rawEmitters = [];
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
    rawEmitters = container.rawEmitters;
    fs.unwatchFile(absPath);
    container = false;
  }
  if (!container) {
    listeners.push(callback);
    rawEmitters.push(rawEmitter);
    container = FsWatchFileInstances[absPath] = {
      listeners: listeners,
      rawEmitters: rawEmitters,
      options: options,
      watcher: fs.watchFile(absPath, options, function(curr, prev) {
        container.rawEmitters.forEach(function(rawEmitter) {
          rawEmitter('change', absPath, {curr: curr, prev: prev});
        });
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
    watcher = setFsWatchFileListener(item, absolutePath, options, {
      callback: callback,
      rawEmitter: this.emit.bind(this, 'raw')
    });
  } else {
    watcher = setFsWatchListener(item, absolutePath, options, {
      callback: callback,
      errHandler: this._handleError.bind(this),
      rawEmitter: this.emit.bind(this, 'raw')
    });
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
  function read(directory, initialAdd, done) {
    // Normalize the directory name on Windows
    directory = sysPath.join(directory, '');
    var throttler = _this._throttle('readdir', directory, 1000);
    if (!throttler) return;
    var previous = _this._getWatchedDir(directory);
    var current = [];

    readdirp({
      root: directory,
      entryType: 'both',
      depth: 0,
      lstat: true
    }).on('data', function(entry) {
      var item = entry.path;
      current.push(item);
      var path = sysPath.join(directory, item);

      if (entry.stat.isSymbolicLink()) {
        if (!_this.options.followSymlinks) {
          _this._readyCount++;
          fs.readlink(path, function(error, linkPath) {
            if (previous.has(item)) {
              if (_this._symlinkPaths[entry.fullPath] !== linkPath) {
                _this._symlinkPaths[entry.fullPath] = linkPath;
                _this._emit('change', path, entry.stat);
              }
            } else {
              previous.add(item);
              _this._symlinkPaths[entry.fullPath] = linkPath;
              _this._emit('add', path, entry.stat);
            }
            _this._emitReady();
          });
          return;
        }
        if (_this._symlinkPaths[entry.fullPath]) return;
        else _this._symlinkPaths[entry.fullPath] = true;
      }

      // Files that present in current directory snapshot
      // but absent in previous are added to watch list and
      // emit `add` event.
      if (item === target || !target && !previous.has(item)) {
        _this._readyCount++;
        if (_this.options.atomic && /\~$/.test(item)) {
          _this._emit('change', item.slice(0, -1), entry.stat);
        }
        _this._handle(sysPath.join(directory, item), initialAdd);
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
  if (!target) read(dir, initialAdd, callback);
  this._watch(dir, function(dirPath, stats) {
    // Current directory is removed, do nothing
    if (stats && stats.mtime.getTime() === 0) return;
    read(dirPath, false);
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

  var followSymlinks = this.options.followSymlinks;
  fs[followSymlinks ? 'stat' : 'lstat'](item, function(error, stats) {
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
    if (stats.isDirectory()) {
      this._handleDir(item, stats, initialAdd, target, this._emitReady);
    } else if (stats.isSymbolicLink()) {
      var parent = sysPath.dirname(item);
      this._getWatchedDir(parent).add(item);
      this._emit('add', item, stats);
      this._handleDir(parent, stats, initialAdd, item, this._emitReady);
      fs.readlink(item, function(error, linkPath) {
        this._symlinkPaths[sysPath.resolve(item)] = linkPath;
        this._emitReady();
      }.bind(this));
    } else {
      this._handleFile(item, stats, initialAdd, target, this._emitReady);
    }
    callback(null, false);
  }.bind(this));
};

FSWatcher.prototype._symlinkForFsEvents = function(linkPath, add, pt) {
  this._readyCount++;
  fs.readlink(linkPath, function(error, linkTarget) {
    if (this._handleError(error)) return this._emitReady();
    fs.stat(linkTarget, function(error, targetStats) {
      if (this._handleError(error)) return this._emitReady();
      if (targetStats.isDirectory()) {
        this._readyCount++;
        this._addToFsEvents(linkTarget, function(path) {
          var ds = '.' + sysPath.sep;
          return pt(linkTarget && linkTarget !== ds ?
            path.replace(linkTarget, linkPath) :
            path === ds ? linkPath : sysPath.join(linkPath, path));
        });
      } else if (targetStats.isFile()) {
        add();
        this._emitReady();
      }
    }.bind(this));
  }.bind(this));
};

FSWatcher.prototype._addToFsEvents = function(file, pathTransform, forceScan) {
  if (!pathTransform) pathTransform = function(val) { return val; };
  var emitAdd = function(path, stats) {
    path = pathTransform(path);
    this._getWatchedDir(sysPath.dirname(path)).add(sysPath.basename(path));
    this._emit(stats.isDirectory() ? 'addDir' : 'add', path, stats);
  }.bind(this);
  var followSymlinks = this.options.followSymlinks;
  if (this.options.ignoreInitial && forceScan !== true) {
    this._emitReady();
  } else {
    fs[followSymlinks ? 'stat' : 'lstat'](file, function(error, stats) {
      if (this._handleError(error)) return this._emitReady();

      if (stats.isDirectory()) {
        emitAdd(pathTransform(file), stats);
        readdirp({
          root: file,
          entryType: 'both',
          fileFilter: this._isntIgnored,
          directoryFilter: this._isntIgnored,
          lstat: true
        }).on('data', function(entry) {
          var entryPath = sysPath.join(file, entry.path);
          var addEntry = emitAdd.bind(null, entryPath, entry.stat);
          if (followSymlinks && entry.stat.isSymbolicLink()) {
            if (this._symlinkPaths[entry.fullPath]) return;
            else this._symlinkPaths[entry.fullPath] = true;
            this._symlinkForFsEvents(entryPath, addEntry, pathTransform);
          } else {
            addEntry();
          }
        }.bind(this)).on('end', this._emitReady);
      } else {
        emitAdd(file, stats);
        this._emitReady();
      }
    }.bind(this));
  }
  if (this.options.persistent) {
    fs.realpath(file, function(error, realPath) {
      if (error) realPath = file;
      this._watchWithFsEvents(file, sysPath.resolve(realPath), pathTransform);
    }.bind(this));
  }
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
