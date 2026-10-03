import chokidar from './index.js';

const watcher = chokidar.watch('.', {
  ignored: /node_modules|\.git/,
  persistent: true,
  // followSymlinks: false,
  // backend: 'polling',
});

watcher
  .on('all', (event, path) => {
    console.log(event, path);
  })
  .on('ready', () => {
    console.log('Ready');
  });

// Uncomment for lower-level event details.
// watcher.on('raw', console.log.bind(console, 'Raw event:'));
