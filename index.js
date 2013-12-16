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

var __slice = [].slice;
var createFSEventsInstance = function(path, callback) {
  var watcher = new fsevents.FSEvents(path);
  watcher.on('fsevent', callback);
  return watcher;
};
var nodeVersion = process.versions.node.substring(0, 3);
var directoryEndRe = /[\\\/]$/;
var platform = os.platform();
var canUseFsEvents = platform === 'darwin' && fsevents;

// To disable FSEvents completely.
// var canUseFsEvents = false;

// Binary file handling code.
var _binExts = ['adp', 'au', 'mid', 'mp4a', 'mpga', 'oga', 's3m', 'sil', 'eol', 'dra', 'dts', 'dtshd', 'lvp', 'pya', 'ecelp4800', 'ecelp7470', 'ecelp9600', 'rip', 'weba', 'aac', 'aif', 'caf', 'flac', 'mka', 'm3u', 'wax', 'wma', 'wav', 'xm', 'flac', '3gp', '3g2', 'h261', 'h263', 'h264', 'jpgv', 'jpm', 'mj2', 'mp4', 'mpeg', 'ogv', 'qt', 'uvh', 'uvm', 'uvp', 'uvs', 'dvb', 'fvt', 'mxu', 'pyv', 'uvu', 'viv', 'webm', 'f4v', 'fli', 'flv', 'm4v', 'mkv', 'mng', 'asf', 'vob', 'wm', 'wmv', 'wmx', 'wvx', 'movie', 'smv', 'ts', 'bmp', 'cgm', 'g3', 'gif', 'ief', 'jpg', 'jpeg', 'ktx', 'png', 'btif', 'sgi', 'svg', 'tiff', 'psd', 'uvi', 'sub', 'djvu', 'dwg', 'dxf', 'fbs', 'fpx', 'fst', 'mmr', 'rlc', 'mdi', 'wdp', 'npx', 'wbmp', 'xif', 'webp', '3ds', 'ras', 'cmx', 'fh', 'ico', 'pcx', 'pic', 'pnm', 'pbm', 'pgm', 'ppm', 'rgb', 'tga', 'xbm', 'xpm', 'xwd', 'zip', 'rar', 'tar', 'bz2', 'eot', 'ttf', 'woff'];
var binExts = Object.create(null);

_binExts.forEach(function(extension) {
  return binExts[extension] = true;
});

var isBinary = function(extension) {
  if (extension === '') return false;
  return !!binExts[extension];
}

var isBinaryPath = function(path) {
  return isBinary(sysPath.extname(path).slice(1));
};

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
  if (_opts == null) _opts = {};
  var opts = {};
  for (var opt in _opts) opts[opt] = _opts[opt]
  this.close = this.close.bind(this);
  EventEmitter.call(this);
  this.watched = Object.create(null);
  this.watchers = [];

  // Set up default options.
  if (opts.persistent == null) opts.persistent = false;
  if (opts.ignoreInitial == null) opts.ignoreInitial = false;
  if (opts.interval == null) opts.interval = 100;
  if (opts.binaryInterval == null) opts.binaryInterval = 300;
  if (opts.usePolling == null) opts.usePolling = platform !== 'win32';
  if (opts.useFsEvents == null) {
    opts.useFsEvents = !opts.usePolling && canUseFsEvents;
  } else {
    if (!canUseFsEvents) opts.useFsEvents = false;
  }
  if (opts.ignorePermissionErrors == null) {
    opts.ignorePermissionErrors = false;
  }

  this.enableBinaryInterval = opts.binaryInterval !== opts.interval;

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
  var dir, _base;
  dir = directory.replace(directoryEndRe, '');
  return (_base = this.watched)[dir] != null ? (_base = this.watched)[dir] : _base[dir] = [];
};

FSWatcher.prototype._addToWatchedDir = function(directory, basename) {
  var watchedFiles;
  watchedFiles = this._getWatchedDir(directory);
  return watchedFiles.push(basename);
};

FSWatcher.prototype._removeFromWatchedDir = function(directory, file) {
  var watchedFiles;
  watchedFiles = this._getWatchedDir(directory);
  return watchedFiles.some(function(watchedFile, index) {
    if (watchedFile === file) {
      watchedFiles.splice(index, 1);
      return true;
    }
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
  var fullPath, isDirectory, nestedDirectoryChildren,
    _this = this;
  fullPath = sysPath.join(directory, item);
  isDirectory = this.watched[fullPath];

  // This will create a new entry in the watched object in either case
  // so we got to do the directory check beforehand
  nestedDirectoryChildren = this._getWatchedDir(fullPath).slice();

  // Remove directory / file from watched list.
  this._removeFromWatchedDir(directory, item);

  // Recursively remove children directories / files.
  nestedDirectoryChildren.forEach(function(nestedItem) {
    return _this._remove(fullPath, nestedItem);
  });

  if (this.options.usePolling) fs.unwatchFile(fullPath);

  // The Entry will either be a directory that just got removed
  // or a bogus entry to a file, in either case we have to remove it
  delete this.watched[fullPath];
  var eventName = isDirectory ? 'unlinkDir' : 'unlink';
  this.emit(eventName, fullPath);
};

FSWatcher.prototype._watchWithFsEvents = function(path) {
  var watcher,
    _this = this;
  watcher = createFSEventsInstance(path, function(path, flags) {
    var emit, info;
    if (_this._isIgnored(path)) {
      return;
    }
    info = fsevents.getInfo(path, flags);
    emit = function(event) {
      var name;
      name = info.type === 'file' ? event : "" + event + "Dir";
      if (event === 'add' || event === 'addDir') {
        _this._addToWatchedDir(sysPath.dirname(path), sysPath.basename(path));
      } else if (event === 'unlink' || event === 'unlinkDir') {
        _this._remove(sysPath.dirname(path), sysPath.basename(path));
        return; // Don't emit event twice.
      }
      return _this.emit(name, path);
    };
    switch (info.event) {
      case 'created':
        return emit('add');
      case 'modified':
        return emit('change');
      case 'deleted':
        return emit('unlink');
      case 'moved':
        return fs.stat(path, function(error, stats) {
          return emit((error || !stats ? 'unlink' : 'add'));
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
  var basename, directory, options, parent, watcher;
  if (callback == null) {
    callback = (function() {});
  }
  directory = sysPath.dirname(item);
  basename = sysPath.basename(item);
  parent = this._getWatchedDir(directory);
  if (parent.indexOf(basename) !== -1) {
    return;
  }
  this._addToWatchedDir(directory, basename);
  options = {
    persistent: this.options.persistent
  };
  if (this.options.usePolling) {
    options.interval = this.enableBinaryInterval && isBinaryPath(basename) ? this.options.binaryInterval : this.options.interval;
    return fs.watchFile(item, options, function(curr, prev) {
      if (curr.mtime.getTime() > prev.mtime.getTime()) {
        return callback(item, curr);
      }
    });
  } else {
    watcher = fs.watch(item, options, function(event, path) {
      return callback(item);
    });
    return this.watchers.push(watcher);
  }
};

// Private: Emit `change` event once and watch file to emit it in the future
// once the file is changed.

// file       - string, fs path.
// stats      - object, result of executing stat(1) on file.
// initialAdd - boolean, was the file added at the launch?

// Returns nothing.
FSWatcher.prototype._handleFile = function(file, stats, initialAdd) {
  var _this = this;
  if (initialAdd == null) {
    initialAdd = false;
  }
  this._watch(file, function(file, newStats) {
    return _this.emit('change', file, newStats);
  });
  if (!(initialAdd && this.options.ignoreInitial)) {
    return this.emit('add', file, stats);
  }
};

// Private: Read directory to add / remove files from `@watched` list
// and re-read it on change.

// directory - string, fs path.

// Returns nothing.
FSWatcher.prototype._handleDir = function(directory, stats, initialAdd) {
  var read,
    _this = this;
  read = function(directory, initialAdd) {
    return fs.readdir(directory, function(error, current) {
      var previous;
      if (error != null) {
        return _this.emit('error', error);
      }
      if (!current) {
        return;
      }

      previous = _this._getWatchedDir(directory);

      // Files that absent in current directory snapshot
      // but present in previous emit `remove` event
      // and are removed from @watched[directory].
      previous.filter(function(file) {
        return current.indexOf(file) === -1;
      }).forEach(function(file) {
        return _this._remove(directory, file);
      });

      // Files that present in current directory snapshot
      // but absent in previous are added to watch list and
      // emit `add` event.
      current.filter(function(file) {
        return previous.indexOf(file) === -1;
      }).forEach(function(file) {
        _this._handle(sysPath.join(directory, file), initialAdd);
      });
    });
  };
  read(directory, initialAdd);
  this._watch(directory, function(dir) {
    return read(dir, false);
  });
  if (!(initialAdd && this.options.ignoreInitial)) {
    return this.emit('addDir', directory, stats);
  }
};

// Private: Handle added file or directory.
// Delegates call to _handleFile / _handleDir after checks.

// item - string, path to file or directory.

// Returns nothing.
FSWatcher.prototype._handle = function(item, initialAdd) {
  var _this = this;
  if (this._isIgnored(item)) {
    return;
  }
  return fs.realpath(item, function(error, path) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    if (error != null) {
      return _this.emit('error', error);
    }
    return fs.stat(path, function(error, stats) {
      if (error != null) {
        return _this.emit('error', error);
      }
      if (_this.options.ignorePermissionErrors && (!_this._hasReadPermissions(stats))) {
        return;
      }
      if (_this._isIgnored.length === 2 && _this._isIgnored(item, stats)) {
        return;
      }
      if (stats.isFile()) {
        _this._handleFile(item, stats, initialAdd);
      }
      if (stats.isDirectory()) {
        return _this._handleDir(item, stats, initialAdd);
      }
    });
  });
};

FSWatcher.prototype.emit = function() {
  var args, event;
  event = arguments[0], args = 2 <= arguments.length ? __slice.call(arguments, 1) : [];
  EventEmitter.prototype.emit.apply(this, [event].concat(__slice.call(args)));
  if (event === 'add' || event === 'addDir' || event === 'change' || event === 'unlink' || event === 'unlinkDir') {
    return EventEmitter.prototype.emit.apply(this, ['all', event].concat(__slice.call(args)));
  }
};

FSWatcher.prototype._addToFsEvents = function(files) {
  var handle,
    _this = this;
  handle = function(path) {
    return _this.emit('add', path);
  };
  files.forEach(function(file) {
    if (!_this.options.ignoreInitial) {
      fs.stat(file, function(error, stats) {
        if (error != null) {
          return _this.emit('error', error);
        }
        if (stats.isDirectory()) {
          return recursiveReaddir(file, function(error, dirFiles) {
            if (error != null) {
              return _this.emit('error', error);
            }
            return dirFiles.filter(function(path) {
              return !_this._isIgnored(path);
            }).forEach(handle);
          });
        } else {
          return handle(file);
        }
      });
    }
    return _this._watchWithFsEvents(file);
  });
  return this;
};

// Public: Adds directories / files for tracking.

// * files - array of strings (file paths).

// Examples

//   add ['app', 'vendor']

// Returns an instance of FSWatcher for chaning.
FSWatcher.prototype.add = function(files) {
  var _this = this;
  if (this._initialAdd == null) this._initialAdd = true;
  if (!Array.isArray(files)) files = [files];

  if (this.options.useFsEvents) return this._addToFsEvents(files);

  files.forEach(function(file) {
    return _this._handle(file, _this._initialAdd);
  });
  this._initialAdd = false;
  return this;
};

// Public: Remove all listeners from watched files.
// Returns an instance of FSWatcher for chaning.
FSWatcher.prototype.close = function() {
  var _this = this;
  this.watchers.forEach(function(watcher) {
    if (_this.options.useFsEvents) {
      return watcher.stop();
    } else {
      return watcher.close();
    }
  });
  if (this.options.usePolling) {
    Object.keys(this.watched).forEach(function(directory) {
      return _this.watched[directory].forEach(function(file) {
        return fs.unwatchFile(sysPath.join(directory, file));
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
