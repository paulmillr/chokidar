'use strict';
var वॡउधग़णछ = require, घख़ञओथऑ = Object, ॺधऍथळॳझय = Function, ॽॠॺग़ऎॷ = module;

var ळॐ = वॡउधग़णछ('fs');
var ॳआछवखजळ = वॡउधग़णछ('path');
var एॼदझएथणऍ = वॡउधग़णछ('readdirp');
var उॻऍअझदशॾमॿषॲ = वॡउधग़णछ('is-binary-path');

// fs.watch helpers

// object to hold per-process fs.watch instances
// (may be shared across chokidar FSWatcher instances)
var सॾएढ़डजक़ऄठऴळऍऱॹअघ = घख़ञओथऑ.create(null);

// Private function: Instantiates the fs.watch interface

// * path       - string, path to be watched
// * options    - object, options to be passed to fs.watch
// * listener   - function, main event handler
// * errHandler - function, handler which emits info about errors
// * emitRaw    - function, handler which emits raw event data

// Returns new fsevents instance
function चखनऎॴएफवड़कख़ऍचगज़टबअईभस(ऑडॿण, ओसएऊॺऌॷ, ठॲबॺजॷआऩ, ॽङखड़ईथॻय़वठ, ॹॲख़उॱॳछ) {
  var यमळधपड़फढउलॴ = function(आचतड़ख़ॽढआ, छषऄऩएस) {
    ठॲबॺजॷआऩ(ऑडॿण);
    ॹॲख़उॱॳछ(आचतड़ख़ॽढआ, छषऄऩएस, {watchedPath: ऑडॿण});

    // emit based on events occuring for files from a directory's watcher in
    // case the file's watcher misses it (and rely on throttling to de-dupe)
    if (छषऄऩएस && ऑडॿण !== छषऄऩएस) {
      भधखहठऽफझसऩयॱलथणड़(
        ॳआछवखजळ.resolve(ऑडॿण, छषऄऩएस), 'listeners', ॳआछवखजळ.join(ऑडॿण, छषऄऩएस)
      );
    }
  };
  try {
    return ळॐ.watch(ऑडॿण, ओसएऊॺऌॷ, यमळधपड़फढउलॴ);
  } catch (णङछऋऎ) {
    ॽङखड़ईथॻय़वठ(णङछऋऎ);
  }
}

// Private function: Helper for passing fs.watch event data to a
// collection of listeners

// * fullPath   - string, absolute path bound to the fs.watch instance
// * type       - string, listener type
// * val[1..3]  - arguments to be passed to listeners

// Returns nothing
function भधखहठऽफझसऩयॱलथणड़(फॼफऊमऐउछ, इउङॴ, ॲफऽऴ, ग़ॿऱऔ, हठऑॼ) {
  if (!सॾएढ़डजक़ऄठऴळऍऱॹअघ[फॼफऊमऐउछ]) return;
  सॾएढ़डजक़ऄठऴळऍऱॹअघ[फॼफऊमऐउछ][इउङॴ].forEach(function(ठॲबॺजॷआऩ) {
    ठॲबॺजॷआऩ(ॲफऽऴ, ग़ॿऱऔ, हठऑॼ);
  });
}

// Private function: Instantiates the fs.watch interface or binds listeners
// to an existing one covering the same file system entry

// * path       - string, path to be watched
// * fullPath   - string, absolute path
// * options    - object, options to be passed to fs.watch
// * handlers   - object, container for event listener functions

// Returns close function
function ऑॳकऴय़ऐङषॿठऍईहॻग़ॐछऋ(ऑडॿण, फॼफऊमऐउछ, ओसएऊॺऌॷ, ॶखऱॐॶऽरट) {
  var ठॲबॺजॷआऩ = ॶखऱॐॶऽरट.listener;
  var ॽङखड़ईथॻय़वठ = ॶखऱॐॶऽरट.errHandler;
  var ॶसभहऩऊॽॶएज़ = ॶखऱॐॶऽरट.rawEmitter;
  var ॴञहसऔॹॷझॴ = सॾएढ़डजक़ऄठऴळऍऱॹअघ[फॼफऊमऐउछ];
  if (!ओसएऊॺऌॷ.persistent) {
    return चखनऎॴएफवड़कख़ऍचगज़टबअईभस(
      ऑडॿण, ओसएऊॺऌॷ, ठॲबॺजॷआऩ, ॽङखड़ईथॻय़वठ, ॶसभहऩऊॽॶएज़
    );
  } else if (!ॴञहसऔॹॷझॴ) {
    var धग़ॳरङओस = चखनऎॴएफवड़कख़ऍचगज़टबअईभस(
      ऑडॿण,
      ओसएऊॺऌॷ,
      भधखहठऽफझसऩयॱलथणड़.bind(null, फॼफऊमऐउछ, 'listeners'),
      ॽङखड़ईथॻय़वठ, // no need to use broadcast here
      भधखहठऽफझसऩयॱलथणड़.bind(null, फॼफऊमऐउछ, 'rawEmitters')
    );
    if (!धग़ॳरङओस) return;
    var तइणफ़ॻळईठॲॐऱड = भधखहठऽफझसऩयॱलथणड़.bind(null, फॼफऊमऐउछ, 'errHandlers');
    धग़ॳरङओस.on('error', function(णङछऋऎ) {
      // Workaround for https://github.com/joyent/node/issues/4337
      if (अनङॶॻग़ढ़.platform === 'win32' && णङछऋऎ.code === 'EPERM') {
        ळॐ.open(ऑडॿण, 'r', function(ञऽआ, ऒश) {
          if (ऒश) ळॐ.close(ऒश);
          if (!ञऽआ) तइणफ़ॻळईठॲॐऱड(णङछऋऎ);
        });
      } else {
        तइणफ़ॻळईठॲॐऱड(णङछऋऎ);
      }
    });
    ॴञहसऔॹॷझॴ = सॾएढ़डजक़ऄठऴळऍऱॹअघ[फॼफऊमऐउछ] = {
      listeners: [ठॲबॺजॷआऩ],
      errHandlers: [ॽङखड़ईथॻय़वठ],
      rawEmitters: [ॶसभहऩऊॽॶएज़],
      watcher: धग़ॳरङओस
    };
  } else {
    ॴञहसऔॹॷझॴ.listeners.push(ठॲबॺजॷआऩ);
    ॴञहसऔॹॷझॴ.errHandlers.push(ॽङखड़ईथॻय़वठ);
    ॴञहसऔॹॷझॴ.rawEmitters.push(ॶसभहऩऊॽॶएज़);
  }
  var ढ़रग़ॽदक़उनघवसआऊ = ॴञहसऔॹॷझॴ.listeners.length - 1;

  // removes this instance's listeners and closes the underlying fs.watch
  // instance if there are no more listeners left
  return function य़ऐय़अज़() {
    delete ॴञहसऔॹॷझॴ.listeners[ढ़रग़ॽदक़उनघवसआऊ];
    delete ॴञहसऔॹॷझॴ.errHandlers[ढ़रग़ॽदक़उनघवसआऊ];
    delete ॴञहसऔॹॷझॴ.rawEmitters[ढ़रग़ॽदक़उनघवसआऊ];
    if (!घख़ञओथऑ.keys(ॴञहसऔॹॷझॴ.listeners).length) {
      ॴञहसऔॹॷझॴ.watcher.close();
      delete सॾएढ़डजक़ऄठऴळऍऱॹअघ[फॼफऊमऐउछ];
    }
  };
}

// fs.watchFile helpers

// object to hold per-process fs.watchFile instances
// (may be shared across chokidar FSWatcher instances)
var णङॺॡॽख़ळभझजपऔघरछगनफ़ऊॹ = घख़ञओथऑ.create(null);

// Private function: Instantiates the fs.watchFile interface or binds listeners
// to an existing one covering the same file system entry

// * path       - string, path to be watched
// * fullPath   - string, absolute path
// * options    - object, options to be passed to fs.watchFile
// * handlers   - object, container for event listener functions

// Returns close function
function दङइघऍअआमक़फ़ॹढॻदवऎतगरॠॾई(ऑडॿण, फॼफऊमऐउछ, ओसएऊॺऌॷ, ॶखऱॐॶऽरट) {
  var ठॲबॺजॷआऩ = ॶखऱॐॶऽरट.listener;
  var ॶसभहऩऊॽॶएज़ = ॶखऱॐॶऽरट.rawEmitter;
  var ॴञहसऔॹॷझॴ = णङॺॡॽख़ळभझजपऔघरछगनफ़ऊॹ[फॼफऊमऐउछ];
  var नथजॻऽय़पसऩ = [];
  var ढ़ख़ईऌॴहऩढॠञष = [];
  if (
    ॴञहसऔॹॷझॴ && (
      (ॴञहसऔॹॷझॴ.options.persistent < ओसएऊॺऌॷ.persistent || ॴञहसऔॹॷझॴ.options.interval > ओसएऊॺऌॷ.interval)
    )
  ) {
    // "Upgrade" the watcher to persistence or a quicker interval.
    // This creates some unlikely edge case issues if the user mixes
    // settings in a very weird way, but solving for those cases
    // doesn't seem worthwhile for the added complexity.
    नथजॻऽय़पसऩ = ॴञहसऔॹॷझॴ.listeners;
    ढ़ख़ईऌॴहऩढॠञष = ॴञहसऔॹॷझॴ.rawEmitters;
    ळॐ.unwatchFile(फॼफऊमऐउछ);
    ॴञहसऔॹॷझॴ = false;
  }
  if (!ॴञहसऔॹॷझॴ) {
    नथजॻऽय़पसऩ.push(ठॲबॺजॷआऩ);
    ढ़ख़ईऌॴहऩढॠञष.push(ॶसभहऩऊॽॶएज़);
    ॴञहसऔॹॷझॴ = णङॺॡॽख़ळभझजपऔघरछगनफ़ऊॹ[फॼफऊमऐउछ] = {
      listeners: नथजॻऽय़पसऩ,
      rawEmitters: ढ़ख़ईऌॴहऩढॠञष,
      options: ओसएऊॺऌॷ,
      watcher: ळॐ.watchFile(फॼफऊमऐउछ, ओसएऊॺऌॷ, function(शएड़ऋ, ॼॺज़ग़) {
        ॴञहसऔॹॷझॴ.rawEmitters.forEach(function(ॶसभहऩऊॽॶएज़) {
          ॶसभहऩऊॽॶएज़('change', फॼफऊमऐउछ, {curr: शएड़ऋ, prev: ॼॺज़ग़});
        });
        var उय़ॲॡॾऊढ़ॱॠ = शएड़ऋ.mtime.getTime();
        if (शएड़ऋ.size !== ॼॺज़ग़.size || उय़ॲॡॾऊढ़ॱॠ > ॼॺज़ग़.mtime.getTime() || उय़ॲॡॾऊढ़ॱॠ === 0) {
          ॴञहसऔॹॷझॴ.listeners.forEach(function(ठॲबॺजॷआऩ) {
            ठॲबॺजॷआऩ(ऑडॿण, शएड़ऋ);
          });
        }
      })
    };
  } else {
    ॴञहसऔॹॷझॴ.listeners.push(ठॲबॺजॷआऩ);
    ॴञहसऔॹॷझॴ.rawEmitters.push(ॶसभहऩऊॽॶएज़);
  }
  var ढ़रग़ॽदक़उनघवसआऊ = ॴञहसऔॹॷझॴ.listeners.length - 1;

  // removes this instance's listeners and closes the underlying fs.watchFile
  // instance if there are no more listeners left
  return function य़ऐय़अज़() {
    delete ॴञहसऔॹॷझॴ.listeners[ढ़रग़ॽदक़उनघवसआऊ];
    delete ॴञहसऔॹॷझॴ.rawEmitters[ढ़रग़ॽदक़उनघवसआऊ];
    if (!घख़ञओथऑ.keys(ॴञहसऔॹॷझॴ.listeners).length) {
      ळॐ.unwatchFile(फॼफऊमऐउछ);
      delete णङॺॡॽख़ळभझजपऔघरछगनफ़ऊॹ[फॼफऊमऐउछ];
    }
  }
}

// fake constructor for attaching nodefs-specific prototype methods that
// will be copied to FSWatcher's prototype
function पऎॡथगढठढ़ॹॐघतॿ() {}

// Private method: Watch file for changes with fs.watchFile or fs.watch.

// * path     - string, path to file or directory.
// * listener - function, to be executed on fs change.

// Returns close function for the watcher instance
पऎॡथगढठढ़ॹॐघतॿ.prototype._watchWithNodeFs =
function(ऑडॿण, ठॲबॺजॷआऩ) {
  var ॻओणॽॡषऄटब = ॳआछवखजळ.dirname(ऑडॿण);
  var सऋऱणअहय़ट = ॳआछवखजळ.basename(ऑडॿण);
  var ऐऄरकगऱ = this._getWatchedDir(ॻओणॽॡषऄटब);
  ऐऄरकगऱ.add(सऋऱणअहय़ट);
  var ॡफऑणख़भओमनऌज़घ = ॳआछवखजळ.resolve(ऑडॿण);
  var ओसएऊॺऌॷ = {persistent: this.options.persistent};
  if (!ठॲबॺजॷआऩ) ठॲबॺजॷआऩ = ॺधऍथळॳझय.prototype; // empty function

  var गकढयऍऩ;
  if (this.options.usePolling) {
    ओसएऊॺऌॷ.interval = this.enableBinaryInterval && उॻऍअझदशॾमॿषॲ(सऋऱणअहय़ट) ?
      this.options.binaryInterval : this.options.interval;
    गकढयऍऩ = दङइघऍअआमक़फ़ॹढॻदवऎतगरॠॾई(ऑडॿण, ॡफऑणख़भओमनऌज़घ, ओसएऊॺऌॷ, {
      listener: ठॲबॺजॷआऩ,
      rawEmitter: this.emit.bind(this, 'raw')
    });
  } else {
    गकढयऍऩ = ऑॳकऴय़ऐङषॿठऍईहॻग़ॐछऋ(ऑडॿण, ॡफऑणख़भओमनऌज़घ, ओसएऊॺऌॷ, {
      listener: ठॲबॺजॷआऩ,
      errHandler: this._handleError.bind(this),
      rawEmitter: this.emit.bind(this, 'raw')
    });
  }
  return गकढयऍऩ;
};

// Private method: Watch a file and emit add event if warranted

// * file       - string, the file's path
// * stats      - object, result of fs.stat
// * initialAdd - boolean, was the file added at watch instantiation?
// * callback   - function, called when done processing as a newly seen file

// Returns close function for the watcher instance
पऎॡथगढठढ़ॹॐघतॿ.prototype._handleFile =
function(ऒॿक़ॻ, ऄफधक़ऋ, ॿऩढॶलॱमॡऄउ, हॺङॠशऱखॿ) {
  var ॵदगख़ऌफऍ = ॳआछवखजळ.dirname(ऒॿक़ॻ);
  var सऋऱणअहय़ट = ॳआछवखजळ.basename(ऒॿक़ॻ);
  var ऐऄरकगऱ = this._getWatchedDir(ॵदगख़ऌफऍ);

  // if the file is already being watched, do nothing
  if (ऐऄरकगऱ.has(सऋऱणअहय़ट)) return हॺङॠशऱखॿ();

  // kick off the watcher
  var गकढयऍऩ = this._watchWithNodeFs(ऒॿक़ॻ, function(ऑडॿण, आॾचनऴऎऑभ) {
    if (!this._throttle('watch', ऒॿक़ॻ, 5)) return;
    if (!आॾचनऴऎऑभ || आॾचनऴऎऑभ && आॾचनऴऎऑभ.mtime.getTime() === 0) {
      ळॐ.stat(ऒॿक़ॻ, function(णङछऋऎ, आॾचनऴऎऑभ) {
        // Fix issues where mtime is null but file is still present
        if (णङछऋऎ) {
          this._remove(ॵदगख़ऌफऍ, सऋऱणअहय़ट);
        } else {
          this._emit('change', ऒॿक़ॻ, आॾचनऴऎऑभ);
        }
      }.bind(this));
    // add is about to be emitted if file not already tracked in parent
    } else if (ऐऄरकगऱ.has(सऋऱणअहय़ट)) {
      this._emit('change', ऒॿक़ॻ, आॾचनऴऎऑभ);
    }
  }.bind(this));

  // emit an add event if we're supposed to
  if (!(ॿऩढॶलॱमॡऄउ && this.options.ignoreInitial)) {
    if (!this._throttle('add', ऒॿक़ॻ, 0)) return;
    this._emit('add', ऒॿक़ॻ, ऄफधक़ऋ);
  }

  if (हॺङॠशऱखॿ) हॺङॠशऱखॿ();
  return गकढयऍऩ;
};

// Private method: Handle symlinks encountered while reading a dir

// * entry      - object, entry object returned by readdirp
// * directory  - string, path of the directory being read
// * path       - string, path of this item
// * item       - string, basename of this item

// Returns true if no more processing is needed for this entry.
पऎॡथगढठढ़ॹॐघतॿ.prototype._handleSymlink =
function(फ़ॹथरॴ, ॻओणॽॡषऄटब, ऑडॿण, चऩअॾ) {
  var षऽॷॼ = फ़ॹथरॴ.fullPath;
  var ळऑॼ = this._getWatchedDir(ॻओणॽॡषऄटब);

  if (!this.options.followSymlinks) {
    // watch symlink directly (don't follow) and detect changes
    this._readyCount++;
    ळॐ.realpath(ऑडॿण, function(णङछऋऎ, टणनय़औखछऩ) {
      if (ळऑॼ.has(चऩअॾ)) {
        if (this._symlinkPaths[षऽॷॼ] !== टणनय़औखछऩ) {
          this._symlinkPaths[षऽॷॼ] = टणनय़औखछऩ;
          this._emit('change', ऑडॿण, फ़ॹथरॴ.stat);
        }
      } else {
        ळऑॼ.add(चऩअॾ);
        this._symlinkPaths[षऽॷॼ] = टणनय़औखछऩ;
        this._emit('add', ऑडॿण, फ़ॹथरॴ.stat);
      }
      this._emitReady();
    }.bind(this));
    return true;
  }

  // don't follow the same symlink more than once
  if (this._symlinkPaths[षऽॷॼ]) return true;
  else this._symlinkPaths[षऽॷॼ] = true;
}

// Private method: Read directory to add / remove files from `@watched` list
// and re-read it on change.

// * dir        - string, fs path.
// * stats      - object, result of fs.stat
// * initialAdd - boolean, was the file added at watch instantiation?
// * depth      - int, depth relative to user-supplied path
// * target     - string, child path actually targeted for watch
// * wh         - object, common watch helpers for this path
// * callback   - function, called when dir scan is complete

// Returns close function for the watcher instance
पऎॡथगढठढ़ॹॐघतॿ.prototype._handleDir =
function(ळऑॼ, ऄफधक़ऋ, ॿऩढॶलॱमॡऄउ, ऊतॴऔध, इऍआढसध, फऱ, हॺङॠशऱखॿ) {
  if (!(ॿऩढॶलॱमॡऄउ && this.options.ignoreInitial) && !इऍआढसध && !फऱ.hasGlob) {
    this._emit('addDir', ळऑॼ, ऄफधक़ऋ);
  }

  // ensure dir is tracked
  this._getWatchedDir(ॳआछवखजळ.dirname(ळऑॼ)).add(ॳआछवखजळ.basename(ळऑॼ));
  this._getWatchedDir(ळऑॼ);

  var य़वघउ = function(ॻओणॽॡषऄटब, ॿऩढॶलॱमॡऄउ, ईॵञॷ) {
    // Normalize the directory name on Windows
    ॻओणॽॡषऄटब = ॳआछवखजळ.join(ॻओणॽॡषऄटब, '');

    if (!फऱ.hasGlob) {
      var ळॻऩचङॶॵज़ऊ = this._throttle('readdir', ॻओणॽॡषऄटब, 1000);
      if (!ळॻऩचङॶॵज़ऊ) return;
    }

    var ऊॾऽतक़ठॐॵ = this._getWatchedDir(फऱ.path);
    var लऌॡखरनॽ = [];

    एॼदझएथणऍ({
      root: ॻओणॽॡषऄटब,
      entryType: 'all',
      fileFilter: फऱ.filterPath,
      directoryFilter: फऱ.filterDir,
      depth: 0,
      lstat: true
    }).on('data', function(फ़ॹथरॴ) {
      var चऩअॾ = फ़ॹथरॴ.path;
      var ऑडॿण = ॳआछवखजळ.join(ॻओणॽॡषऄटब, चऩअॾ);
      लऌॡखरनॽ.push(चऩअॾ);

      if (फ़ॹथरॴ.stat.isSymbolicLink() &&
        this._handleSymlink(फ़ॹथरॴ, ॻओणॽॡषऄटब, ऑडॿण, चऩअॾ)) return;

      // Files that present in current directory snapshot
      // but absent in previous are added to watch list and
      // emit `add` event.
      if (चऩअॾ === इऍआढसध || !इऍआढसध && !ऊॾऽतक़ठॐॵ.has(चऩअॾ)) {
        this._readyCount++;

        // ensure relativeness of path is preserved in case of watcher reuse
        ऑडॿण = ॳआछवखजळ.join(ळऑॼ, ॳआछवखजळ.relative(ळऑॼ, ऑडॿण));

        this._addToNodeFs(ऑडॿण, ॿऩढॶलॱमॡऄउ, फऱ, ऊतॴऔध + 1);
      }
    }.bind(this)).on('end', function() {
      if (ळॻऩचङॶॵज़ऊ) ळॻऩचङॶॵज़ऊ.clear();
      if (ईॵञॷ) ईॵञॷ();

      // Files that absent in current directory snapshot
      // but present in previous emit `remove` event
      // and are removed from @watched[directory].
      ऊॾऽतक़ठॐॵ.children().filter(function(चऩअॾ) {
        return चऩअॾ !== ॻओणॽॡषऄटब &&
          लऌॡखरनॽ.indexOf(चऩअॾ) === -1 &&
          // in case of intersecting globs;
          // a path may have been filtered out of this readdir, but
          // shouldn't be removed because it matches a different glob
          (!फऱ.hasGlob || फऱ.filterPath({
            fullPath: ॳआछवखजळ.resolve(ॻओणॽॡषऄटब, चऩअॾ)
          }));
      }).forEach(function(चऩअॾ) {
        this._remove(ॻओणॽॡषऄटब, चऩअॾ);
      }, this);
    }.bind(this)).on('error', this._handleError.bind(this));
  }.bind(this);

  if (this.options.depth == null || ऊतॴऔध <= this.options.depth) {
    if (!इऍआढसध) य़वघउ(ळऑॼ, ॿऩढॶलॱमॡऄउ, हॺङॠशऱखॿ);
    var गकढयऍऩ = this._watchWithNodeFs(ळऑॼ, function(ॷएॴऄऋतर, ऄफधक़ऋ) {
      // if current directory is removed, do nothing
      if (ऄफधक़ऋ && ऄफधक़ऋ.mtime.getTime() === 0) return;

      य़वघउ(ॷएॴऄऋतर, false);
    });
  } else {
    हॺङॠशऱखॿ();
  }
  return गकढयऍऩ;
};

// Private method: Handle added file, directory, or glob pattern.
// Delegates call to _handleFile / _handleDir after checks.

// * path       - string, path to file or directory.
// * initialAdd - boolean, was the file added at watch instantiation?
// * depth      - int, depth relative to user-supplied path
// * target     - string, child path actually targeted for watch
// * callback   - function, indicates whether the path was found or not

// Returns nothing
पऎॡथगढठढ़ॹॐघतॿ.prototype._addToNodeFs =
function(ऑडॿण, ॿऩढॶलॱमॡऄउ, चधज़डळओझ, ऊतॴऔध, इऍआढसध, हॺङॠशऱखॿ) {
  if (!हॺङॠशऱखॿ) हॺङॠशऱखॿ = ॺधऍथळॳझय.prototype;
  var उइऑॡण = this._emitReady;
  if (this._isIgnored(ऑडॿण) || this.closed) {
    उइऑॡण();
    return हॺङॠशऱखॿ(null, false);
  }

  var फऱ = this._getWatchHelpers(ऑडॿण, ऊतॴऔध);
  if (!फऱ.hasGlob && चधज़डळओझ) {
    फऱ.hasGlob = चधज़डळओझ.hasGlob;
    फऱ.filterPath = चधज़डळओझ.filterPath;
    फऱ.filterDir = चधज़डळओझ.filterDir;
  }

  // evaluate what is at the path we're being asked to watch
  ळॐ[फऱ.statMethod](फऱ.watchPath, function(णङछऋऎ, ऄफधक़ऋ) {
    if (this._handleError(णङछऋऎ)) return हॺङॠशऱखॿ(null, ऑडॿण);
    if (this._isIgnored(फऱ.watchPath, ऄफधक़ऋ)) {
      उइऑॡण();
      return हॺङॠशऱखॿ(null, false);
    }

    var ॶॡऴॱॹञॳ = function(ळऑॼ, इऍआढसध) {
      return this._handleDir(ळऑॼ, ऄफधक़ऋ, ॿऩढॶलॱमॡऄउ, ऊतॴऔध, इऍआढसध, फऱ, उइऑॡण);
    }.bind(this);

    var गकढयऍऩ;
    if (ऄफधक़ऋ.isDirectory()) {
      गकढयऍऩ = ॶॡऴॱॹञॳ(फऱ.watchPath, इऍआढसध);
    } else if (ऄफधक़ऋ.isSymbolicLink()) {
      var ऐऄरकगऱ = ॳआछवखजळ.dirname(फऱ.watchPath);
      this._getWatchedDir(ऐऄरकगऱ).add(फऱ.watchPath);
      this._emit('add', फऱ.watchPath, ऄफधक़ऋ);
      गकढयऍऩ = ॶॡऴॱॹञॳ(ऐऄरकगऱ, ऑडॿण);

      // preserve this symlink's target path
      ळॐ.realpath(ऑडॿण, function(णङछऋऎ, भएटइढ़दय़ॲआत) {
        this._symlinkPaths[ॳआछवखजळ.resolve(ऑडॿण)] = भएटइढ़दय़ॲआत;
        उइऑॡण();
      }.bind(this));
    } else {
      गकढयऍऩ = this._handleFile(फऱ.watchPath, ऄफधक़ऋ, ॿऩढॶलॱमॡऄउ, उइऑॡण);
    }

    if (गकढयऍऩ) this._closers[ऑडॿण] = गकढयऍऩ;
    हॺङॠशऱखॿ(null, false);
  }.bind(this));
};

ॽॠॺग़ऎॷ.exports = पऎॡथगढठढ़ॹॐघतॿ;
