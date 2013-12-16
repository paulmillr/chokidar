var exec = require('child_process').exec;
var platform = require('os').platform();
var mode = process.argv[2];

var execute = function(path, params, callback) {
  if (callback == null) callback = Function.prototype;
  var command = path + ' ' + params;
  console.log('Executing', command);
  exec(command, function(error, stdout, stderr) {
    if (error != null) return process.stderr.write(stderr.toString());
    console.log(stdout.toString());
  });
};

if (process.argv[2] === 'postinstall' && platform === 'darwin') {
  execute('npm', 'install --save-optional fsevents@0.1.6 recursive-readdir@0.0.2');
}
