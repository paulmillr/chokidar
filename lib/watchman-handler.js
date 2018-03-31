'use strict';

var fs = require('fs');
var sysPath = require('path');
var anymatch = require('anymatch');
var watchman = require('fb-watchman');
var isGlob = require('is-glob');
var client = new watchman.Client();

// fake constructor for attaching watchman-specific prototype methods that
// will be copied to FSWatcher's prototype
function WatchmanHandler() {
}

var watcherId = 0;

WatchmanHandler.prototype._addToWatchman = function(path) {
  var wh = this._getWatchHelpers(path);
  client.capabilityCheck({required: ['relative_root']}, function(error, resp) {
    if (this._handleError(error)) {
      return this._emitReady();
    }

    function findExistingParent(path, cb) {
      var next = sysPath.dirname(path);
      fs.lstat(path, function(error, stats) {
        if (error) {
          if (error.code === 'ENOENT') {
            if (next === path) {
              cb(new Error('Could not find any existing parent directory'));
            } else {
              findExistingParent(next, cb);
            }
          } else {
            cb(error);
          }
        } else if (stats.isDirectory()) {
          cb(null, path, stats);
        } else {
          if (next === path) {
            cb(new Error('Could not find any parent directory'));
          } else {
            findExistingParent(next, cb);
          }
        }
      });
    }

    var resolved = sysPath.resolve(wh.watchPath);
    if (this._isIgnored(wh.watchPath)) return this._emitReady();
    findExistingParent(resolved, function(error, root, stats) {
      if (this._handleError(error)) {
        return this._emitReady();
      }

      var relative = sysPath.relative(root, resolved);

      client.command(['watch', root], function(error, resp) {
        if (this._handleError(error)) {
          return this._emitReady();
        }
        var opts = {
          fields: ['name', 'exists', 'new', 'type'],
        };
        var match;
        var glob = path.replace(root, '');
        if (glob[0] === '/') glob = glob.slice(1);
        if (!this.options.disableGlobbing && isGlob(glob)) {
          match = anymatch(glob);
        } else {
          opts.expression = [
            'anyof',
            ['dirname', glob],
            ['name', glob, 'wholename'],
          ];
        }
        if (this.options.ignoreInitial) {
          opts.empty_on_fresh_instance = true;
        }

        var subscription = 'chokidar-' + (watcherId++);
        client.command(['subscribe', root, subscription, opts],
            function(error, resp) {
              if (this._handleError(error)) {
                return this._emitReady();
              }
              // watchman returns the first results immediately after the
              // subscription response. This is racy, but at least it works for
              // the tests that requires us to emit the add events before ready.
              process.nextTick(function() {
                this._emitReady();
              }.bind(this));
            }.bind(this));
        var listener = function(resp) {
          if (resp.subscription !== subscription) return;
          resp.files.forEach(function(entry) {
            if (!match || match(entry.name)) {
              this.emit('raw', resp);
              var eventName = entry.exists ?
                  (entry.new ? 'add' : 'change') :
                  'unlink';
              if (eventName !== 'change' && entry.type ===
                  'd') eventName += 'Dir';
              var absPath = sysPath.join(root, entry.name);
              if (!this._isIgnored(absPath)) {
                this._emit(eventName, absPath);
              }
            }
          }.bind(this));
        }.bind(this);
        client.on('subscription', listener);

        this._closers[root] = function() {
          client.removeListener('subscription', listener);
          client.command(['unsubscribe', root, subscription]);
        };
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

module.exports = WatchmanHandler;