'use strict';

global.watcher = require('.').watch('.', {
  ignored: /node_modules|\.git/,
  persistent: true,
  // followSymlinks: false,
  // useFsEvents: false,
  // usePolling: false,
})
.on('all', (event, path) => { console.log(event, path); })
.on('ready', () => { console.log('Ready'); })
//.on('raw', console.log.bind(console, 'Raw event:'))
