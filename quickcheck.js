'use strict';

// This is a script for property based testing of chokidar, using jsverify.
// The principle is not complicated. At each iteration, it does the following:
// - it starts a chokidar watcher and records the events for each path
// - it generates a sequence of actions (e.g. an action can be creating a file)
// - it applies these actions
// - it waits a bit
// - it checks the events for all paths
//   (e.g. a 'change' can only happen after an 'add')
//
// See https://jsverify.github.io/
//
// TODO use jsverify to generate new sets of options for chokidar.watch
// TODO check that the filesystem is coherent with the final state for each path

var Promise  = require('es6-promise').Promise;
var chokidar = require('./');
var jsc      = require('jsverify');
var fs       = require('fs');
var rimraf   = require('rimraf');

var paths = jsc.sampler(jsc.nestring)(5);
paths = paths.concat(paths.map(function(p) {
  return paths[0] + '/' + p;
}));

jsc.action = jsc.record({
  what: jsc.elements(['touch', 'mkdir', 'rm', 'mv']),
  path: jsc.elements(paths),
  dst:  jsc.elements(paths),
});

function delay(timeout, f) {
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      resolve(f());
    }, timeout);
  });
}

function event(events, type, path) {
  events[path] = events[path] || [];
  events[path].push(type);
}

function apply(cwd, actions) {
  if (actions.length === 0) { return; }
  var action = actions.shift();
  var path = cwd + '/' + action.path
  try {
    switch(action.what) {
      case 'touch':
        fs.writeFileSync(path, new Date(), 'utf-8');
        break;
      case 'mkdir':
        fs.mkdirSync(path);
        break;
      case 'rm':
        rimraf.sync(path);
        break;
      case 'mv':
        var dst = cwd + '/' + action.dst;
        fs.renameSync(path, dst);
        break;
    }
  } catch (err) {}
  setTimeout(apply.bind(this, cwd, actions), 10);
}

function checkOrder(events) {
  for (var path in events) {
    var state = null;
    var sequence = events[path];
    for (var i = 0; i < sequence.lenght; i++) {
      switch(sequence[i]) {
        case 'add':
          if (state) return false;
          state = 'file';
          break;
        case 'change':
          if (state != 'file') return false;
          break;
        case 'remove':
          if (state != 'file') return false;
          state = null;
          break;
        case 'mkdir':
          if (state) return false;
          state = 'dir';
          break;
        case 'rmdir':
          if (state != 'dir') return false;
          state = null;
          break;
      }
    }
  }
  return true;
}

describe('awaitWriteFinish', function() {
  this.timeout(60 * 1000);

  it('respects the order for events', function(done) {
    var sequenceOfActions = jsc.nearray(jsc.action);
    var promise = jsc.check(jsc.forall(sequenceOfActions, function (actions) {
      var cwd = '/tmp/' + +(new Date());
      fs.mkdirSync(cwd);
      var watcher = chokidar.watch('.', {
        atomic: true,
        alwaysStat: true,
        cwd: cwd,
        awaitWriteFinish: {
          pollInterval: 30,
          stabilityThreshold: 100
        }
      });

      var events = Object.create(null);
      watcher.on('add',       event.bind(this, events, 'add'));
      watcher.on('change',    event.bind(this, events, 'change'));
      watcher.on('unlink',    event.bind(this, events, 'remove'));
      watcher.on('addDir',    event.bind(this, events, 'mkdir'));
      watcher.on('unlinkDir', event.bind(this, events, 'rmdir'));

      apply(cwd, actions);
      return delay(150, function() {
        watcher.close();
        rimraf.sync(cwd);
        return checkOrder(events);
      });
    }));

    promise.then(function (r) {
      r ? done() : done(r);
    });
  });
});
