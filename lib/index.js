

var
  EventEmitter = require('events').EventEmitter,
  H = require('./H'),
  FsEventsHandler = require('./../lib-old/fsevents-handler');
class FSWatcher extends EventEmitter{
  // Setup the default instance stuff
  closed:Boolean = false;
  _watched:Object = Object.create(null);
  _closers:Object = Object.create(null);
  _ignoredPaths:Object = Object.create(null);
  _throttled:Object = Object.create(null);
  _symlinkPaths:Object = Object.create(null);
  _pendingUnlinks:Object = Object.create(null);
  _readyCalls:Number = 0;
  // These options are gonna be set in constructor
  enableBinaryInterval:Boolean;
  options:Object;
  _readyCount:Number;

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
}