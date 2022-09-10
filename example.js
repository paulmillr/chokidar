'use strict';

const { WatchDirectoryFlags } = require('typescript');
const chokidar = require('.');


// chokidar 
// chokidar.watch('.', {
//   ignored: /node_modules|\.git/,
//   persistent: true,
//   followSymlinks: false,
//   useFsEvents: false,
//   usePolling: false,
// })
// .on('all', (event, path) => { console.log(event, path); })
// .on('ready', () => { console.log('Ready'); })



// TODO:
// EXAMPLE 2

chokidar.watch('example.js').on('all', () => console.log("hello world"));

// Promise.all([1,2,3].map(async n => {
//   const res = await Promise.resolve(n % 2 === 0);
//   console.log(res);

//   return res;
// })).then(results => {
//   console.log(results);
// });