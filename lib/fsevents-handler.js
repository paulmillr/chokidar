'use strict';

const fs = require('fs');
const sysPath = require('path');
let fsevents;
try { fsevents = require('fsevents'); } catch (error) {
  if (process.env.CHOKIDAR_PRINT_FSEVENTS_REQUIRE_ERROR) console.error(error);
}

if (fsevents) {
  // TODO: real check
  let mtch = process.version.match(/v(\d+)\.(\d+)/);
  if (mtch && mtch[1] && mtch[2]) {
    let maj = parseInt(mtch[1]);
    let min = parseInt(mtch[2]);
    if (maj === 8 && min < 16) {
      fsevents = null;
    }
  }
}

const Option = (key, value) => isNaN(value) ? {} : {[key]: value};

/**
 * @typedef {String} Path
 */

/**
 * @typedef {Object} FsEventsWatchContainer
 * @property {Set<Function>} listeners
 * @property {Function} rawEmitter
 * @property {{stop: Function}} watcher
 */

// fsevents instance helper functions
/**
 * Object to hold per-process fsevents instances (may be shared across chokidar FSWatcher instances)
 * @type {Map<Path,FsEventsWatchContainer>}
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
 * @param {Path} path path to be watched
 * @param {Function} callback called when fsevents is bound and ready
 * @returns {{stop: Function}} new fsevents instance
 */
const createFSEventsInstance = (path, callback) => {
  const stop = fsevents.watch(path, callback);
  return {stop};
};

/**
 * Instantiates the fsevents interface or binds listeners to an existing one covering
 * the same file tree.
 * @param {Path} path           - to be watched
 * @param {Path} realPath       - real path for symlinks
 * @param {Function} listener   - called when fsevents emits events
 * @param {Function} rawEmitter - passes data to listeners of the 'raw' event
 * @returns {Function} closer
 */
function setFSEventsListener(path, realPath, listener, rawEmitter) {
  let watchPath = sysPath.extname(path) ? sysPath.dirname(path) : path;
  const parentPath = sysPath.dirname(watchPath);
  let cont = FSEventsWatchers.get(watchPath);

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
  const watchedParent = () => {
    for (const watchedPath of FSEventsWatchers.keys()) {
      if (realPath.indexOf(sysPath.resolve(watchedPath) + sysPath.sep) === 0) {
        watchPath = watchedPath;
        cont = FSEventsWatchers.get(watchPath);
        return true;
      }
    }
  };

  if (cont || watchedParent()) {
    cont.listeners.add(filteredListener);
  } else {
    cont = {
      listeners: new Set([filteredListener]),
      rawEmitter: rawEmitter,
      watcher: createFSEventsInstance(watchPath, (fullPath, flags) => {
        const info = fsevents.getInfo(fullPath, flags);
        cont.listeners.forEach(list => {
          list(fullPath, flags, info);
        });

        cont.rawEmitter(info.event, fullPath, info);
      })
    };
    FSEventsWatchers.set(watchPath, cont);
  }

  // removes this instance's listeners and closes the underlying fsevents
  // instance if there are no more listeners left
  return function close() {
    const wl = cont.listeners;

    wl.delete(filteredListener);
    if (!wl.size) {
      FSEventsWatchers.delete(watchPath);
      cont.watcher.stop();
      cont.rawEmitter = cont.watcher = null;
      Object.freeze(cont);
      Object.freeze(cont.listeners);
    }
  };
}

// Decide whether or not we should start a new higher-level
// parent watcher
const couldConsolidate = (path) => {
  let count = 0;
  for (const watchPath of FSEventsWatchers.keys()) {
    if (watchPath.indexOf(path) === 0) {
      count++;
      if (count >= consolidateThreshhold) {
        return true;
      }
    }
  }

  return false;
};

// returns boolean indicating whether fsevents can be used
const canUse = () => fsevents && FSEventsWatchers.size < 128;

// determines subdirectory traversal levels from root to path
const depth = (path, root) => {
  let i = 0;
  while (!path.indexOf(root) && (path = sysPath.dirname(path)) !== root) i++;
  return i;
};

/**
 * @mixin
 */
class FsEventsHandler {

/**
 * @param {FSWatcher} fsW
 */
constructor(fsW) {
  const FSWatcher = require('../index').FSWatcher;
  this.fsw = fsW;
}

/**
 * Handle symlinks encountered during directory scan
 * @param {String} watchPath  - file/dir path to be watched with fsevents
 * @param {String} realPath   - real path (in case of symlinks)
 * @param {Function} transform  - path transformer
 * @param {Function} globFilter - path filter in case a glob pattern was provided
 * @returns {Function} closer for the watcher instance
*/
_watchWithFsEvents(watchPath, realPath, transform, globFilter) {

  if (this.fsw._isIgnored(watchPath)) return;
  const opts = this.fsw.options;
  const watchCallback = (fullPath, flags, info) => {
    if (
      opts.depth !== undefined &&
      depth(fullPath, realPath) > opts.depth
    ) return;
    const path = transform(sysPath.join(
      watchPath, sysPath.relative(watchPath, fullPath)
    ));
    if (globFilter && !globFilter(path)) return;
    // ensure directories are tracked
    const parent = sysPath.dirname(path);
    const item = sysPath.basename(path);
    const watchedDir = this.fsw._getWatchedDir(
      info.type === 'directory' ? path : parent
    );
    const checkIgnored = (stats) => {
      const ipaths = this.fsw._ignoredPaths;
      if (this.fsw._isIgnored(path, stats)) {
        ipaths.add(path);
        if (stats && stats.isDirectory()) {
          ipaths.add(path + '/**/*');
        }
        return true;
      } else {
        ipaths.delete(path);
        ipaths.delete(path + '/**/*');
      }
    };

    const handleEvent = (event) => {
      if (checkIgnored()) return;

      if (event === 'unlink') {
        // suppress unlink events on never before seen files
        if (info.type === 'directory' || watchedDir.has(item)) {
          this.fsw._remove(parent, item);
        }
      } else {
        if (event === 'add') {
          // track new directories
          if (info.type === 'directory') this.fsw._getWatchedDir(path);

          if (info.type === 'symlink' && opts.followSymlinks) {
            // push symlinks back to the top of the stack to get handled
            const curDepth = opts.depth === undefined ?
              undefined : depth(fullPath, realPath) + 1;
            return this._addToFsEvents(path, false, true, curDepth);
          } else {
            // track new paths
            // (other than symlinks being followed, which will be tracked soon)
            this.fsw._getWatchedDir(parent).add(item);
          }
        }
        /**
         * @type {'add'|'addDir'|'unlink'|'unlinkDir'}
         */
        const eventName = info.type === 'directory' ? event + 'Dir' : event;
        this.fsw._emit(eventName, path);
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
      if (typeof opts.ignored === 'function') {
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
    this.fsw._emitRaw
  );

  this.fsw._emitReady();
  return closer;
}

/**
 * Handle symlinks encountered during directory scan
 * @param {String} linkPath path to symlink
 * @param {String} fullPath absolute path to the symlink
 * @param {Function} transform pre-existing path transformer
 * @param {Number} curDepth level of subdirectories traversed to where symlink is
 * @returns {void}
 */
_handleFsEventsSymlink(linkPath, fullPath, transform, curDepth) {
  // don't follow the same symlink more than once
  if (this.fsw._symlinkPaths.has(fullPath)) return;

  this.fsw._symlinkPaths.set(fullPath, true);
  this.fsw._incrReadyCount();

  fs.realpath(linkPath, (error, linkTarget) => {
    if (this.fsw._handleError(error) || this.fsw._isIgnored(linkTarget)) {
      return this.fsw._emitReady();
    }

    this.fsw._incrReadyCount();

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
}

/**
 * Handle added path with fsevents
 * @param {String} path file/dir path or glob pattern
 * @param {Function|Boolean=} transform converts working path to what the user expects
 * @param {Boolean=} forceAdd ensure add is emitted
 * @param {Number=} priorDepth Level of subdirectories already traversed.
 * @returns {void}
 */
_addToFsEvents(path, transform, forceAdd, priorDepth) {
  const opts = this.fsw.options;
  const processPath = typeof transform === 'function' ? transform : (val => val);

  /**
   *
   * @param {Path} newPath
   * @param {fs.Stats} stats
   */
  const emitAdd = (newPath, stats) => {
    const pp = processPath(newPath);
    const isDir = stats.isDirectory();
    const dirObj = this.fsw._getWatchedDir(sysPath.dirname(pp));
    const base = sysPath.basename(pp);

    // ensure empty dirs get tracked
    if (isDir) this.fsw._getWatchedDir(pp);
    if (dirObj.has(base)) return;
    dirObj.add(base);

    if (!opts.ignoreInitial || forceAdd === true) {
      this.fsw._emit(isDir ? 'addDir' : 'add', pp, stats);
    }
  };

  const wh = this.fsw._getWatchHelpers(path);

  // evaluate what is at the path we're being asked to watch

  fs[wh.statMethod](wh.watchPath,
    /**
     * @param {Error} error
     * @param {fs.Stats} stats
     */
    (error, stats) => {
    if (this.fsw._handleError(error) || this.fsw._isIgnored(wh.watchPath, stats)) {
      this.fsw._emitReady();
      return this.fsw._emitReady();
    }

    if (stats.isDirectory()) {
      // emit addDir unless this is a glob parent
      if (!wh.globFilter) emitAdd(processPath(path), stats);

      // don't recurse further if it would exceed depth setting
      if (priorDepth && priorDepth > opts.depth) return;

      // scan the contents of the dir
      this.fsw._readdirp(wh.watchPath, {
        fileFilter: wh.filterPath,
        directoryFilter: wh.filterDir,
        ...Option("depth", opts.depth - (priorDepth || 0))
      }).on('data', (entry) => {
        // need to check filterPath on dirs b/c filterDir is less restrictive
        if (entry.stats.isDirectory() && !wh.filterPath(entry)) return;

        const joinedPath = sysPath.join(wh.watchPath, entry.path);
        const fullPath = entry.fullPath;

        if (wh.followSymlinks && entry.stats.isSymbolicLink()) {
          // preserve the current depth here since it can't be derived from
          // real paths past the symlink
          const curDepth = opts.depth === undefined ?
            undefined : depth(joinedPath, sysPath.resolve(wh.watchPath)) + 1;

          this._handleFsEventsSymlink(joinedPath, fullPath, processPath, curDepth);
        } else {
          emitAdd(joinedPath, entry.stats);
        }
      }).on('error', () => {/* Ignore readdirp errors */}).on('end', () => {
        this.fsw._emitReady();
      });
    } else {
      emitAdd(wh.watchPath, stats);
      this.fsw._emitReady();
    }
  });

  if (opts.persistent && forceAdd !== true) {
    const initWatch = (error, realPath) => {
      if (this.fsw.closed) return;
      const closer = this._watchWithFsEvents(
        wh.watchPath,
        sysPath.resolve(realPath || wh.watchPath),
        processPath,
        wh.globFilter
      );
      this.fsw._addPathCloser(path, closer);
    };

    if (typeof transform === 'function') {
      // realpath has already been resolved
      initWatch();
    } else {
      fs.realpath(wh.watchPath, initWatch);
    }
  }
}

}

module.exports = FsEventsHandler;
module.exports.canUse = canUse;
