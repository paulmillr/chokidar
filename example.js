require('./').watch('.', {
  ignored: /node_modules|\.git/,
  persistent: true
}).on('all', function(event, path) {
  console.log(event, path);
}).on('ready', function() {
  console.log('ready');
});
