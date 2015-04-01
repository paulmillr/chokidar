'use strict';
var यॡचपषॾअ = require, ॺऌषईऽॽ = Object, ॽॐऩऱॵॾऄऽञ = undefined, ॽज़ऐॿॵटचण = Function, ॷॱछॿख़कॾ = Boolean, दङणखॷमऋस = parseInt, य़यमऽईॱइ = exports, ॾइढ़मऐऴय़ = process, आवॲड़गॱखरॺॽ = setTimeout, मॲॶषअसटणॴकबए = clearTimeout;
var ॺसपफ़घधडचऔजठऽ = यॡचपषॾअ('events').EventEmitter;
var ॾऱ = यॡचपषॾअ('fs');
var ॻथरऴॲॶऎ = यॡचपषॾअ('path');
var इढखॠ = यॡचपषॾअ('async-each');
var उभनषढबॶऍ = यॡचपषॾअ('anymatch');
var ऑटफओईॺयऩऄॐ = यॡचपषॾअ('glob-parent');
var डएऍञधव = यॡचपषॾअ('is-glob');
var ढबञशळऴ = यॡचपषॾअ('arrify');

var ऌङजॡखओऎॵॐय़सपछ = यॡचपषॾअ('./lib/nodefs-handler');
var एछऩॵपमणञऎलचड़ॲरज़ = यॡचपषॾअ('./lib/fsevents-handler');

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
function हऎड़ॼएशऍऒट(जॼसऒऐ) {
  var रऴटद = {};
  // in case _opts that is passed in is a frozen object
  if (जॼसऒऐ) for (var ॾबस in जॼसऒऐ) रऴटद[ॾबस] = जॼसऒऐ[ॾबस];
  this._watched = ॺऌषईऽॽ.create(null);
  this._closers = ॺऌषईऽॽ.create(null);
  this._ignoredPaths = ॺऌषईऽॽ.create(null);
  ॺऌषईऽॽ.defineProperty(this, '_globIgnored', {
    get: function() { return ॺऌषईऽॽ.keys(this._ignoredPaths); }
  });
  this.closed = false;
  this._throttled = ॺऌषईऽॽ.create(null);
  this._symlinkPaths = ॺऌषईऽॽ.create(null);

  function औओॲगथ(ढय़ब) {
    return रऴटद[ढय़ब] === ॽॐऩऱॵॾऄऽञ;
  }

  // Set up default options.
  if (औओॲगथ('persistent')) रऴटद.persistent = true;
  if (औओॲगथ('ignoreInitial')) रऴटद.ignoreInitial = false;
  if (औओॲगथ('ignorePermissionErrors')) रऴटद.ignorePermissionErrors = false;
  if (औओॲगथ('interval')) रऴटद.interval = 100;
  if (औओॲगथ('binaryInterval')) रऴटद.binaryInterval = 300;
  this.enableBinaryInterval = रऴटद.binaryInterval !== रऴटद.interval;

  // Enable fsevents on OS X when polling isn't explicitly enabled.
  if (औओॲगथ('useFsEvents')) रऴटद.useFsEvents = !रऴटद.usePolling;

  // If we can't use fsevents, ensure the options reflect it's disabled.
  if (!एछऩॵपमणञऎलचड़ॲरज़.canUse()) रऴटद.useFsEvents = false;

  // Use polling on Mac if not using fsevents.
  // Other platforms use non-polling fs.watch.
  if (औओॲगथ('usePolling') && !रऴटद.useFsEvents) {
    रऴटद.usePolling = ॾइढ़मऐऴय़.platform === 'darwin';
  }

  // Editor atomic write normalization enabled by default with fs.watch
  if (औओॲगथ('atomic')) रऴटद.atomic = !रऴटद.usePolling && !रऴटद.useFsEvents;
  if (रऴटद.atomic) this._pendingUnlinks = ॺऌषईऽॽ.create(null);

  if (औओॲगथ('followSymlinks')) रऴटद.followSymlinks = true;

  this._isntIgnored = function(बणऍऱ, ऌॺहऄ) {
    return !this._isIgnored(बणऍऱ, ऌॺहऄ);
  }.bind(this);

  var औझवकजऐअॱथञ = 0;
  this._emitReady = function() {
    if (++औझवकजऐअॱथञ >= this._readyCount) {
      this._emitReady = ॽज़ऐॿॵटचण.prototype;
      // use process.nextTick to allow time for listener to be bound
      ॾइढ़मऐऴय़.nextTick(this.emit.bind(this, 'ready'));
    }
  }.bind(this);

  this.options = रऴटद;

  // You’re frozen when your heart’s not open.
  ॺऌषईऽॽ.freeze(रऴटद);
}

हऎड़ॼएशऍऒट.prototype = ॺऌषईऽॽ.create(ॺसपफ़घधडचऔजठऽ.prototype);

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
हऎड़ॼएशऍऒट.prototype._emit = function(ख़षडॡट, बणऍऱ, सकफऒ, जय़खव, ॺथजऽ) {
  if (this.options.cwd) बणऍऱ = ॻथरऴॲॶऎ.relative(this.options.cwd, बणऍऱ);
  var ठकघॱ = [ख़षडॡट, बणऍऱ];
  if (ॺथजऽ !== ॽॐऩऱॵॾऄऽञ) ठकघॱ.push(सकफऒ, जय़खव, ॺथजऽ);
  else if (जय़खव !== ॽॐऩऱॵॾऄऽञ) ठकघॱ.push(सकफऒ, जय़खव);
  else if (सकफऒ !== ॽॐऩऱॵॾऄऽञ) ठकघॱ.push(सकफऒ);
  if (this.options.atomic) {
    if (ख़षडॡट === 'unlink') {
      this._pendingUnlinks[बणऍऱ] = ठकघॱ;
      आवॲड़गॱखरॺॽ(function() {
        ॺऌषईऽॽ.keys(this._pendingUnlinks).forEach(function(बणऍऱ) {
          this.emit.apply(this, this._pendingUnlinks[बणऍऱ]);
          this.emit.apply(this, ['all'].concat(this._pendingUnlinks[बणऍऱ]));
          delete this._pendingUnlinks[बणऍऱ];
        }.bind(this));
      }.bind(this), 100);
      return this;
    } else if (ख़षडॡट === 'add' && this._pendingUnlinks[बणऍऱ]) {
      ख़षडॡट = ठकघॱ[0] = 'change';
      delete this._pendingUnlinks[बणऍऱ];
    }
  }

  if (ख़षडॡट === 'change') {
    if (!this._throttle('change', बणऍऱ, 50)) return this;
  }

  var यओॴॡड़रपमऴ = function() {
    this.emit.apply(this, ठकघॱ);
    if (ख़षडॡट !== 'error') this.emit.apply(this, ['all'].concat(ठकघॱ));
  }.bind(this);

  if (
    this.options.alwaysStat && सकफऒ === ॽॐऩऱॵॾऄऽञ &&
    (ख़षडॡट === 'add' || ख़षडॡट === 'addDir' || ख़षडॡट === 'change')
  ) {
    ॾऱ.stat(बणऍऱ, function(धज़ऐगओ, रणॴऐॿ) {
      ठकघॱ.push(रणॴऐॿ);
      यओॴॡड़रपमऴ();
    });
  } else {
    यओॴॡड़रपमऴ();
  }

  return this;
};

// Private method: Common handler for errors
//
// * error  - object, Error instance
//
// Returns the error if defined, otherwise the value of the
// FSWatcher instance's `closed` flag
हऎड़ॼएशऍऒट.prototype._handleError = function(धज़ऐगओ) {
  var थडढठ = धज़ऐगओ && धज़ऐगओ.code;
  var ऋॶह = this.options.ignorePermissionErrors;
  if (धज़ऐगओ &&
    थडढठ !== 'ENOENT' &&
    थडढठ !== 'ENOTDIR' &&
    (!ऋॶह || (थडढठ !== 'EPERM' && थडढठ !== 'EACCES'))
  ) this.emit('error', धज़ऐगओ);
  return धज़ऐगओ || this.closed;
};

// Private method: Helper utility for throttling
//
// * action  - string, type of action being throttled
// * path    - string, path being acted upon
// * timeout - int, duration of time to suppress duplicate actions
//
// Returns throttle tracking object or false if action should be suppressed
हऎड़ॼएशऍऒट.prototype._throttle = function(ॱॽछथधख़, बणऍऱ, तॺऐफ़टॵज़) {
  if (!(ॱॽछथधख़ in this._throttled)) {
    this._throttled[ॱॽछथधख़] = ॺऌषईऽॽ.create(null);
  }
  var ज़ऴशॐयक़नॻअ = this._throttled[ॱॽछथधख़];
  if (बणऍऱ in ज़ऴशॐयक़नॻअ) return false;
  function इभथचऽ() {
    delete ज़ऴशॐयक़नॻअ[बणऍऱ];
    मॲॶषअसटणॴकबए(षमऽऌॻळचसतग़हछङ);
  }
  var षमऽऌॻळचसतग़हछङ = आवॲड़गॱखरॺॽ(इभथचऽ, तॺऐफ़टॵज़);
  ज़ऴशॐयक़नॻअ[बणऍऱ] = {timeoutObject: षमऽऌॻळचसतग़हछङ, clear: इभथचऽ};
  return ज़ऴशॐयक़नॻअ[बणऍऱ];
};

// Private method: Determines whether user has asked to ignore this path
//
// * path  - string, path to file or directory
// * stats - object, result of fs.stat
//
// Returns boolean
हऎड़ॼएशऍऒट.prototype._isIgnored = function(बणऍऱ, रणॴऐॿ) {
  if (
    this.options.atomic &&
    /\..*\.(sw[px])$|\~$|\.subl.*\.tmp/.test(बणऍऱ)
  ) return true;

  // create the anymatch fn if it doesn't already exist
  this._userIgnored = this._userIgnored || उभनषढबॶऍ(this._globIgnored
    .concat(this.options.ignored)
    .concat(ढबञशळऴ(this.options.ignored)
      .filter(function(बणऍऱ) {
        return typeof बणऍऱ === 'string' && !डएऍञधव(बणऍऱ);
      }).map(function(बणऍऱ) {
        return बणऍऱ + '/**/*';
      })
    )
  );

  return this._userIgnored([बणऍऱ, रणॴऐॿ]);
};

// Private method: Provides a set of common helpers and properties relating to
// symlink and glob handling
//
// * path - string, file, directory, or glob pattern being watched
// * depth - int, at any depth > 0, this isn't a glob
//
// Returns object containing helpers for this path
हऎड़ॼएशऍऒट.prototype._getWatchHelpers = function(बणऍऱ, सअॱषघ) {
  बणऍऱ = बणऍऱ.replace(/^\.[\/\\]/, '');
  var थसऌभढॽॲफ़ट = सअॱषघ ? बणऍऱ : ऑटफओईॺयऩऄॐ(बणऍऱ);
  var ऋबषइॡडॱ = थसऌभढॽॲफ़ट !== बणऍऱ;
  var लथॼईॠपॳफ़य़ऐ = ऋबषइॡडॱ ? उभनषढबॶऍ(बणऍऱ) : false;

  var ऐशआञऑऎऱढ़ॐ = function(फ़धछऍय) {
    return ॻथरऴॲॶऎ.join(थसऌभढॽॲफ़ट, ॻथरऴॲॶऎ.relative(थसऌभढॽॲफ़ट, फ़धछऍय.fullPath));
  }

  var झॼॾआऎॳगरय़फ = function(फ़धछऍय) {
    return (!ऋबषइॡडॱ || लथॼईॠपॳफ़य़ऐ(ऐशआञऑऎऱढ़ॐ(फ़धछऍय))) &&
      this._isntIgnored(ऐशआञऑऎऱढ़ॐ(फ़धछऍय), फ़धछऍय.stat) &&
      (this.options.ignorePermissionErrors ||
        this._hasReadPermissions(फ़धछऍय.stat));
  }.bind(this);

  var षॠचऒऩइनॐयऽॻ = function(बणऍऱ) {
    if (!ऋबषइॡडॱ) return false;
    var शगदॺॳ = ॻथरऴॲॶऎ.relative(थसऌभढॽॲफ़ट, बणऍऱ).split(/[\/\\]/);
    return शगदॺॳ;
  }
  var ङचयॲडखऴव = षॠचऒऩइनॐयऽॻ(बणऍऱ);
  if (ङचयॲडखऴव && ङचयॲडखऴव.length > 1) ङचयॲडखऴव.pop();

  var फ़ड़एईनढइउघ = function(फ़धछऍय) {
    if (ऋबषइॡडॱ) {
      var ख़ॠजथमऩॺसॲऱ = षॠचऒऩइनॐयऽॻ(फ़धछऍय.fullPath);
      var ॶउऔएदञयॐ = false;
      var ॵयशॽवडॶड़ॳॐङघॿ = !ङचयॲडखऴव.every(function(फऐॶळ, ॿ) {
        if (फऐॶळ === '**') ॶउऔएदञयॐ = true;
        return ॶउऔएदञयॐ || !ख़ॠजथमऩॺसॲऱ[ॿ] || उभनषढबॶऍ(फऐॶळ, ख़ॠजथमऩॺसॲऱ[ॿ]);
      });
    }
    return !ॵयशॽवडॶड़ॳॐङघॿ && this._isntIgnored(ऐशआञऑऎऱढ़ॐ(फ़धछऍय), फ़धछऍय.stat);
  }.bind(this);

  return {
    followSymlinks: this.options.followSymlinks,
    statMethod: this.options.followSymlinks ? 'stat' : 'lstat',
    path: बणऍऱ,
    watchPath: थसऌभढॽॲफ़ट,
    entryPath: ऐशआञऑऎऱढ़ॐ,
    hasGlob: ऋबषइॡडॱ,
    globFilter: लथॼईॠपॳफ़य़ऐ,
    filterPath: झॼॾआऎॳगरय़फ,
    filterDir: फ़ड़एईनढइउघ
  };
}

// Directory helpers
// -----------------

// Private method: Provides directory tracking objects
//
// * directory - string, path of the directory
//
// Returns the directory's tracking object
हऎड़ॼएशऍऒट.prototype._getWatchedDir = function(य़ड़ऑपफ़ॵॾऽॷ) {
  var ढ़ऋग़ = ॻथरऴॲॶऎ.resolve(य़ड़ऑपफ़ॵॾऽॷ);
  var ऽईचधठडढ़ज़अङरॠऐ = this._remove.bind(this);
  if (!(ढ़ऋग़ in this._watched)) this._watched[ढ़ऋग़] = {
    _items: ॺऌषईऽॽ.create(null),
    add: function(ऊॴलञ) {this._items[ऊॴलञ] = true;},
    remove: function(ऊॴलञ) {
      delete this._items[ऊॴलञ];
      if (!this.children().length) {
        ॾऱ.readdir(ढ़ऋग़, function(ऱऋर) {
          if (ऱऋर) ऽईचधठडढ़ज़अङरॠऐ(ॻथरऴॲॶऎ.dirname(ढ़ऋग़), ॻथरऴॲॶऎ.basename(ढ़ऋग़));
        });
      }
    },
    has: function(ऊॴलञ) {return ऊॴलञ in this._items;},
    children: function() {return ॺऌषईऽॽ.keys(this._items);}
  };
  return this._watched[ढ़ऋग़];
};

// File helpers
// ------------

// Private method: Check for read permissions
// Based on this answer on SO: http://stackoverflow.com/a/11781404/1358405
//
// * stats - object, result of fs.stat
//
// Returns boolean
हऎड़ॼएशऍऒट.prototype._hasReadPermissions = function(रणॴऐॿ) {
  return ॷॱछॿख़कॾ(4 & दङणखॷमऋस(((रणॴऐॿ && रणॴऐॿ.mode) & 0x1ff).toString(8)[0], 10));
};

// Private method: Handles emitting unlink events for
// files and directories, and via recursion, for
// files and directories within directories that are unlinked
//
// * directory - string, directory within which the following item is located
// * item      - string, base path of item/directory
//
// Returns nothing
हऎड़ॼएशऍऒट.prototype._remove = function(य़ड़ऑपफ़ॵॾऽॷ, ऊॴलञ) {
  // if what is being deleted is a directory, get that directory's paths
  // for recursive deleting and cleaning of watched object
  // if it is not a directory, nestedDirectoryChildren will be empty array
  var बणऍऱ = ॻथरऴॲॶऎ.join(य़ड़ऑपफ़ॵॾऽॷ, ऊॴलञ);
  var ग़यपसफॴईॺ = ॻथरऴॲॶऎ.resolve(बणऍऱ);
  var यहठॡॴमभय़ज़ॶद = this._watched[बणऍऱ] || this._watched[ग़यपसफॴईॺ];

  // prevent duplicate handling in case of arriving here nearly simultaneously
  // via multiple paths (such as _handleFile and _handleDir)
  if (!this._throttle('remove', बणऍऱ, 100)) return;

  // if the only watched file is removed, watch for its return
  var ऴऔथळऄढ़ॺलछमऩ = ॺऌषईऽॽ.keys(this._watched);
  if (!यहठॡॴमभय़ज़ॶद && !this.options.useFsEvents && ऴऔथळऄढ़ॺलछमऩ.length === 1) {
    this.add(य़ड़ऑपफ़ॵॾऽॷ, ऊॴलञ, true);
  }

  // This will create a new entry in the watched object in either case
  // so we got to do the directory check beforehand
  var खथदणॵय़मॱख़ठउऱऒकरखडभचऐघफट = this._getWatchedDir(बणऍऱ).children();

  // Recursively remove children directories / files.
  खथदणॵय़मॱख़ठउऱऒकरखडभचऐघफट.forEach(function(ऌफऎडॾचड़ॲऌन) {
    this._remove(बणऍऱ, ऌफऎडॾचड़ॲऌन);
  }, this);

  // Check if item was on the watched list and remove it
  var पखक़ङनल = this._getWatchedDir(य़ड़ऑपफ़ॵॾऽॷ);
  var एख़थऄञजॠॾभढ़ = पखक़ङनल.has(ऊॴलञ);
  पखक़ङनल.remove(ऊॴलञ);

  // The Entry will either be a directory that just got removed
  // or a bogus entry to a file, in either case we have to remove it
  delete this._watched[बणऍऱ];
  delete this._watched[ग़यपसफॴईॺ];
  var क़अॡऎऊॷऒछण = यहठॡॴमभय़ज़ॶद ? 'unlinkDir' : 'unlink';
  if (एख़थऄञजॠॾभढ़ && !this._isIgnored(बणऍऱ)) this._emit(क़अॡऎऊॷऒछण, बणऍऱ);
};

// Public method: Adds paths to be watched on an existing FSWatcher instance

// * paths     - string or array of strings, file/directory paths and/or globs
// * _origAdd  - private boolean, for handling non-existent paths to be watched
// * _internal - private boolean, indicates a non-user add

// Returns an instance of FSWatcher for chaining.
हऎड़ॼएशऍऒट.prototype.add = function(डकएसय़, ॳखऍदटझफ़ऊ, ॠॽॴॻनऌॠबफ़) {
  this.closed = false;
  डकएसय़ = ढबञशळऴ(डकएसय़);

  if (this.options.cwd) डकएसय़ = डकएसय़.map(function(बणऍऱ) {
    return ॻथरऴॲॶऎ.join(this.options.cwd, बणऍऱ);
  }, this);

  // set aside negated glob strings
  डकएसय़ = डकएसय़.filter(function(बणऍऱ) {
    if (बणऍऱ[0] === '!') this._ignoredPaths[बणऍऱ.substring(1)] = true;
    else {
      // if a path is being added that was previously ignored, stop ignoring it
      delete this._ignoredPaths[बणऍऱ];
      delete this._ignoredPaths[बणऍऱ + '/**/*'];

      // reset the cached userIgnored anymatch fn
      // to make ignoredPaths changes effective
      this._userIgnored = null;

      return true;
    }
  }, this);

  if (this.options.useFsEvents && एछऩॵपमणञऎलचड़ॲरज़.canUse()) {
    if (!this._readyCount) this._readyCount = डकएसय़.length;
    if (this.options.persistent) this._readyCount *= 2;
    डकएसय़.forEach(this._addToFsEvents, this);
  } else {
    if (!this._readyCount) this._readyCount = 0;
    this._readyCount += डकएसय़.length;
    इढखॠ(डकएसय़, function(बणऍऱ, ञहज़ऩ) {
      this._addToNodeFs(बणऍऱ, !ॠॽॴॻनऌॠबफ़, 0, 0, ॳखऍदटझफ़ऊ, function(ऱऋर, ॹॼग़) {
        if (ॹॼग़) this._emitReady();
        ञहज़ऩ(ऱऋर, ॹॼग़);
      }.bind(this));
    }.bind(this), function(धज़ऐगओ, ॐऎॻडगएख़) {
      ॐऎॻडगएख़.forEach(function(ऊॴलञ){
        if (!ऊॴलञ) return;
        this.add(ॻथरऴॲॶऎ.dirname(ऊॴलञ), ॻथरऴॲॶऎ.basename(ॳखऍदटझफ़ऊ || ऊॴलञ));
      }, this);
    }.bind(this));
  }

  return this;
};

// Public method: Close watchers or start ignoring events from specified paths.

// * paths     - string or array of strings, file/directory paths and/or globs

// Returns instance of FSWatcher for chaining.
हऎड़ॼएशऍऒट.prototype.unwatch = function(डकएसय़) {
  if (this.closed) return this;
  डकएसय़ = ढबञशळऴ(डकएसय़);

  डकएसय़.forEach(function(बणऍऱ) {
    if (this._closers[बणऍऱ]) {
      this._closers[बणऍऱ]();
    } else {
      this._ignoredPaths[बणऍऱ] = true;
      if (बणऍऱ in this._watched) this._ignoredPaths[बणऍऱ + '/**/*'] = true;

      // reset the cached userIgnored anymatch fn
      // to make ignoredPaths changes effective
      this._userIgnored = null;
    }
  }, this);

  return this;
};

// Public method: Close watchers and remove all listeners from watched paths.

// Returns instance of FSWatcher for chaining.
हऎड़ॼएशऍऒट.prototype.close = function() {
  if (this.closed) return this;

  this.closed = true;
  ॺऌषईऽॽ.keys(this._closers).forEach(function(थसऌभढॽॲफ़ट) {
    this._closers[थसऌभढॽॲफ़ट]();
    delete this._closers[थसऌभढॽॲफ़ट];
  }, this);
  this._watched = ॺऌषईऽॽ.create(null);

  this.removeAllListeners();
  return this;
};

// Attach watch handler prototype methods
function ॱज़पॾॡभऐऍफॐईऑऒ(लॐओचपऎग) {
  ॺऌषईऽॽ.keys(लॐओचपऎग.prototype).forEach(function(टझॵषफ़ऋ) {
    हऎड़ॼएशऍऒट.prototype[टझॵषफ़ऋ] = लॐओचपऎग.prototype[टझॵषफ़ऋ];
  });
}
ॱज़पॾॡभऐऍफॐईऑऒ(ऌङजॡखओऎॵॐय़सपछ);
if (एछऩॵपमणञऎलचड़ॲरज़.canUse()) ॱज़पॾॡभऐऍफॐईऑऒ(एछऩॵपमणञऎलचड़ॲरज़);

// Export FSWatcher class
य़यमऽईॱइ.FSWatcher = हऎड़ॼएशऍऒट;

// Public function: Instantiates watcher with paths to be tracked.

// * paths     - string or array of strings, file/directory paths and/or globs
// * options   - object, chokidar options

// Returns an instance of FSWatcher for chaining.
य़यमऽईॱइ.watch = function(डकएसय़, घॲतॶॳउड) {
  return new हऎड़ॼएशऍऒट(घॲतॶॳउड).add(डकएसय़);
};
