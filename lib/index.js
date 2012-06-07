'use strict';

var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var sysPath = require('path');


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
function FSWatcher(options) {
  this.options = options = options != null ? options : {};
  this._handle = this._handle.bind(this);
  this.watched = {};
  this.watchers = [];
  if (this.options.persistent == null) {
    this.options.persistent = false;
  }
  this._ignored = (function() {
    switch (toString.call(options.ignored)) {
      case '[object RegExp]':
        return function(string) {
          return options.ignored.test(string);
        };
      case '[object Function]':
        return options.ignored;
      default:
        return function() {
          return false;
        };
    }
  })();
}

// Inherit from EventEmitter.
FSWatcher.prototype = Object.create(EventEmitter.prototype);

FSWatcher.prototype._getWatchedDir = function(directory) {
  directory = directory.replace(/\/$/, '');
  if (this.watched[directory] == null) this.watched[directory] = [];
  return this.watched[directory];
};

FSWatcher.prototype._addToWatchedDir = function(directory, file) {
  var watchedFiles = this._getWatchedDir(directory);
  watchedFiles.push(file);
};

FSWatcher.prototype._removeFromWatchedDir = function(directory, file) {
  var watchedFiles = this._getWatchedDir(directory);
  watchedFiles.some(function(watchedFile, index) {
    if (watchedFile === file) {
      watchedFiles.splice(index, 1);
      return true;
    }
  });
};

// Private: Watch file for changes with fs.watchFile or fs.watch.
//
// item     - string, path to file or directory.
// callback - function that will be executed on fs change.
//
// Returns nothing.
FSWatcher.prototype._watch = function(item, callback) {
  var _this = this;
  var options, watcher;
  if (callback == null) callback = function() {};
  var directory = sysPath.dirname(item)
  var basename = sysPath.basename(item);
  var parent = this._getWatchedDir(directory);
  // Prevent memory leaks.
  if (parent.indexOf(basename) >= 0) return;

  _this._addToWatchedDir(directory, basename);

  if (process.platform === 'win32') {
    watcher = fs.watch(item, {
      persistent: this.options.persistent
    }, function(event, path) {
      callback(item);
    });
    this.watchers.push(watcher);
  } else {
    options = {
      persistent: this.options.persistent,
      interval: 100
    };
    fs.watchFile(item, options, function(curr, prev) {
      if (curr.mtime.getTime() !== prev.mtime.getTime()) {
        callback(item);
      }
    });
  }
};

// Private: Emit `change` event once and watch file to emit it in the future
// once the file is changed.
//
// file - string, fs path.
//
// Returns nothing.
FSWatcher.prototype._handleFile = function(file) {
  var _this = this;
  this._watch(file, function(file) {
    _this.emit('change', file);
  });
  this.emit('add', file);
};

// Private: Read directory to add / remove files from `@watched` list
// and re-read it on change.
//
// directory - string, fs path.
//
// Returns nothing.
FSWatcher.prototype._handleDir = function(directory) {
  var _this = this;
  var read = function(directory) {
    fs.readdir(directory, function(error, current) {
      var previous;
      if (error != null) return _this.emit('error', error);
      if (!current) return;
      previous = _this._getWatchedDir(directory);

      // Files that absent in current directory snapshot
      // but present in previous emit `remove` event
      // and are removed from @watched[directory].
      previous
        .filter(function(file) {
          return current.indexOf(file) < 0;
        })
        .forEach(function(file) {
          _this._remove(directory,file);
        });

      // Files that present in current directory snapshot
      // but absent in previous are added to watch list and
      // emit `add` event.
      current
        .filter(function(file) {
          return previous.indexOf(file) < 0;
        })
        .forEach(function(file) {
          _this._handle(sysPath.join(directory, file));
        });
    });
  };
  read(directory);
  this._watch(directory, read);
};

// Private: Handles emitting unlink events for
// files and directories, and via recursion, for
// files and directories within directories that are unlinked
//
// directory - string, directory within which the following item is located
// item -      string, base path of item/directory
//
// Returns nothing.
FSWatcher.prototype._remove = function(directory, item) {
  var _this = this;

  // if what is being deleted is a directory, get that directory's paths
  // for recursive deleting and cleaning of watched object
  // if it is not a directory, nestedDirectoryChildren will be empty array
  var fullPath = sysPath.join(directory, item);
  var nestedDirectoryChildren = _this._getWatchedDir(fullPath).slice(); // need clone

  // remove this file/directory from watched list and emit unlink
  _this._removeFromWatchedDir(directory, item);
  _this.emit('unlink', fullPath);

  // recurse
  nestedDirectoryChildren.forEach(function(nestedItem) {
    _this._remove(fullPath, nestedItem);
  });
};

// Private: Handle added file or directory.
// Delegates call to _handleFile / _handleDir after checks.
//
// item - string, path to file or directory.
//
// Returns nothing.
FSWatcher.prototype._handle = function(item) {
  var _this = this;
  // Don't handle invalid files, dotfiles etc.
  if (this._ignored(item)) return;
  // Get the canonicalized absolute pathname.
  fs.realpath(item, function(error, path) {
    if (error != null) return _this.emit('error', error);
    // Get file info, check is it file, directory or something else.
    fs.stat(item, function(error, stats) {
      if (error != null) return _this.emit('error', error);
      if (stats.isFile()) _this._handleFile(item);
      if (stats.isDirectory()) _this._handleDir(item);
    });
  });
};

// Public: Adds directories / files for tracking.
//
// * files - array of strings (file paths).
//
// Examples
//
//   add ['app', 'vendor']
//
// Returns an instance of FSWatcher for chaning.
FSWatcher.prototype.add = function(files) {
  if (!Array.isArray(files)) files = [files];
  files.forEach(this._handle);
  return this;
};

// Public: Remove all listeners from watched files.
// Returns an instance of FSWatcher for chaning.
FSWatcher.prototype.close = function() {
  var _this = this;
  this.watchers.forEach(function(watcher) {
    watcher.close();
  });
  Object.keys(this.watched).forEach(function(directory) {
    _this.watched[directory].forEach(function(file) {
      fs.unwatchFile(sysPath.join(directory, file));
    });
  });
  this.watched = {};
  return this;
};

exports.watch = function(files, options) {
  return new FSWatcher(options).add(files);
};
