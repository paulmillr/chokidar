'use strict';
const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const sysPath = require('path');
const asyncEach = require('async-each');
const anymatch = require('anymatch');
const globParent = require('glob-parent');
const isGlob = require('is-glob');
const braces = require('braces');
const normalizePath = require('normalize-path');
const upath = require('upath');

const NodeFsHandler = require('./lib/nodefs-handler');
const FsEventsHandler = require('./lib/fsevents-handler');

const arrify = (value = []) => Array.isArray(value) ? value : [value];

const flatten = (list, result = []) => {
  list.forEach(item => {
    if (Array.isArray(item)) {
      flatten(item, result);
    } else {
      result.push(item);
    }
  });
  return result;
};

const dotRe = /\..*\.(sw[px])$|\~$|\.subl.*\.tmp/;
const replacerRe = /^\.[\/\\]/;

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
//  const watcher = new FSWatcher()
//    .add(directories)
//    .on('add', path => console.log('File', path, 'was added'))
//    .on('change', path => console.log('File', path, 'was changed'))
//    .on('unlink', path => console.log('File', path, 'was removed'))
//    .on('all', (event, path) => console.log(path, ' emitted ', event))
//
class FSWatcher extends EventEmitter {
// Not indenting methods for history sake; for now.
constructor(_opts) {
  super();
  const opts = {};
  // in case _opts that is passed in is a frozen object
  if (_opts) for (const opt in _opts) opts[opt] = _opts[opt];
  this._watched = Object.create(null);
  this._closers = Object.create(null);
  this._ignoredPaths = Object.create(null);
  Object.defineProperty(this, '_globIgnored', {
    get: function() { return Object.keys(this._ignoredPaths); }
  });
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
  if (undef('disableGlobbing')) opts.disableGlobbing = false;
  this.enableBinaryInterval = opts.binaryInterval !== opts.interval;

  // Enable fsevents on OS X when polling isn't explicitly enabled.
  if (undef('useFsEvents')) opts.useFsEvents = !opts.usePolling;

  // If we can't use fsevents, ensure the options reflect it's disabled.
  if (!FsEventsHandler.canUse()) opts.useFsEvents = false;

  // Use polling on Mac if not using fsevents.
  // Other platforms use non-polling fs_watch.
  if (undef('usePolling') && !opts.useFsEvents) {
    opts.usePolling = process.platform === 'darwin';
  }

  // Global override (useful for end-developers that need to force polling for all
  // instances of chokidar, regardless of usage/dependency depth)
  const envPoll = process.env.CHOKIDAR_USEPOLLING;
  if (envPoll !== undefined) {
    const envLower = envPoll.toLowerCase();

    if (envLower === 'false' || envLower === '0') {
      opts.usePolling = false;
    } else if (envLower === 'true' || envLower === '1') {
      opts.usePolling = true;
    } else {
      opts.usePolling = !!envLower;
    }
  }
  const envInterval = process.env.CHOKIDAR_INTERVAL;
  if (envInterval) {
    opts.interval = parseInt(envInterval);
  }

  // Editor atomic write handling enabled by default with fs.watch
  if (undef('atomic')) opts.atomic = !opts.usePolling && !opts.useFsEvents;

  if (undef('followSymlinks')) opts.followSymlinks = true;

  if (undef('awaitWriteFinish')) opts.awaitWriteFinish = false;
  if (opts.awaitWriteFinish === true) opts.awaitWriteFinish = {};
  const awf = opts.awaitWriteFinish;
  if (awf) {
    if (!awf.stabilityThreshold) awf.stabilityThreshold = 2000;
    if (!awf.pollInterval) awf.pollInterval = 100;

    this._pendingWrites = Object.create(null);
  }
  if (opts.ignored) opts.ignored = arrify(opts.ignored);

  this._isntIgnored = function(path, stat) {
    return !this._isIgnored(path, stat);
  }.bind(this);

  let readyCalls = 0;
  this._emitReady = function() {
    if (++readyCalls >= this._readyCount) {
      this._emitReady = Function.prototype;
      this._readyEmitted = true;
      // use process.nextTick to allow time for listener to be bound
      process.nextTick(this.emit.bind(this, 'ready'));
    }
  }.bind(this);

  this.options = opts;

  // You’re frozen when your heart’s not open.
  Object.freeze(opts);
}


// Common helpers
// --------------

// Private method: Normalize and emit events
//
// * event     - string, type of event
// * path      - string, file or directory path
// * val[1..3] - arguments to be passed with event
//
// Returns the error if defined, otherwise the value of the
// FSWatcher instance's `closed` flag
_emit(event, path, val1, val2, val3) {
  if (this.options.cwd) path = sysPath.relative(this.options.cwd, path);
  const args = [event, path];
  if (val3 !== undefined) args.push(val1, val2, val3);
  else if (val2 !== undefined) args.push(val1, val2);
  else if (val1 !== undefined) args.push(val1);

  const awf = this.options.awaitWriteFinish;
  if (awf && this._pendingWrites[path]) {
    this._pendingWrites[path].lastChange = new Date();
    return this;
  }

  const emitEvent = function() {
    this.emit.apply(this, args);
    if (event !== 'error') this.emit.apply(this, ['all'].concat(args));
  }.bind(this);

  if (awf && (event === 'add' || event === 'change') && this._readyEmitted) {
    const awfEmit = function(err, stats) {
      if (err) {
        event = args[0] = 'error';
        args[1] = err;
        emitEvent();
      } else if (stats) {
        // if stats doesn't exist the file must have been deleted
        if (args.length > 2) {
          args[2] = stats;
        } else {
          args.push(stats);
        }
        emitEvent();
      }
    };

    this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
    return this;
  }

  if (event === 'change') {
    if (!this._throttle('change', path, 50)) return this;
  }

  if (
    this.options.alwaysStat && val1 === undefined &&
    (event === 'add' || event === 'addDir' || event === 'change')
  ) {
    const fullPath = this.options.cwd ? sysPath.join(this.options.cwd, path) : path;
    fs.stat(fullPath, function(error, stats) {
      // Suppress event when fs_stat fails, to avoid sending undefined 'stat'
      if (error || !stats) return;

      args.push(stats);
      emitEvent();
    });
  } else {
    emitEvent();
  }

  return this;
}

// Private method: Common handler for errors
//
// * error  - object, Error instance
//
// Returns the error if defined, otherwise the value of the
// FSWatcher instance's `closed` flag
_handleError(error) {
  const code = error && error.code;
  const ipe = this.options.ignorePermissionErrors;
  if (error &&
    code !== 'ENOENT' &&
    code !== 'ENOTDIR' &&
    (!ipe || (code !== 'EPERM' && code !== 'EACCES'))
  ) this.emit('error', error);
  return error || this.closed;
}

// Private method: Helper utility for throttling
//
// * action  - string, type of action being throttled
// * path    - string, path being acted upon
// * timeout - int, duration of time to suppress duplicate actions
//
// Returns throttle tracking object or false if action should be suppressed
_throttle(action, path, timeout) {
  if (!(action in this._throttled)) {
    this._throttled[action] = Object.create(null);
  }
  const throttled = this._throttled[action];
  if (path in throttled) {
    throttled[path].count++;
    return false;
  }
  function clear() {
    const count = throttled[path] ? throttled[path].count : 0;
    delete throttled[path];
    clearTimeout(timeoutObject);
    return count;
  }
  const timeoutObject = setTimeout(clear, timeout);
  throttled[path] = {timeoutObject: timeoutObject, clear: clear, count: 0};
  return throttled[path];
}

// Private method: Awaits write operation to finish
//
// * path    - string, path being acted upon
// * threshold - int, time in milliseconds a file size must be fixed before
//                    acknowledging write operation is finished
// * awfEmit - function, to be called when ready for event to be emitted
// Polls a newly created file for size variations. When files size does not
// change for 'threshold' milliseconds calls callback.
_awaitWriteFinish(path, threshold, event, awfEmit) {
  let timeoutHandler;

  let fullPath = path;
  if (this.options.cwd && !sysPath.isAbsolute(path)) {
    fullPath = sysPath.join(this.options.cwd, path);
  }

  const now = new Date();

  const awaitWriteFinish = (function (prevStat) {
    fs.stat(fullPath, function(err, curStat) {
      if (err || !(path in this._pendingWrites)) {
        if (err && err.code !== 'ENOENT') awfEmit(err);
        return;
      }

      const now = new Date();

      if (prevStat && curStat.size != prevStat.size) {
        this._pendingWrites[path].lastChange = now;
      }

      if (now - this._pendingWrites[path].lastChange >= threshold) {
        delete this._pendingWrites[path];
        awfEmit(null, curStat);
      } else {
        timeoutHandler = setTimeout(
          awaitWriteFinish.bind(this, curStat),
          this.options.awaitWriteFinish.pollInterval
        );
      }
    }.bind(this));
  }.bind(this));

  if (!(path in this._pendingWrites)) {
    this._pendingWrites[path] = {
      lastChange: now,
      cancelWait: function() {
        delete this._pendingWrites[path];
        clearTimeout(timeoutHandler);
        return event;
      }.bind(this)
    };
    timeoutHandler = setTimeout(
      awaitWriteFinish.bind(this),
      this.options.awaitWriteFinish.pollInterval
    );
  }
}

// Private method: Determines whether user has asked to ignore this path
//
// * path  - string, path to file or directory
// * stats - object, result of fs_stat
//
// Returns boolean
_isIgnored(path, stats) {
  if (!this._userIgnored) {
    const cwd = this.options.cwd;
    let ignored = this.options.ignored;
    if (cwd && ignored) {
      ignored = ignored.map(function (path) {
        if (typeof path !== 'string') return path;
        return upath.normalize(sysPath.isAbsolute(path) ? path : sysPath.join(cwd, path));
      });
    }
    const paths = arrify(ignored)
      .filter(function(path) {
        return typeof path === 'string' && !isGlob(path);
      }).map(function(path) {
        return path + '/**';
      });
    this._userIgnored = anymatch(
      this._globIgnored.concat(ignored).concat(paths)
    );
  }

  return this._userIgnored([path, stats]);
}

// Private method: Provides a set of common helpers and properties relating to
// symlink and glob handling
//
// * path - string, file, directory, or glob pattern being watched
// * depth - int, at any depth > 0, this isn't a glob
//
// Returns object containing helpers for this path
_getWatchHelpers(path, depth) {
  path = path.replace(replacerRe, '');
  const watchPath = depth || this.options.disableGlobbing || !isGlob(path) ? path : globParent(path);
  const fullWatchPath = sysPath.resolve(watchPath);
  const hasGlob = watchPath !== path;
  const globFilter = hasGlob ? anymatch(path) : false;
  const follow = this.options.followSymlinks;
  let globSymlink = hasGlob && follow ? null : false;

  const checkGlobSymlink = function(entry) {
    // only need to resolve once
    // first entry should always have entry.parentDir === ''
    if (globSymlink == null) {
      globSymlink = entry.fullParentDir === fullWatchPath ? false : {
        realPath: entry.fullParentDir,
        linkPath: fullWatchPath
      };
    }

    if (globSymlink) {
      return entry.fullPath.replace(globSymlink.realPath, globSymlink.linkPath);
    }

    return entry.fullPath;
  };

  const entryPath = function(entry) {
    return sysPath.join(watchPath,
      sysPath.relative(watchPath, checkGlobSymlink(entry))
    );
  };

  const filterPath = function(entry) {
    if (entry.stat && entry.stat.isSymbolicLink()) return filterDir(entry);
    const resolvedPath = entryPath(entry);
    return (!hasGlob || globFilter(resolvedPath)) &&
      this._isntIgnored(resolvedPath, entry.stat) &&
      (this.options.ignorePermissionErrors ||
        this._hasReadPermissions(entry.stat));
  }.bind(this);

  const getDirParts = function(path) {
    if (!hasGlob) return false;
    const parts = [];
    const expandedPath = braces.expand(path);
    expandedPath.forEach(function(path) {
      parts.push(sysPath.relative(watchPath, path).split(/[\/\\]/));
    });
    return parts;
  };

  const dirParts = getDirParts(path);
  if (dirParts) {
    dirParts.forEach(function(parts) {
      if (parts.length > 1) parts.pop();
    });
  }
  let unmatchedGlob;

  const filterDir = function(entry) {
    if (hasGlob) {
      const entryParts = getDirParts(checkGlobSymlink(entry));
      let globstar = false;
      unmatchedGlob = !dirParts.some(function(parts) {
        return parts.every(function(part, i) {
          if (part === '**') globstar = true;
          return globstar || !entryParts[0][i] || anymatch(part, entryParts[0][i]);
        });
      });
    }
    return !unmatchedGlob && this._isntIgnored(entryPath(entry), entry.stat);
  }.bind(this);

  return {
    followSymlinks: follow,
    statMethod: follow ? 'stat' : 'lstat',
    path: path,
    watchPath: watchPath,
    entryPath: entryPath,
    hasGlob: hasGlob,
    globFilter: globFilter,
    filterPath: filterPath,
    filterDir: filterDir
  };
}

// Directory helpers
// -----------------

// Private method: Provides directory tracking objects
//
// * directory - string, path of the directory
//
// Returns the directory's tracking object
_getWatchedDir(directory) {
  const dir = sysPath.resolve(directory);
  const watcherRemove = this._remove.bind(this);
  if (!(dir in this._watched)) this._watched[dir] = {
    _items: Object.create(null),
    add: function(item) {
      if (item !== '.' && item !== '..') this._items[item] = true;
    },
    remove: function(item) {
      delete this._items[item];
      if (!this.children().length) {
        fs.readdir(dir, function(err) {
          if (err) watcherRemove(sysPath.dirname(dir), sysPath.basename(dir));
        });
      }
    },
    has: function(item) {return item in this._items;},
    children: function() {return Object.keys(this._items);}
  };
  return this._watched[dir];
}

// File helpers
// ------------

// Private method: Check for read permissions
// Based on this answer on SO: http://stackoverflow.com/a/11781404/1358405
//
// * stats - object, result of fs_stat
//
// Returns boolean
_hasReadPermissions(stats) {
  return Boolean(4 & parseInt(((stats && stats.mode) & 0x1ff).toString(8)[0], 10));
}

// Private method: Handles emitting unlink events for
// files and directories, and via recursion, for
// files and directories within directories that are unlinked
//
// * directory - string, directory within which the following item is located
// * item      - string, base path of item/directory
//
// Returns nothing
_remove(directory, item) {
  // if what is being deleted is a directory, get that directory's paths
  // for recursive deleting and cleaning of watched object
  // if it is not a directory, nestedDirectoryChildren will be empty array
  const path = sysPath.join(directory, item);
  const fullPath = sysPath.resolve(path);
  const isDirectory = this._watched[path] || this._watched[fullPath];

  // prevent duplicate handling in case of arriving here nearly simultaneously
  // via multiple paths (such as _handleFile and _handleDir)
  if (!this._throttle('remove', path, 100)) return;

  // if the only watched file is removed, watch for its return
  const watchedDirs = Object.keys(this._watched);
  if (!isDirectory && !this.options.useFsEvents && watchedDirs.length === 1) {
    this.add(directory, item, true);
  }

  // This will create a new entry in the watched object in either case
  // so we got to do the directory check beforehand
  const nestedDirectoryChildren = this._getWatchedDir(path).children();

  // Recursively remove children directories / files.
  nestedDirectoryChildren.forEach(function(nestedItem) {
    this._remove(path, nestedItem);
  }, this);

  // Check if item was on the watched list and remove it
  const parent = this._getWatchedDir(directory);
  const wasTracked = parent.has(item);
  parent.remove(item);

  // If we wait for this file to be fully written, cancel the wait.
  let relPath = path;
  if (this.options.cwd) relPath = sysPath.relative(this.options.cwd, path);
  if (this.options.awaitWriteFinish && this._pendingWrites[relPath]) {
    const event = this._pendingWrites[relPath].cancelWait();
    if (event === 'add') return;
  }

  // The Entry will either be a directory that just got removed
  // or a bogus entry to a file, in either case we have to remove it
  delete this._watched[path];
  delete this._watched[fullPath];
  const eventName = isDirectory ? 'unlinkDir' : 'unlink';
  if (wasTracked && !this._isIgnored(path)) this._emit(eventName, path);

  // Avoid conflicts if we later create another file with the same name
  if (!this.options.useFsEvents) {
    this._closePath(path);
  }
}

_closePath(path) {
  if (!this._closers[path]) return;
  this._closers[path]();
  delete this._closers[path];
  this._getWatchedDir(sysPath.dirname(path)).remove(sysPath.basename(path));
}

// Public method: Adds paths to be watched on an existing FSWatcher instance

// * paths     - string or array of strings, file/directory paths and/or globs
// * _origAdd  - private boolean, for handling non-existent paths to be watched
// * _internal - private boolean, indicates a non-user add

// Returns an instance of FSWatcher for chaining.
add(paths, _origAdd, _internal) {
  const disableGlobbing = this.options.disableGlobbing;
  const cwd = this.options.cwd;
  this.closed = false;
  paths = flatten(arrify(paths));

  if (!paths.every(p => typeof p === 'string')) {
    throw new TypeError('Non-string provided as watch path: ' + paths);
  }

  if (cwd) paths = paths.map(function(path) {
    let absPath;
    if (sysPath.isAbsolute(path)) {
      absPath = path;
    } else if (path[0] === '!') {
      absPath = '!' + sysPath.join(cwd, path.substring(1));
    } else {
      absPath = sysPath.join(cwd, path);
    }

    // Check `path` instead of `absPath` because the cwd portion can't be a glob
    if (disableGlobbing || !isGlob(path)) {
      return absPath;
    } else {
      return normalizePath(absPath);
    }
  });

  if (this.options.atomic) {
    paths = paths.map(function(path) {
      // If `path` is already a glob, we do not have to do anything.
      if (isGlob(path)) {
        return path;
      }
      else {
        let splits = path.split(sysPath.sep);
        if (splits.length && splits[splits.length - 1]) {
          // We make the last segment of the path a glob pattern.
          // This type of a glob pattern is equivalent to the original name.
          splits[splits.length - 1] = '@(' + splits[splits.length - 1] + ')';
        }
        return splits.join(sysPath.sep);
      }
    });
  }

  // set aside negated glob strings
  paths = paths.filter(function(path) {
    if (path[0] === '!') {
      this._ignoredPaths[path.substring(1)] = true;
    } else {
      // if a path is being added that was previously ignored, stop ignoring it
      delete this._ignoredPaths[path];
      delete this._ignoredPaths[path + '/**'];

      // reset the cached userIgnored anymatch fn
      // to make ignoredPaths changes effective
      this._userIgnored = null;

      return true;
    }
  }, this);

  if (this.options.useFsEvents && FsEventsHandler.canUse()) {
    if (!this._readyCount) this._readyCount = paths.length;
    if (this.options.persistent) this._readyCount *= 2;
    paths.forEach(this._addToFsEvents, this);
  } else {
    if (!this._readyCount) this._readyCount = 0;
    this._readyCount += paths.length;
    asyncEach(paths, function(path, next) {
      this._addToNodeFs(path, !_internal, 0, 0, _origAdd, function(err, res) {
        if (res) this._emitReady();
        next(err, res);
      }.bind(this));
    }.bind(this), function(error, results) {
      results.forEach(function(item) {
        if (!item || this.closed) return;
        this.add(sysPath.dirname(item), sysPath.basename(_origAdd || item));
      }, this);
    }.bind(this));
  }

  return this;
}

// Public method: Close watchers or start ignoring events from specified paths.

// * paths     - string or array of strings, file/directory paths and/or globs

// Returns instance of FSWatcher for chaining.
unwatch(paths) {
  if (this.closed) return this;
  paths = flatten(arrify(paths));

  paths.forEach(function(path) {
    // convert to absolute path unless relative path already matches
    if (!sysPath.isAbsolute(path) && !this._closers[path]) {
      if (this.options.cwd) path = sysPath.join(this.options.cwd, path);
      path = sysPath.resolve(path);
    }

    this._closePath(path);

    this._ignoredPaths[path] = true;
    if (path in this._watched) {
      this._ignoredPaths[path + '/**'] = true;
    }

    // reset the cached userIgnored anymatch fn
    // to make ignoredPaths changes effective
    this._userIgnored = null;
  }, this);

  return this;
}

// Public method: Close watchers and remove all listeners from watched paths.

// Returns instance of FSWatcher for chaining.
close() {
  if (this.closed) return this;

  this.closed = true;
  Object.keys(this._closers).forEach(function(watchPath) {
    this._closers[watchPath]();
    delete this._closers[watchPath];
  }, this);
  this._watched = Object.create(null);

  this.removeAllListeners();
  return this;
}

// Public method: Expose list of watched paths

// Returns object w/ dir paths as keys and arrays of contained paths as values.
getWatched() {
  const watchList = {};
  Object.keys(this._watched).forEach(function(dir) {
    const key = this.options.cwd ? sysPath.relative(this.options.cwd, dir) : dir;
    watchList[key || '.'] = Object.keys(this._watched[dir]._items).sort();
  }.bind(this));
  return watchList;
}

}

// Attach watch handler prototype methods
Object.assign(FSWatcher.prototype, NodeFsHandler);
if (FsEventsHandler.canUse()) Object.assign(FSWatcher.prototype, FsEventsHandler);

// Export FSWatcher class
exports.FSWatcher = FSWatcher;

// Public function: Instantiates watcher with paths to be tracked.

// * paths     - string or array of strings, file/directory paths and/or globs
// * options   - object, chokidar options

// Returns an instance of FSWatcher for chaining.
exports.watch = (paths, options) => {
  return new FSWatcher(options).add(paths);
};
