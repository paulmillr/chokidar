'use strict';

const fs = require('fs');
const sysPath = require('path');
const readdirp = require('readdirp');
let fsevents;
try { fsevents = require('fsevents'); } catch (error) {
  if (process.env.CHOKIDAR_PRINT_FSEVENTS_REQUIRE_ERROR) console.error(error);
}

// fsevents instance helper functions
/**
 * Object to hold per-process fsevents instances (may be shared across chokidar FSWatcher instances)
 * @type {Map<String,any>}
 */
const FSEventsWatchers = new Map();

// Threshold of duplicate path prefixes at which to start
// consolidating going forward
const consolidateThreshhold = 10;

const wrongEventFlags = new Set([
  69888, 70400, 71424, 72704, 73472, 131328, 131840, 262912
]);

/**
 * Instantiates the fsevents interface
 * @param {String} path path to be watched
 * @param {Function} callback called when fsevents is bound and ready
 * @returns {Object} new fsevents instance
 */
const createFSEventsInstance = (path, callback) => {
  const stop = fsevents.watch(path, callback);
  return {stop};
};

// Private function: 

/**
 * Instantiates the fsevents interface or binds listeners to an existing one covering
 * the same file tree.
 * @param {String} path         - path to be watched
 * @param {String} realPath     - real path (in case of symlinks)
 * @param {Function} listener   - called when fsevents emits events
 * @param {Function} rawEmitter - passes data to listeners of the 'raw' event
 * @returns {Function} close function
 */
function setFSEventsListener(path, realPath, listener, rawEmitter) {
  let watchPath = sysPath.extname(path) ? sysPath.dirname(path) : path;
  let watchContainer;
  const parentPath = sysPath.dirname(watchPath);

  // If we've accumulated a substantial number of paths that
  // could have been consolidated by watching one directory
  // above the current one, create a watcher on the parent
  // path instead, so that we do consolidate going forward.
  if (couldConsolidate(parentPath)) {
    watchPath = parentPath;
  }

  const resolvedPath = sysPath.resolve(path);
  const hasSymlink = resolvedPath !== realPath;
  function filteredListener(fullPath, flags, info) {
    if (hasSymlink) fullPath = fullPath.replace(realPath, resolvedPath);
    if (
      fullPath === resolvedPath ||
      !fullPath.indexOf(resolvedPath + sysPath.sep)
    ) listener(fullPath, flags, info);
  }

  // check if there is already a watcher on a parent path
  // modifies `watchPath` to the parent path when it finds a match
  function watchedParent() {
    return Array.from(FSEventsWatchers.keys()).some((watchedPath) => {
      // condition is met when indexOf returns 0
      if (!realPath.indexOf(sysPath.resolve(watchedPath) + sysPath.sep)) {
        watchPath = watchedPath;
        return true;
      }
    });
  }

  if (FSEventsWatchers.has(watchPath) || watchedParent()) {
    watchContainer = FSEventsWatchers.get(watchPath);
    watchContainer.listeners.push(filteredListener);
  } else {
    watchContainer = {
      listeners: [filteredListener],
      rawEmitters: [rawEmitter],
      watcher: createFSEventsInstance(watchPath, (fullPath, flags) => {
        const info = fsevents.getInfo(fullPath, flags);
        watchContainer.listeners.forEach((listener) => {
          listener(fullPath, flags, info);
        });
        watchContainer.rawEmitters.forEach((emitter) => {
          emitter(info.event, fullPath, info);
        });
      })
    };
    FSEventsWatchers.set(watchPath, watchContainer);
  }
  const listenerIndex = watchContainer.listeners.length - 1;

  // removes this instance's listeners and closes the underlying fsevents
  // instance if there are no more listeners left
  return function close() {
    delete watchContainer.listeners[listenerIndex];
    delete watchContainer.rawEmitters[listenerIndex];
    if (!Object.keys(watchContainer.listeners).length) {
      watchContainer.watcher.stop();
      FSEventsWatchers.delete(watchPath);
    }
  };
}

// Decide whether or not we should start a new higher-level
// parent watcher
const couldConsolidate = (path) => {
  const keys = Array.from(FSEventsWatchers.keys());
  let count = 0;

  for (let i = 0, len = keys.length; i < len; ++i) {
    const watchPath = keys[i];
    if (watchPath.indexOf(path) === 0) {
      count++;
      if (count >= consolidateThreshhold) {
        return true;
      }
    }
  }

  return false;
}

// returns boolean indicating whether fsevents can be used
const canUse = () => fsevents && FSEventsWatchers.size < 128;

// determines subdirectory traversal levels from root to path
const depth = (path, root) => {
  let i = 0;
  while (!path.indexOf(root) && (path = sysPath.dirname(path)) !== root) i++;
  return i;
}

/**
 * @mixin
 */
const FsEventsHandler = {

/**
 * Private method: Handle symlinks encountered during directory scan
 * @param {String} watchPath  - string, file/dir path to be watched with fsevents
 * @param {String} realPath   - string, real path (in case of symlinks)
 * @param {Function} transform  - function, path transformer
 * @param {Function} globFilter - function, path filter in case a glob pattern was provided
 * Returns close function for the watcher instance
*/
_watchWithFsEvents(watchPath, realPath, transform, globFilter) {
  if (this._isIgnored(watchPath)) return;
  const watchCallback = (fullPath, flags, info) => {
    if (
      this.options.depth !== undefined &&
      depth(fullPath, realPath) > this.options.depth
    ) return;
    const path = transform(sysPath.join(
      watchPath, sysPath.relative(watchPath, fullPath)
    ));
    if (globFilter && !globFilter(path)) return;
    // ensure directories are tracked
    const parent = sysPath.dirname(path);
    const item = sysPath.basename(path);
    const watchedDir = this._getWatchedDir(
      info.type === 'directory' ? path : parent
    );
    const checkIgnored = (stats) => {
      if (this._isIgnored(path, stats)) {
        this._ignoredPaths.add(path);
        if (stats && stats.isDirectory()) {
          this._ignoredPaths.add(path + '/**/*');
        }
        return true;
      } else {
        this._ignoredPaths.delete(path);
        this._ignoredPaths.delete(path + '/**/*');
      }
    };

    const handleEvent = (event) => {
      if (checkIgnored()) return;

      if (event === 'unlink') {
        // suppress unlink events on never before seen files
        if (info.type === 'directory' || watchedDir.has(item)) {
          this._remove(parent, item);
        }
      } else {
        if (event === 'add') {
          // track new directories
          if (info.type === 'directory') this._getWatchedDir(path);

          if (info.type === 'symlink' && this.options.followSymlinks) {
            // push symlinks back to the top of the stack to get handled
            const curDepth = this.options.depth === undefined ?
              undefined : depth(fullPath, realPath) + 1;
            return this._addToFsEvents(path, false, true, curDepth);
          } else {
            // track new paths
            // (other than symlinks being followed, which will be tracked soon)
            this._getWatchedDir(parent).add(item);
          }
        }
        const eventName = info.type === 'directory' ? event + 'Dir' : event;
        this._emit(eventName, path);
        if (eventName === 'addDir') this._addToFsEvents(path, false, true);
      }
    };

    function addOrChange() {
      handleEvent(watchedDir.has(item) ? 'change' : 'add');
    }
    function checkFd() {
      fs.open(path, 'r', function opened(error, fd) {
        if (error) {
          if (error.code !== 'EACCES') {
            handleEvent('unlink');
          } else {
            addOrChange();
          }
        } else {
          fs.close(fd, function closed(err) {
            if (err && err.code !== 'EACCES') {
              handleEvent('unlink');
            } else {
              addOrChange();
            }
          });
        }
      });
    }
    // correct for wrong events emitted
    if (wrongEventFlags.has(flags) || info.event === 'unknown') {
      if (typeof this.options.ignored === 'function') {
        fs.stat(path, (error, stats) => {
          if (checkIgnored(stats)) return;
          stats ? addOrChange() : handleEvent('unlink');
        });
      } else {
        checkFd();
      }
    } else {
      switch (info.event) {
      case 'created':
      case 'modified':
        return addOrChange();
      case 'deleted':
      case 'moved':
        return checkFd();
      }
    }
  };

  const closer = setFSEventsListener(
    watchPath,
    realPath,
    watchCallback,
    this._emitRaw
  );

  this._emitReady();
  return closer;
},

// Private method: Handle symlinks encountered during directory scan

// * linkPath   - string, path to symlink
// * fullPath   - string, absolute path to the symlink
// * transform  - function, pre-existing path transformer
// * curDepth   - int, level of subdirectories traversed to where symlink is

// Returns nothing
_handleFsEventsSymlink(linkPath, fullPath, transform, curDepth) {
  // don't follow the same symlink more than once
  if (this._symlinkPaths.has(fullPath)) return;

  this._symlinkPaths.set(fullPath, true);
  this._readyCount++;

  fs.realpath(linkPath, (error, linkTarget) => {
    if (this._handleError(error) || this._isIgnored(linkTarget)) {
      return this._emitReady();
    }

    this._readyCount++;

    // add the linkTarget for watching with a wrapper for transform
    // that causes emitted paths to incorporate the link's path
    this._addToFsEvents(linkTarget || linkPath, (path) => {
      const dotSlash = '.' + sysPath.sep;
      let aliasedPath = linkPath;
      if (linkTarget && linkTarget !== dotSlash) {
        aliasedPath = path.replace(linkTarget, linkPath);
      } else if (path !== dotSlash) {
        aliasedPath = sysPath.join(linkPath, path);
      }
      return transform(aliasedPath);
    }, false, curDepth);
  });
},

/**
 * Handle added path with fsevents
 * @param {String} path file/dir path or glob pattern
 * @param {Function|Boolean} transform converts working path to what the user expects
 * @param {Boolean} forceAdd ensure add is emitted
 * @param {Number=} priorDepth Level of subdirectories already traversed.
 * @returns {void}
 */
_addToFsEvents(path, transform, forceAdd, priorDepth) {

  // applies transform if provided, otherwise returns same value
  const processPath = typeof transform === 'function' ?
    transform : (val => val);

  const emitAdd = (newPath, stats) => {
    const pp = processPath(newPath);
    const isDir = stats.isDirectory();
    const dirObj = this._getWatchedDir(sysPath.dirname(pp));
    const base = sysPath.basename(pp);

    // ensure empty dirs get tracked
    if (isDir) this._getWatchedDir(pp);

    if (dirObj.has(base)) return;
    dirObj.add(base);

    if (!this.options.ignoreInitial || forceAdd === true) {
      this._emit(isDir ? 'addDir' : 'add', pp, stats);
    }
  };

  const wh = this._getWatchHelpers(path);

  // evaluate what is at the path we're being asked to watch
  fs[wh.statMethod](wh.watchPath, (error, stats) => {
    if (this._handleError(error) || this._isIgnored(wh.watchPath, stats)) {
      this._emitReady();
      return this._emitReady();
    }

    if (stats.isDirectory()) {
      // emit addDir unless this is a glob parent
      if (!wh.globFilter) emitAdd(processPath(path), stats);

      // don't recurse further if it would exceed depth setting
      if (priorDepth && priorDepth > this.options.depth) return;

      // scan the contents of the dir
      readdirp({
        root: wh.watchPath,
        entryType: 'all',
        fileFilter: wh.filterPath,
        directoryFilter: wh.filterDir,
        lstat: true,
        depth: this.options.depth - (priorDepth || 0)
      }).on('data', (entry) => {
        // need to check filterPath on dirs b/c filterDir is less restrictive
        if (entry.stat.isDirectory() && !wh.filterPath(entry)) return;

        const joinedPath = sysPath.join(wh.watchPath, entry.path);
        const fullPath = entry.fullPath;

        if (wh.followSymlinks && entry.stat.isSymbolicLink()) {
          // preserve the current depth here since it can't be derived from
          // real paths past the symlink
          const curDepth = this.options.depth === undefined ?
            undefined : depth(joinedPath, sysPath.resolve(wh.watchPath)) + 1;

          this._handleFsEventsSymlink(joinedPath, fullPath, processPath, curDepth);
        } else {
          emitAdd(joinedPath, entry.stat);
        }
      }).on('error', () => {/* Ignore readdirp errors */}).on('end', this._emitReady);
    } else {
      emitAdd(wh.watchPath, stats);
      this._emitReady();
    }
  });

  if (this.options.persistent && forceAdd !== true) {
    const initWatch = (error, realPath) => {
      if (this.closed) return;
      const closer = this._watchWithFsEvents(
        wh.watchPath,
        sysPath.resolve(realPath || wh.watchPath),
        processPath,
        wh.globFilter
      );
      if (closer) this._closers.set(path, closer);
    };

    if (typeof transform === 'function') {
      // realpath has already been resolved
      initWatch();
    } else {
      fs.realpath(wh.watchPath, initWatch);
    }
  }
},

};

module.exports = FsEventsHandler;
module.exports.canUse = canUse;
