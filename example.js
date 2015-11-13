require('./').watch('.', {
  ignored: /node_modules|\.git/,
  persistent: true,
  // followSymlinks: false,
  // useFsEvents: false,
  // usePolling: false
}).on('all', function(event, path) {
  console.log(event, path);
}).on('ready', function() {
  console.log('Ready');
})
//.on('raw', console.log.bind(console, 'RawEvent:'))
