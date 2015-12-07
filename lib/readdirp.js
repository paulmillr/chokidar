var fs = require('graceful-fs');
var sysPath = require('path');
var EventEmitter = require('events').EventEmitter;
var walk = require('walk-filtered');

module.exports = function(options) {
  var emitter = new EventEmitter();

  var root = options.root;
  var realRoot;
  var depth = (typeof options.depth === 'undefined') || isNaN(options.depth) ? Infinity : options.depth;

  function toData(path, stat) {
    var parts = path ? path.split(sysPath.sep) : [];

    var data = {path: path, stat: stat};
    data.fullPath = sysPath.join(realRoot, path);
    data.fullParentDir = parts.length ? sysPath.dirname(data.fullPath) : realRoot;
    data.depth = parts.length;
    data.name = parts.length ? parts.pop() : '';
    return data;
  }

  function filter(path, stat) {
    var data = toData(path, stat);
    if (data.depth > depth + 1) return false;
    var keep = options[stat.isDirectory() ? 'directoryFilter' : 'fileFilter'](data, stat);
    if (keep && path) emitter.emit('data', data);
    return keep;
  }

  // lookup the real root before starting
  fs.realpath(root, function(err, _realRoot) {
    if (err) return emitter.emit('error', err);
    realRoot = _realRoot;

    walk(realRoot, {preStat: true, stat: 'lstat', filter: filter}, function(err) { emitter.emit('end', err); })
  });

  return emitter;
}
