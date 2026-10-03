# Chokidar [![Weekly downloads](https://img.shields.io/npm/dw/chokidar.svg)](https://github.com/paulmillr/chokidar)

Minimal and efficient cross-platform file watching library

## Why?

Raw `fs.watch` / `fs.watchFile` are useless: `fs.watch` reports many changes as an
non-transparent `rename`, can fire twice for one change, and recursive watching differs across
platforms. Chokidar normalizes all of that:

- Proper `add` / `change` / `unlink` (and `addDir` / `unlinkDir`) events, verified, deduplicated, with
  paths on every platform.
- Native `fs.watch` by default, which keeps CPU usage down; stat-based polling is available for
  network and other unusual filesystems.
- Recursive watching everywhere, with an optional depth limit, path filtering, and symlink support.
- Editor "atomic writes" (`atomic`) and chunked writes of large files (`awaitWriteFinish`) are
  handled.

Chokidar watches everything under the paths you give it, so scope them (and use `ignored` /
`depth`) rather than watching more than you need.

Made for [Brunch](https://brunch.io/) in 2012, it is now used in
[30+ million projects](https://www.npmjs.com/browse/depended/chokidar) and has proven itself
in production environments. The current major is [v6 (Aug 2026)](#changelog).

## Getting started

```sh
npm install chokidar
```

```js
import chokidar from 'chokidar';
// or: import { watch } from 'chokidar';
// or: const chokidar = require('chokidar');

chokidar.watch('src').on('all', (event, path) => console.log(event, path));
```

A fuller example:

```js
import chokidar from 'chokidar';

const watcher = chokidar.watch('src', {
  // strings are exact paths (not globs), regexes test the whole path, functions get (path, stats?)
  ignored: [
    /(^|\/)\../, // dotfiles
    (path, stats) => stats?.isFile() && !path.endsWith('.js'), // only .js files
  ],
  ignoreInitial: true, // don't emit add/addDir for files that already exist
});

watcher
  .on('add', (path, stats) => console.log('added', path, stats?.size))
  .on('change', (path) => console.log('changed', path))
  .on('unlink', (path) => console.log('removed', path))
  .on('ready', () => console.log('initial scan done'))
  .on('error', (err) => console.error(err));

watcher.add(['lib', 'index.js']); // add more paths later
watcher.unwatch('lib'); // synchronous
console.log(watcher.getWatched()); // { '/abs': ['src'], '/abs/src': ['a.js', 'sub'], ... }
await watcher.close(); // async and terminal: create a new watcher to resume
```

Recipes:

```js
// Large or chunked writes, and editors that save via temp file + rename
chokidar.watch('uploads', {
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }, // wait for size to settle
  atomic: 100, // unlink + add within 100 ms becomes one change
});

// Network or otherwise unusual filesystems where fs.watch is unreliable
chokidar.watch('/mnt/nfs/data', { backend: 'polling', pollingInterval: 500 });
```

## API

`chokidar.watch(paths, [options])` returns an [`FSWatcher`](#methods). `paths` is a string or an
array of strings; files are watched, directories are watched recursively. All options with their
defaults:

```js
chokidar.watch('dir-or-file', {
  // Filtering
  ignored: undefined, // matcher or array of matchers, see below
  ignoreInitial: false,
  followSymlinks: true,
  cwd: undefined,
  depth: undefined, // unlimited
  // Backend
  backend: 'auto', // 'auto' | 'native' | 'native-recursive' | 'polling'
  pollingInterval: 100, // polling backend only
  pollingBinaryInterval: 300, // polling backend only
  // Event timing
  atomic: true, // false with backend: 'polling'; or a number of ms
  awaitWriteFinish: false, // or true, or { stabilityThreshold: 2000, pollInterval: 100 }
  alwaysStat: false,
  // Errors and lifecycle
  ignorePermissionErrors: false,
  persistent: true,
});
```

#### Filtering

- `ignored` (default: none). One matcher or an array of matchers. The whole path is tested (as
  passed to `watch()`, joined with `cwd` if set), not just the basename. Ignoring a directory
  ignores everything inside it. A matcher is one of:
  - a **string**: an exact path. Relative strings are resolved against `cwd` (or the process
    cwd). Globs are not supported; see [upgrading](#upgrading) for the replacement pattern.
  - a **RegExp**: tested against the whole path with forward slashes, on Windows too, e.g.
    `/(^|\/)\../` for dotfiles or `/\/node_modules\//`.
  - a **function** `(path, stats?) => boolean`: may be called twice per path, first with the path
    only, then with the path and its [`fs.Stats`](https://nodejs.org/api/fs.html#class-fsstats), so
    guard stat-based checks with `stats?.isFile()`.
  - an **object** `{ path, recursive?: boolean }`: an exact path, plus its subtree when
    `recursive` is true.
- `ignoreInitial` (default: `false`). When `true`, `add` / `addDir` are not emitted for paths
  discovered during the initial scan (before `ready`).
- `followSymlinks` (default: `true`). When `false`, symlinks are watched as themselves rather
  than followed; retargeting a link emits `change`.
- `cwd` (no default). Base directory that `paths` are resolved against; emitted paths are
  relative to it.
- `depth` (default: `undefined`, unlimited). Maximum number of subdirectory levels to traverse.
  `Infinity` means unlimited.

#### Backend

- `backend` (default: `auto`). Selects the filesystem observation backend:
  - `auto` uses native recursive watching on macOS and Windows and native per-directory
    watching elsewhere.
  - `native` uses one `fs.watch` subscription per directory.
  - `native-recursive` prefers `fs.watch({ recursive: true })` and falls back to per-directory
    watching where recursive watching is unavailable. A finite `depth` also uses per-directory
    watching so nothing beyond the requested tree is subscribed.
  - `polling` uses Chokidar's stat-based polling scheduler. Useful for network and other
    non-standard filesystems; uses more CPU.
- `pollingInterval` (default: `100`) and `pollingBinaryInterval` (default: `300`, for recognized
  binary file extensions): polling periods in milliseconds, polling backend only. Polling compares
  size, modification time, existence, and (except on Windows) inode between polls; an in-place
  write that changes none of these is not detected.
- Environment overrides: `CHOKIDAR_USEPOLLING` forces polling when truthy and disables it when
  falsy, even if `backend: 'polling'` is set in code; `CHOKIDAR_INTERVAL` overrides
  `pollingInterval`.
- Deprecated aliases kept for compatibility: `usePolling: true` means `backend: 'polling'`;
  `interval` / `binaryInterval` mean `pollingInterval` / `pollingBinaryInterval` (the new
  spellings win when both are given).

#### Event timing

- `atomic` (default: `true` with native backends, `false` with polling; or a number of
  milliseconds). Editors that save through a temp file and rename produce `unlink` then `add`;
  within the window (100 ms by default) Chokidar emits a single `change` instead. It also ignores
  common editor temp files (`.swp` / `.swx`, `~` backups, Sublime `.subl*.tmp`).
- `awaitWriteFinish` (default: `false`). By default `add` / `change` fire as soon as a file
  appears or changes, which for large or chunked writes can be before the write is finished.
  Set to `true` (or `{ stabilityThreshold: 2000, pollInterval: 100 }`) to hold `add` / `change`
  until the file size has stayed constant for `stabilityThreshold` ms, checked every
  `pollInterval` ms. The right threshold depends on the OS and hardware: higher is safer and less
  responsive. Events from the initial scan are not held.
- `alwaysStat` (default: `false`). Always pass an
  [`fs.Stats`](https://nodejs.org/api/fs.html#class-fsstats) object with `add` / `addDir` /
  `change`, issuing an extra `stat` when the backend did not provide one.

#### Errors and lifecycle

- `ignorePermissionErrors` (default: `false`). When `true`, `EPERM` / `EACCES` errors from
  unreadable paths are suppressed instead of emitted.
- `persistent` (default: `true`). Whether the watcher keeps the process alive while it is
  watching.

### Methods

- `.add(paths)`: start watching more files or directories (string or array).
- `.unwatch(paths)`: stop watching files or directories (string or array). Synchronous; the paths
  stay ignored until they are `.add()`ed again.
- `.close()`: **async and terminal.** Removes all listeners and stops all owned work. Repeated
  calls return the same Promise; once closing has started, `.add()` throws and a new `FSWatcher`
  is required.
- `.getWatched()`: an object whose keys are the watched directories (absolute unless `cwd` is
  set) and whose values are arrays of the entry names inside each.
- `.on(event, listener)`: `FSWatcher` is an `EventEmitter`; see events below.

### Events

| Event                     | Listener arguments                                                 |
| ------------------------- | ------------------------------------------------------------------ |
| `add`, `addDir`, `change` | `(path, stats?)`; `stats` when available, always with `alwaysStat` |
| `unlink`, `unlinkDir`     | `(path)`                                                           |
| `all`                     | `(event, path, stats?)` for each of the five events above          |
| `ready`                   | none; the initial scan is complete                                 |
| `error`                   | `(error)`                                                          |
| `raw`                     | `(event, path, details)` from the backend; unstable, use with care |

## Troubleshooting

- **`ENOSPC: System limit for number of file watchers reached`** (Linux): the inotify watch limit
  is exhausted. Raise it with
  `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`, or
  watch less: narrow `paths`, add `ignored` (for example `node_modules`), set `depth`.
- **`EMFILE: too many open files`**: the process file-descriptor limit is exhausted. Watch less as
  above, raise the limit (`ulimit -n 65536`), or use `backend: 'polling'`, which holds no watch
  handles at the cost of CPU.
- `fsevents`-related install errors (`WARN optional dep failed`, `fsevents is not a constructor`)
  are solved by upgrading to v4+.

## Changelog

- **v6 (Aug 2026):** complete rewrite; new fs.watch(recursive) backend on macos + windows; requires Node.js 22+
- **v5 (Nov 2025):** ESM-only; requires Node.js 20+
- **v4 (Sep 2024):** remove glob support & fsevents dependency, decrease dep count from 13
  to 1; requires Node.js 14+
- **v3 (Apr 2019):** massive CPU & RAM consumption improvements; 17x decrease in pkg size + deps; requires Node.js 8.16+
- **v2 (Dec 2017):** posix-style globs; bugfixes
- **v1 (Apr 2015):** glob support, symlink support, tons of bugfixes; requires Node.js 0.8+
- **v0.1 (Apr 2012):** extracted from
  [Brunch](https://github.com/brunch/brunch/blob/9847a065aea300da99bd0753f90354cde9de1261/src/helpers.coffee#L66)

### Upgrading

Version 6 requires Node.js 22.22 or newer. An `FSWatcher` cannot be reopened after `.close()`
starts; construct a new watcher instead. Polling now defaults `atomic` to `false`, while an
explicit `atomic` value is preserved. Use `pollingInterval` and `pollingBinaryInterval` for
polling configuration; the v5 `interval` and `binaryInterval` spellings remain as deprecated
aliases.

Globs were removed in v4. To replicate them:

```js
// v3
chokidar.watch('**/*.js');
chokidar.watch('./directory/**/*');

// v4+: filter instead
chokidar.watch('.', {
  ignored: (path, stats) => stats?.isFile() && !path.endsWith('.js'), // only watch js files
});
chokidar.watch('./directory');

// or expand the glob yourself
import { glob } from 'node:fs/promises';
const watcher = chokidar.watch(await Array.fromAsync(glob('**/*.js')));

// unwatching
watcher.unwatch('**/*.js'); // v3
watcher.unwatch(await Array.fromAsync(glob('**/*.js'))); // v4+
```

## Contributing

Run `npm ci && npm run build && npm test` (tests import the built files, so build first).
Internals and design requirements are documented in [docs/architecture.md](docs/architecture.md);
the cross-platform CI setup is in [docs/vm-testing.md](docs/vm-testing.md).

## Also

Why was chokidar named this way? What's the meaning behind it?

> Chowkidar is a transliteration of a Hindi word meaning 'watchman, gatekeeper', चौकीदार. This ultimately comes from Sanskrit _ चतुष्क_ (crossway, quadrangle, consisting-of-four). This word is also used in other languages like Urdu as (چوکیدار) which is widely used in Pakistan and India.

## License

MIT (c) Paul Miller (<https://paulmillr.com>), see [LICENSE](LICENSE) file.
