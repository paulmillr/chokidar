# Chokidar
A neat wrapper around node.js fs.watch / fs.watchFile.

## Why?
Node.js `fs.watch`:

* Doesn't report filenames on mac.
* Doesn't report events at all when using editors like TextMate2 on mac.
* Sometimes report events twice.
* Has only one non-useful event: `rename`.
* Has [a lot of other issues](https://github.com/joyent/node/issues/search?utf8=✓&q=fs.watch)

Node.js `fs.watchFile`:

* Doesn't work on windows
* Almost as shitty in event tracking.

Chokidar resolves this problems.

It is used in [brunch](http://brunch.io) and had proven itself in production env.

## Getting started
Install chokidar via node.js package manager:

    npm install chokidar

Then just require the package in your code:

```javascript
var chokidar = require('chokidar');

var watcher = chokidar.watch('file or dir', {ignored: /^\./, persistent: true});

watcher
  .on('add', function(path) {console.log('File', path, 'has been added');})
  .on('change', function(path) {console.log('File', path, 'has been changed');})
  .on('unlink', function(path) {console.log('File', path, 'has been removed');})
  .on('error', function(error) {console.error('Error happened', error);})

watcher.add('new-file');
watcher.add(['new-file-2', 'new-file-3']);

// Only needed if watching is persistent.
watcher.close();
```

## API
* `chokidar.watch(paths, options)`: takes paths to be watched and options:
    * `options.ignored` (regexp or function) files to be ignored. Example:
    `chokidar.watch('file', {ignored: /^\./})`.
    * `options.persistent` (default: `false`). indicates whether the process
    should continue to run as long as files are being watched.

`chokidar.watch()` produces an instance of `FSWatcher`. Methods of `FSWatcher`:

* `.add(file / files)`: add directories / files for tracking.
Takes an array of strings (file paths) or just one path.
* `.on(event, callback)`: listen for an FS event.
Available events: `add`, `change`, `unlink`, `error`, `all`.
* `.close()`: remove all listeners from watched files.

## License
The MIT license.

Copyright (c) 2012 Paul Miller (http://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
