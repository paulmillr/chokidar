

var
  EventEmitter = require('events').EventEmitter,
  H = require('./H'),
  FsEventsHandler = require('./../lib-old/fsevents-handler'),
  Path = require('path'),
  AnyMatch = require('anymatch'),
  GlobParent = require('glob-parent');
class FSWatcher extends EventEmitter {
  // Setup the default instance stuff
  closed:Boolean = false;
  _watched:Object = Object.create(null);
  _closers:Object = Object.create(null);
  _ignoredPaths:Object = Object.create(null);
  _throttled:Object = Object.create(null);
  _symlinkPaths:Object = Object.create(null);
  _pendingUnlinks:Object = Object.create(null);
  _readyCalls:Number = 0;
  _readyCount:Number = 0;
  // These options are gonna be set in constructor
  enableBinaryInterval:Boolean;
  options:Object;

  constructor(GivenOpts){
    var
      Opts = {},
      OptKey = null,
      OptMissing = H.OptMissing.bind(this);

    // Copy the given opts
    if(GivenOpts){for(OptKey in GivenOpts){if(GivenOpts.hasOwnProperty(OptKey)){Opts[OptKey] = GivenOpts[OptKey];}}}
    this.options = Opts;
    this._isntIgnored = H.IsntIgnored.bind(this);
    this._emitReady = H.EmitReady.bind(this);

    Object.defineProperty(this, '_globIgnored', {
      get: function() { return Object.keys(this._ignoredPaths); }
    });

    // Default Options
    if(OptMissing('persistent')) Opts.persistent = true;
    if(OptMissing('ignoreInitial')) Opts.ignoreInitial = false;
    if(OptMissing('ignorePermissionErrors')) Opts.ignorePermissionErrors = false;
    if(OptMissing('interval')) Opts.interval = 100;
    if(OptMissing('binaryInterval')) Opts.binaryInterval = 300;
    this.enableBinaryInterval = Opts.binaryInterval !== Opts.interval;

    // Enable fsevents on OS X when polling isn't explicitly enabled.
    if(OptMissing('useFsEvents')) Opts.useFsEvents = !Opts.usePolling;

    // If we can't use fsevents, ensure the options reflect it's disabled.
    if(!FsEventsHandler.canUse()) Opts.useFsEvents = false;

    // Use polling on Mac if not using fsevents.
    // Other platforms use non-polling fs.watch.
    if(OptMissing('usePolling') && !Opts.useFsEvents) Opts.usePolling = process.platform === 'darwin';

    // Editor atomic write normalization enabled by default with fs.watch
    if(OptMissing('atomic')) Opts.atomic = !Opts.usePolling && !Opts.useFsEvents;

    if(OptMissing('followSymlinks')) Opts.followSymlinks = true;

    Object.freeze(Opts);
  }

  _emit(Event, EventPath) {
    if (this.options.cwd) EventPath = Path.relative(this.options.cwd, EventPath);
    var LeArgs = Array.prototype.slice.call(arguments,0,5);
    if(this.options.atomic){
      if(Event === 'unlink'){
        this._pendingUnlinks[EventPath] = LeArgs;
        setTimeout(function() {
          Object.keys(this._pendingUnlinks).forEach(function(EventPath) {
            this.emit.apply(this, this._pendingUnlinks[EventPath]);
            this.emit.apply(this, ['all'].concat(this._pendingUnlinks[EventPath]));
            delete this._pendingUnlinks[EventPath];
          }.bind(this));
        }.bind(this), 100);
      }
    } else {
      if (Event === 'add' && this._pendingUnlinks[EventPath]) {
        Event = LeArgs[0] = 'change';
        delete this._pendingUnlinks[EventPath];
      } else if (Event === 'change') {
        if (!this._throttle('change', EventPath, 50)) return this;
      }
      if (
        this.options.alwaysStat && LeArgs[2] === undefined &&
        (Event === 'add' || Event === 'addDir' || Event === 'change')
      ) {
        fs.stat(EventPath, function(error, stats) {
          LeArgs.push(stats);
          H.EmitEvent.call(this,LeArgs,Event);
        });
      } else {
        H.EmitEvent.call(this,LeArgs,Event);
      }
    }
    return this;
  }
  _handleError(error){
    var code = error && error.code;
    if (error &&
      code !== 'ENOENT' &&
      code !== 'ENOTDIR' &&
      !(code === 'EPERM' && !this.options.ignorePermissionErrors)
    ) this.emit('error', error);
    return error || this.closed;
  }
  _throttle(Action, ThePath, Timeout):Object{
    if (!(Action in this._throttled)) {
      this._throttled[Action] = Object.create(null);
    }
    if (ThePath in this._throttled[Action]) return false;
    var
      Throttled = this._throttled[Action],
      ClearThrottle = H.ClearThrottle.bind(null, Throttled, TimeoutObject, ThePath),
      TimeoutObject = setTimeout(ClearThrottle, Timeout);
    Throttled[ThePath] = {timeoutObject: TimeoutObject, clear: ClearThrottle};
    return Throttled[ThePath];
  }
  _isIgnored(ThePath, Stats):Object{
    if (
      this.options.atomic &&
      /\..*\.(sw[px])$|\~$|\.subl.*\.tmp/.test(ThePath)
    ) return true;
    var userIgnored = AnyMatch(this._globIgnored.concat(this.options.ignored));
    return userIgnored([ThePath, Stats]);
  }
  _getWatchHelpers(ThePath, Depth):Object{
    ThePath = ThePath.replace(/^\.[\/\\]/, '');
    var
      WatchPath = Depth ? ThePath : GlobParent(ThePath),
      HasGlob = WatchPath !== ThePath,
      GlobFilter = HasGlob ? AnyMatch(ThePath) : false,
      EntryPath = H.EntryPath.bind(null, WatchPath),
      FilterPath = H.FilterPath.bind(this,HasGlob, GlobFilter, EntryPath),
      GetDirParts = H.GetDirParts.bind(null, HasGlob, WatchPath),

      DirParts = GetDirParts(ThePath);
    if (DirParts && DirParts.length > 1) DirParts.pop();
    var
      FilterDir = H.FilterDir.bind(this, HasGlob, EntryPath, GetDirParts, DirParts);
    return {
      followSymlinks: this.options.followSymlinks,
      statMethod: this.options.followSymlinks ? 'stat' : 'lstat',
      path: ThePath,
      watchPath: WatchPath,
      entryPath: EntryPath,
      hasGlob: HasGlob,
      globFilter: GlobFilter,
      filterPath: FilterPath,
      filterDir: FilterDir
    };
  }
  _getWatchedDir(Directory:String):Object{
    var dir = Path.resolve(Directory);
    if (!(dir in this._watched)) {
      this._watched[dir] = {
        _items: Object.create(null),
        add: function (item) {
          this._items[item] = true;
        },
        remove: function (item) {
          delete this._items[item];
        },
        has: function (item) {
          return item in this._items;
        },
        children: function () {
          return Object.keys(this._items);
        }
      };
    }
    return this._watched[dir];
  }
  _hasReadPermissions(Stats:Object):Boolean{
    return Boolean(4 & parseInt((Stats.mode & 0x1ff).toString(8)[0], 10));
  }
}