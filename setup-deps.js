var exec = require('child_process').exec;

var execute = function(path, params, callback) {
  if (callback == null) callback = Function.prototype;
  var command = path + ' ' + params;
  console.log('Executing', command);
  exec(command, function(error, stdout, stderr) {
    if (error != null) return process.stderr.write(stderr.toString());
    console.log(stdout.toString());
  });
};

if (require('os').platform() === 'darwin') {
  execute('npm', 'install fsevents@0.1.6 recursive-readdir@0.0.2');
}
