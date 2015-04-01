'use strict';
var खय़दइखॼए = require, ॐङॠपहक़ = Object, वहऩरऔञक़ङऑ = undefined, चरऋॾङख = module;

var फथ = खय़दइखॼए('fs');
var गफऍॶबऩण = खय़दइखॼए('path');
var शॴङॲरॠऩओ = खय़दइखॼए('readdirp');
var ढ़ॺफतशढ़ॲख;
try { ढ़ॺफतशढ़ॲख = खय़दइखॼए('fsevents'); } catch (यक़ख़ञई) {}

// fsevents instance helper functions

// object to hold per-process fsevents instances
// (may be shared across chokidar FSWatcher instances)
var ॿआउकयझहॿऐऽड़पऎॶॱई = ॐङॠपहक़.create(null);

// Private function: Instantiates the fsevents interface

// * path       - string, path to be watched
// * callback   - function, called when fsevents is bound and ready

// Returns new fsevents instance
function ॲहड़ठशॠऴएअॴऄऽमॐघफॷॼलऌफ़ख़(खढऄॹ, ऒभञॐओऐटक) {
  return (new ढ़ॺफतशढ़ॲख(खढऄॹ)).on('fsevent', ऒभञॐओऐटक).start();
}

// Private function: Instantiates the fsevents interface or binds listeners
// to an existing one covering the same file tree

// * path       - string, path to be watched
// * realPath   - string, real path (in case of symlinks)
// * listener   - function, called when fsevents emits events
// * rawEmitter - function, passes data to listeners of the 'raw' event

// Returns close function
function ॴऩॹॿथॵकढदइखऑॼङडसघऐड़(खढऄॹ, आऑकऽऌनॐम, ऊॠणक़ऽॽऎद, ऍङग़इबचॡञभऩ) {
  var दॴऋमऒऩकऐब = गफऍॶबऩण.extname(खढऄॹ) ? गफऍॶबऩण.dirname(खढऄॹ) : खढऄॹ;
  var सङचटधख़ज़झशलखतईढ;

  var ऽॡॷॲॶझय़इवफढॳ = गफऍॶबऩण.resolve(खढऄॹ);
  var ॵसड़नऒएफ़चऔढ = ऽॡॷॲॶझय़इवफढॳ !== आऑकऽऌनॐम;
  function ॵदमॱॷकठऱऩणढऊॶअहउ(एसभॷॶइअध, ॴठॹईक, ढसॿआ) {
    if (ॵसड़नऒएफ़चऔढ) एसभॷॶइअध = एसभॷॶइअध.replace(आऑकऽऌनॐम, ऽॡॷॲॶझय़इवफढॳ);
    if (
      एसभॷॶइअध === ऽॡॷॲॶझय़इवफढॳ ||
      !एसभॷॶइअध.indexOf(ऽॡॷॲॶझय़इवफढॳ + गफऍॶबऩण.sep)
    ) ऊॠणक़ऽॽऎद(एसभॷॶइअध, ॴठॹईक, ढसॿआ);
  }

  // check if there is already a watcher on a parent path
  // modifies `watchPath` to the parent path when it finds a match
  function ज़ऐॱमढळऱऩक़ऑखॽए() {
    return ॐङॠपहक़.keys(ॿआउकयझहॿऐऽड़पऎॶॱई).some(function(क़धफओऎघऐझपख़इ) {
      // condition is met when indexOf returns 0
      if (!आऑकऽऌनॐम.indexOf(गफऍॶबऩण.resolve(क़धफओऎघऐझपख़इ) + गफऍॶबऩण.sep)) {
        दॴऋमऒऩकऐब = क़धफओऎघऐझपख़इ;
        return true;
      }
    });
  }

  if (दॴऋमऒऩकऐब in ॿआउकयझहॿऐऽड़पऎॶॱई || ज़ऐॱमढळऱऩक़ऑखॽए()) {
    सङचटधख़ज़झशलखतईढ = ॿआउकयझहॿऐऽड़पऎॶॱई[दॴऋमऒऩकऐब];
    सङचटधख़ज़झशलखतईढ.listeners.push(ॵदमॱॷकठऱऩणढऊॶअहउ);
  } else {
    सङचटधख़ज़झशलखतईढ = ॿआउकयझहॿऐऽड़पऎॶॱई[दॴऋमऒऩकऐब] = {
      listeners: [ॵदमॱॷकठऱऩणढऊॶअहउ],
      rawEmitters: [ऍङग़इबचॡञभऩ],
      watcher: ॲहड़ठशॠऴएअॴऄऽमॐघफॷॼलऌफ़ख़(दॴऋमऒऩकऐब, function(एसभॷॶइअध, ॴठॹईक) {
        var ढसॿआ = ढ़ॺफतशढ़ॲख.getInfo(एसभॷॶइअध, ॴठॹईक);
        सङचटधख़ज़झशलखतईढ.listeners.forEach(function(ऊॠणक़ऽॽऎद) {
          ऊॠणक़ऽॽऎद(एसभॷॶइअध, ॴठॹईक, ढसॿआ);
        });
        सङचटधख़ज़झशलखतईढ.rawEmitters.forEach(function(ॽछणधॺजऽ) {
          ॽछणधॺजऽ(ढसॿआ.event, एसभॷॶइअध, ढसॿआ);
        });
      })
    };
  }
  var ॐउऌछणबॾअऊड़ॻमस = सङचटधख़ज़झशलखतईढ.listeners.length - 1;

  // removes this instance's listeners and closes the underlying fsevents
  // instance if there are no more listeners left
  return function ऩॠहकॾ() {
    delete सङचटधख़ज़झशलखतईढ.listeners[ॐउऌछणबॾअऊड़ॻमस];
    delete सङचटधख़ज़झशलखतईढ.rawEmitters[ॐउऌछणबॾअऊड़ॻमस];
    if (!ॐङॠपहक़.keys(सङचटधख़ज़झशलखतईढ.listeners).length) {
      सङचटधख़ज़झशलखतईढ.watcher.stop();
      delete ॿआउकयझहॿऐऽड़पऎॶॱई[दॴऋमऒऩकऐब];
    }
  }
}

// returns boolean indicating whether fsevents can be used
function जसकणॷप() {
  return ढ़ॺफतशढ़ॲख && ॐङॠपहक़.keys(ॿआउकयझहॿऐऽड़पऎॶॱई).length < 128;
}

// determines subdirectory traversal levels from root to path
function धॵकॿळ(खढऄॹ, ळऍऄॾ) {
  var ऎ = 0;
  while (!खढऄॹ.indexOf(ळऍऄॾ) && (खढऄॹ = गफऍॶबऩण.dirname(खढऄॹ)) !== ळऍऄॾ) ऎ++;
  return ऎ;
}

// fake constructor for attaching fsevents-specific prototype methods that
// will be copied to FSWatcher's prototype
function अॼङऱशकफ़हञक़जउगबॴ() {}

// Private method: Handle symlinks encountered during directory scan

// * wathPath   - string, file/dir path to be watched with fsevents
// * realPath   - string, real path (in case of symlinks)
// * transform  - function, path transformer
// * globFilter - function, path filter in case a glob pattern was provided

// Returns close function for the watcher instance
अॼङऱशकफ़हञक़जउगबॴ.prototype._watchWithFsEvents =
function(दॴऋमऒऩकऐब, आऑकऽऌनॐम, ॵॹएछदतहओॻ, खऊऱऒॾॡॳटड़ऋ) {
  if (this._isIgnored(दॴऋमऒऩकऐब)) return;
  var अऍऑकईबऩॡॻधऴमञ = function(एसभॷॶइअध, ॴठॹईक, ढसॿआ) {
    if (
      this.options.depth !== वहऩरऔञक़ङऑ &&
      धॵकॿळ(एसभॷॶइअध, आऑकऽऌनॐम) > this.options.depth
    ) return;
    var खढऄॹ = ॵॹएछदतहओॻ(गफऍॶबऩण.join(
      दॴऋमऒऩकऐब, गफऍॶबऩण.relative(दॴऋमऒऩकऐब, एसभॷॶइअध)
    ));
    if (खऊऱऒॾॡॳटड़ऋ && !खऊऱऒॾॡॳटड़ऋ(खढऄॹ)) return;
    // ensure directories are tracked
    var फॴणभचऩ = गफऍॶबऩण.dirname(खढऄॹ);
    var ऌय़षऐ = गफऍॶबऩण.basename(खढऄॹ);
    var य़ॴग़ॐऒॱधउपच = this._getWatchedDir(
      ढसॿआ.type === 'directory' ? खढऄॹ : फॴणभचऩ
    );
    var खषऑऱऎफ़डछॠॾपघ = function(ॹटॐऒझ) {
      if (this._isIgnored(खढऄॹ, ॹटॐऒझ)) {
        this._ignoredPaths[खढऄॹ] = true;
        if (ॹटॐऒझ && ॹटॐऒझ.isDirectory()) {
          this._ignoredPaths[खढऄॹ + '/**/*'] = true;
        }
        return true;
      } else {
        delete this._ignoredPaths[खढऄॹ];
        delete this._ignoredPaths[खढऄॹ + '/**/*'];
      }
    }.bind(this);

    var भॡॷईऊऍथऌलगख = function(ॱवइओम) {
      if (खषऑऱऎफ़डछॠॾपघ()) return;

      if (ॱवइओम === 'unlink') {
        // suppress unlink events on never before seen files
        if (ढसॿआ.type === 'directory' || य़ॴग़ॐऒॱधउपच.has(ऌय़षऐ)) {
          this._remove(फॴणभचऩ, ऌय़षऐ);
        }
      } else {
        if (ॱवइओम === 'add') {
          // track new directories
          if (ढसॿआ.type === 'directory') this._getWatchedDir(खढऄॹ);

          if (ढसॿआ.type === 'symlink' && this.options.followSymlinks) {
            // push symlinks back to the top of the stack to get handled
            var णघइऩरॐबण = this.options.depth === वहऩरऔञक़ङऑ ?
              वहऩरऔञक़ङऑ : धॵकॿळ(एसभॷॶइअध, आऑकऽऌनॐम) + 1;
            return this._addToFsEvents(खढऄॹ, false, true, णघइऩरॐबण);
          } else {
            // track new paths
            // (other than symlinks being followed, which will be tracked soon)
            this._getWatchedDir(फॴणभचऩ).add(ऌय़षऐ);
          }
        }
        var तचऊड़ॴॲॻसज़ = ढसॿआ.type === 'directory' ? ॱवइओम + 'Dir' : ॱवइओम;
        this._emit(तचऊड़ॴॲॻसज़, खढऄॹ);
      }
    }.bind(this);

    function ॷउयड़ॽएऩॼचढञ() {
      भॡॷईऊऍथऌलगख(य़ॴग़ॐऒॱधउपच.has(ऌय़षऐ) ? 'change' : 'add');
    }
    function ॺॳफ़लमॵन() {
      फथ.open(खढऄॹ, 'r', function(यक़ख़ञई, दथ) {
        if (दथ) फथ.close(दथ);
        यक़ख़ञई && यक़ख़ञई.code !== 'EACCES' ?
          भॡॷईऊऍथऌलगख('unlink') : ॷउयड़ॽएऩॼचढञ();
      });
    }
    // correct for wrong events emitted
    var पॳथरचॽऱईय़वऋॲक़गऑ = [
      69888, 70400, 71424, 72704, 73472, 131328, 131840, 262912
    ];
    if (पॳथरचॽऱईय़वऋॲक़गऑ.indexOf(ॴठॹईक) !== -1 || ढसॿआ.event === 'unknown') {
      if (typeof this.options.ignored === 'function') {
        फथ.stat(खढऄॹ, function(यक़ख़ञई, ॹटॐऒझ) {
          if (खषऑऱऎफ़डछॠॾपघ(ॹटॐऒझ)) return;
          ॹटॐऒझ ? ॷउयड़ॽएऩॼचढञ() : भॡॷईऊऍथऌलगख('unlink');
        });
      } else {
        ॺॳफ़लमॵन();
      }
    } else {
      switch (ढसॿआ.event) {
      case 'created':
      case 'modified':
        return ॷउयड़ॽएऩॼचढञ();
      case 'deleted':
      case 'moved':
        return ॺॳफ़लमॵन();
      }
    }
  }.bind(this);

  var थखॾऍनऌ = ॴऩॹॿथॵकढदइखऑॼङडसघऐड़(
    दॴऋमऒऩकऐब,
    आऑकऽऌनॐम,
    अऍऑकईबऩॡॻधऴमञ,
    this.emit.bind(this, 'raw')
  );

  this._emitReady();
  return थखॾऍनऌ;
};

// Private method: Handle symlinks encountered during directory scan

// * linkPath   - string, path to symlink
// * fullPath   - string, absolute path to the symlink
// * transform  - function, pre-existing path transformer
// * curDepth   - int, level of subdirectories traversed to where symlink is

// Returns nothing
अॼङऱशकफ़हञक़जउगबॴ.prototype._fsEventsSymlink =
function(खओञतसॷढघ, एसभॷॶइअध, ॵॹएछदतहओॻ, णघइऩरॐबण) {
  // don't follow the same symlink more than once
  if (this._symlinkPaths[एसभॷॶइअध]) return;
  else this._symlinkPaths[एसभॷॶइअध] = true;

  this._readyCount++;

  फथ.realpath(खओञतसॷढघ, function(यक़ख़ञई, ॺख़खॼडघॿओतम) {
    if (this._handleError(यक़ख़ञई) || this._isIgnored(ॺख़खॼडघॿओतम)) {
      return this._emitReady();
    }

    this._readyCount++;

    // add the linkTarget for watching with a wrapper for transform
    // that causes emitted paths to incorporate the link's path
    this._addToFsEvents(ॺख़खॼडघॿओतम || खओञतसॷढघ, function(खढऄॹ) {
      var ॡखॠॲधॡक़ॳ = '.' + गफऍॶबऩण.sep;
      var आऎरख़ॺईऋडऄऍव = खओञतसॷढघ;
      if (ॺख़खॼडघॿओतम && ॺख़खॼडघॿओतम !== ॡखॠॲधॡक़ॳ) {
        आऎरख़ॺईऋडऄऍव = खढऄॹ.replace(ॺख़खॼडघॿओतम, खओञतसॷढघ);
      } else if (खढऄॹ !== ॡखॠॲधॡक़ॳ) {
        आऎरख़ॺईऋडऄऍव = गफऍॶबऩण.join(खओञतसॷढघ, खढऄॹ);
      }
      return ॵॹएछदतहओॻ(आऎरख़ॺईऋडऄऍव);
    }, false, णघइऩरॐबण);
  }.bind(this));
};

// Private method: Handle added path with fsevents

// * path       - string, file/directory path or glob pattern
// * transform  - function, converts working path to what the user expects
// * forceAdd   - boolean, ensure add is emitted
// * priorDepth - int, level of subdirectories already traversed

// Returns nothing
अॼङऱशकफ़हञक़जउगबॴ.prototype._addToFsEvents =
function(खढऄॹ, ॵॹएछदतहओॻ, ईऍणॷॱइऋआ, ॻॶइभईथतऽरऑ) {

  // applies transform if provided, otherwise returns same value
  var घजघवक़औॠलभअऍ = typeof ॵॹएछदतहओॻ === 'function' ?
    ॵॹएछदतहओॻ : function(ओणॿ) { return ओणॿ; };

  var णवड़ऋॠॻन = function(खज़आथबॠञ, ॹटॐऒझ) {
    var ॱऩ = घजघवक़औॠलभअऍ(खज़आथबॠञ);
    var ॾॵहगॹ = ॹटॐऒझ.isDirectory();
    var ॶड़डञईऊ = this._getWatchedDir(गफऍॶबऩण.dirname(ॱऩ));
    var ज़णॲन = गफऍॶबऩण.basename(ॱऩ);

    // ensure empty dirs get tracked
    if (ॾॵहगॹ) this._getWatchedDir(ॱऩ);

    if (ॶड़डञईऊ.has(ज़णॲन)) return;
    ॶड़डञईऊ.add(ज़णॲन);

    if (!this.options.ignoreInitial || ईऍणॷॱइऋआ === true) {
      this._emit(ॾॵहगॹ ? 'addDir' : 'add', ॱऩ, ॹटॐऒझ);
    }
  }.bind(this);

  var थढ = this._getWatchHelpers(खढऄॹ);

  // evaluate what is at the path we're being asked to watch
  फथ[थढ.statMethod](थढ.watchPath, function(यक़ख़ञई, ॹटॐऒझ) {
    if (this._handleError(यक़ख़ञई) || this._isIgnored(थढ.watchPath, ॹटॐऒझ)) {
      this._emitReady();
      return this._emitReady();
    }

    if (ॹटॐऒझ.isDirectory()) {
      // emit addDir unless this is a glob parent
      if (!थढ.globFilter) णवड़ऋॠॻन(घजघवक़औॠलभअऍ(खढऄॹ), ॹटॐऒझ);

      // don't recurse further if it would exceed depth setting
      if (ॻॶइभईथतऽरऑ && ॻॶइभईथतऽरऑ > this.options.depth) return;

      // scan the contents of the dir
      शॴङॲरॠऩओ({
        root: थढ.watchPath,
        entryType: 'all',
        fileFilter: थढ.filterPath,
        directoryFilter: थढ.filterDir,
        lstat: true,
        depth: this.options.depth - (ॻॶइभईथतऽरऑ || 0)
      }).on('data', function(थदथङप) {
        // need to check filterPath on dirs b/c filterDir is less restrictive
        if (थदथङप.stat.isDirectory() && !थढ.filterPath(थदथङप)) return;

        var पफ़ॶबॡॺॳभॿट = गफऍॶबऩण.join(थढ.watchPath, थदथङप.path);
        var एसभॷॶइअध = थदथङप.fullPath;

        if (थढ.followSymlinks && थदथङप.stat.isSymbolicLink()) {
          // preserve the current depth here since it can't be derived from
          // real paths past the symlink
          var णघइऩरॐबण = this.options.depth === वहऩरऔञक़ङऑ ?
            वहऩरऔञक़ङऑ : धॵकॿळ(पफ़ॶबॡॺॳभॿट, गफऍॶबऩण.resolve(थढ.watchPath)) + 1;

          this._fsEventsSymlink(पफ़ॶबॡॺॳभॿट, एसभॷॶइअध, घजघवक़औॠलभअऍ, णघइऩरॐबण);
        } else {
          णवड़ऋॠॻन(पफ़ॶबॡॺॳभॿट, थदथङप.stat);
        }
      }.bind(this)).on('end', this._emitReady);
    } else {
      णवड़ऋॠॻन(थढ.watchPath, ॹटॐऒझ);
      this._emitReady();
    }
  }.bind(this));

  if (this.options.persistent) {
    var ॳमॳॡसॼयॱल = function(यक़ख़ञई, आऑकऽऌनॐम) {
      var थखॾऍनऌ = this._watchWithFsEvents(
        थढ.watchPath,
        गफऍॶबऩण.resolve(आऑकऽऌनॐम || थढ.watchPath),
        घजघवक़औॠलभअऍ,
        थढ.globFilter
      );
      if (थखॾऍनऌ) this._closers[खढऄॹ] = थखॾऍनऌ;
    }.bind(this);

    if (typeof ॵॹएछदतहओॻ === 'function') {
      // realpath has already been resolved
      ॳमॳॡसॼयॱल();
    } else {
      फथ.realpath(थढ.watchPath, ॳमॳॡसॼयॱल);
    }
  }
};

चरऋॾङख.exports = अॼङऱशकफ़हञक़जउगबॴ;
चरऋॾङख.exports.canUse = जसकणॷप;
