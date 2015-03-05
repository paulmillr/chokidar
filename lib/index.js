

var
  EventEmitter = require('events').EventEmitter,
  H = require('./H'),
  FsEventsHandler = require('./../lib-old/fsevents-handler'),
  Path = require('path');
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
}