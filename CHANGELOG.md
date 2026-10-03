# Changelog for chokidar

## 6.0.0 (unreleased)

### High-level changes

- Rewrote the watcher around a single observation pipeline. Backend callbacks are treated as invalidations and confirmed with `lstat`, `stat`, or `readdir` before any event is emitted, so the final state after a burst of changes matches the filesystem.
- Added native recursive watching through `fs.watch({ recursive: true })`. The default `auto` backend uses it on macOS and Windows and per-directory watching elsewhere.
- Shared native handles across watchers and opened them per directory only: files no longer own handles. This fixes `EBADF` errors when watching many files on macOS ([#1385](https://github.com/paulmillr/chokidar/issues/1385), [#1452](https://github.com/paulmillr/chokidar/issues/1452)).
- Replaced `fs.watchFile` with Chokidar-owned stat polling. Poll loops are shared across watchers at the fastest requested interval.
- Required Node.js 22.22 or later.

### API changes

- Added the `backend` option: `'auto'` (default), `'native'`, `'native-recursive'`, or `'polling'`.
  - `usePolling: true` remains as a deprecated alias for `backend: 'polling'`.
- Renamed `interval` and `binaryInterval` to `pollingInterval` and `pollingBinaryInterval`.
  - The old names remain as deprecated aliases; the new names win when both are given.
- Changed the `atomic` default to `false` with polling. An explicit value is preserved.
- Made `close()` terminal: `add()` now throws once closing has started. Construct a new watcher instead.
- Validated options in the constructor: invalid `backend`, `atomic`, `depth`, `awaitWriteFinish`, and polling intervals throw `TypeError`.
- Emitted errors from `add()` as `error` events instead of unhandled rejections ([#1378](https://github.com/paulmillr/chokidar/issues/1378)).
- Stopped applying `ignored` to directories above a path passed to `watch()` or `add()`, so a missing path is still watched through its parent ([#1374](https://github.com/paulmillr/chokidar/issues/1374)). Other entries in those directories are still filtered.

### Fixes

- Fixed a 100% CPU loop when the process working directory containing a relatively watched file was deleted ([#1474](https://github.com/paulmillr/chokidar/issues/1474)).
- Fixed watching a filesystem root, which emitted `unlink` and `unlinkDir` for every entry ([#1184](https://github.com/paulmillr/chokidar/issues/1184), [#452](https://github.com/paulmillr/chokidar/issues/452)).
- Fixed `UNKNOWN` errors from `fs.watch` on macOS sockets, which prevented watching `/var/run` ([#1391](https://github.com/paulmillr/chokidar/issues/1391)).
- Fixed a symlink whose target passes through a regular file (`ENOTDIR`) disabling watching of its directory and preventing `ready` ([#1476](https://github.com/paulmillr/chokidar/issues/1476)).
- Fixed files created in a newly added directory between its scan and watch registration being missed ([#1471](https://github.com/paulmillr/chokidar/issues/1471)).
- Fixed watching a missing nested path stopping its parent directory's subtree from being watched ([#1470](https://github.com/paulmillr/chokidar/issues/1470)).
- Fixed false `change` events on Windows when many sibling files are written ([#1466](https://github.com/paulmillr/chokidar/issues/1466)).
- Fixed duplicate `add` events for unchanged files under directory activity ([#1465](https://github.com/paulmillr/chokidar/issues/1465)).
- Fixed replacing a watched directory with a file of the same name hanging the process ([#1464](https://github.com/paulmillr/chokidar/issues/1464)).
- Fixed persistent watching stopping after a watched directory was removed ([#1463](https://github.com/paulmillr/chokidar/issues/1463)).
- Fixed event throttling discarding updates; the newest differing change is now replayed when the window closes ([#1455](https://github.com/paulmillr/chokidar/issues/1455)).
- Fixed relative `ignored` paths; relative strings now resolve against `cwd` or the process working directory ([#1436](https://github.com/paulmillr/chokidar/issues/1436)).
- Fixed files not being detected when their directory did not exist before watching ([#1422](https://github.com/paulmillr/chokidar/issues/1422)).
- Fixed removed files being reported as `unlinkDir` instead of `unlink` ([#1421](https://github.com/paulmillr/chokidar/issues/1421)).
- Fixed ignored files and directories still being watched in WSL ([#1418](https://github.com/paulmillr/chokidar/issues/1418)).
- Fixed `change` being reported for every file when one file changed under Deno ([#1417](https://github.com/paulmillr/chokidar/issues/1417)).
- Fixed changes not being detected after the second save ([#1399](https://github.com/paulmillr/chokidar/issues/1399)).
- Fixed renaming a watched directory that contains subdirectories on Windows ([#1380](https://github.com/paulmillr/chokidar/issues/1380), [#1398](https://github.com/paulmillr/chokidar/issues/1398)).
- Fixed re-watching a path not honoring `ignoreInitial` ([#1386](https://github.com/paulmillr/chokidar/issues/1386)).
- Fixed `EISDIR` errors during the initial scan of network drives ([#1376](https://github.com/paulmillr/chokidar/issues/1376)).
- Fixed watching an array of absolute file paths ([#1366](https://github.com/paulmillr/chokidar/issues/1366)).
- Fixed unwatching a deleted watched directory on Windows, contributed by [@sapphi-red](https://github.com/sapphi-red) in [pull request #1467](https://github.com/paulmillr/chokidar/pull/1467).
- Documented that unwatched paths stay ignored until they are added again ([#1439](https://github.com/paulmillr/chokidar/issues/1439)).

### Misc

- Made the `Stats` import type-only, contributed by [@zhennann](https://github.com/zhennann) in [pull request #1447](https://github.com/paulmillr/chokidar/pull/1447).
- Pinned dev dependencies and restricted workflow permissions, contributed by [@43081j](https://github.com/43081j) in [pull requests #1457](https://github.com/paulmillr/chokidar/pull/1457), [#1460](https://github.com/paulmillr/chokidar/pull/1460), and [#1461](https://github.com/paulmillr/chokidar/pull/1461).

## 5.0.0 (2025-11-25)

- Made the package ESM-only, reducing on-disk size from ~150 KB to ~80 KB.
- Required Node.js 20.19 or later, which can load ESM from CommonJS.
- Updated readdirp to the ESM-only v5.
- Made matcher types more precise, contributed by [@43081j](https://github.com/43081j) in [pull request #1424](https://github.com/paulmillr/chokidar/pull/1424).
- Reused the double-slash regex, contributed by [@43081j](https://github.com/43081j) in [pull request #1435](https://github.com/paulmillr/chokidar/pull/1435).
- Switched npm releases to token-less Trusted Publishing with [jsbt](https://github.com/paulmillr/jsbt).
- Switched compilation to `isolatedDeclarations`-based TypeScript for simpler auto-generated docs.
- Improved tests.

### New contributors

- [@mhkeller](https://github.com/mhkeller) made their first contribution in [pull request #1426](https://github.com/paulmillr/chokidar/pull/1426).
- [@btea](https://github.com/btea) made their first contribution in [pull request #1432](https://github.com/paulmillr/chokidar/pull/1432).

## 4.0.3 (2024-12-18)

- Fixed the TypeScript type of emitted `error` arguments, contributed by [@43081j](https://github.com/43081j) in [pull request #1397](https://github.com/paulmillr/chokidar/pull/1397).

## 4.0.2 (2024-12-16)

- Strongly typed event emitter methods, contributed by [@43081j](https://github.com/43081j) in [pull request #1381](https://github.com/paulmillr/chokidar/pull/1381).
- Removed references to `.map` files, contributed by [@bluwy](https://github.com/bluwy) in [pull request #1383](https://github.com/paulmillr/chokidar/pull/1383).
- Fixed the "should detect safe-edit" test on FreeBSD, contributed by [@tagattie](https://github.com/tagattie) in [pull request #1375](https://github.com/paulmillr/chokidar/pull/1375).

### New contributors

- [@bxt](https://github.com/bxt) made their first contribution in [pull request #1365](https://github.com/paulmillr/chokidar/pull/1365).
- [@tagattie](https://github.com/tagattie) made their first contribution in [pull request #1375](https://github.com/paulmillr/chokidar/pull/1375).
- [@bluwy](https://github.com/bluwy) made their first contribution in [pull request #1383](https://github.com/paulmillr/chokidar/pull/1383).

## 4.0.1 (2024-09-22)

- Allowed the second argument of `watch()` to be `undefined`, contributed by [@benmccann](https://github.com/benmccann) in [pull request #1349](https://github.com/paulmillr/chokidar/pull/1349).
- Removed JSDoc types and improved internal types, contributed by [@v1rtl](https://github.com/v1rtl) in [pull request #1356](https://github.com/paulmillr/chokidar/pull/1356).

### New contributors

- [@benmccann](https://github.com/benmccann) made their first contribution in [pull request #1349](https://github.com/paulmillr/chokidar/pull/1349).
- [@v1rtl](https://github.com/v1rtl) made their first contribution in [pull request #1356](https://github.com/paulmillr/chokidar/pull/1356).

## 4.0.0 (2024-09-13)

- Removed glob support. Use regexps or functions in `ignored`, or expand globs yourself; see the README's upgrading section.
- Removed bundled fsevents in favor of built-in functionality.
- Reduced the dependency count from 13 to 1.
- Rewrote the package in TypeScript, making emitted types more precise.
- Made the package hybrid CommonJS / ESM and side-effect-free.
- Required Node.js 14 or later, up from 8.
- Special thanks to [@43081j](https://github.com/43081j) for improvements and help.

## 3.6.0 (2024-02-06)

- Fixed the `ready` count logic, contributed by [@JLHwung](https://github.com/JLHwung) in [pull request #1288](https://github.com/paulmillr/chokidar/pull/1288).
- Handled the FSEvents `MustScanSubDirs` flag, contributed by [@MarcCelani-at](https://github.com/MarcCelani-at) in [pull request #1197](https://github.com/paulmillr/chokidar/pull/1197).
- Updated `fs.FSWatcher` types for Node.js 16 and later, contributed by [@ben-polinsky](https://github.com/ben-polinsky) in [pull request #1300](https://github.com/paulmillr/chokidar/pull/1300).

### New contributors

- [@Mutahhar](https://github.com/Mutahhar) made their first contribution in [pull request #1226](https://github.com/paulmillr/chokidar/pull/1226).
- [@zqianem](https://github.com/zqianem) made their first contribution in [pull request #1242](https://github.com/paulmillr/chokidar/pull/1242).
- [@JLHwung](https://github.com/JLHwung) made their first contribution in [pull request #1288](https://github.com/paulmillr/chokidar/pull/1288).
- [@MarcCelani-at](https://github.com/MarcCelani-at) made their first contribution in [pull request #1197](https://github.com/paulmillr/chokidar/pull/1197).
- [@ben-polinsky](https://github.com/ben-polinsky) made their first contribution in [pull request #1300](https://github.com/paulmillr/chokidar/pull/1300).

## 3.5.3 (2022-01-18)

- Used the correct type definition for the `ignored` option, contributed by [@hyfdev](https://github.com/hyfdev) in [pull request #1140](https://github.com/paulmillr/chokidar/pull/1140).
- Handled the promise rejection when a symlink's target does not exist, contributed by [@nicks](https://github.com/nicks) in [pull request #1010](https://github.com/paulmillr/chokidar/pull/1010).
- Improved `add` and `unwatch` TypeScript definitions, contributed by [@alan-agius4](https://github.com/alan-agius4) in [pull request #1157](https://github.com/paulmillr/chokidar/pull/1157).
- Enabled dtslint and deleted `yarn.lock`, contributed by [@alan-agius4](https://github.com/alan-agius4) in [pull requests #1158](https://github.com/paulmillr/chokidar/pull/1158) and [#1159](https://github.com/paulmillr/chokidar/pull/1159).
- Updated the chokidar-cli link in the README, contributed by [@mcecode](https://github.com/mcecode) in [pull request #1142](https://github.com/paulmillr/chokidar/pull/1142).

### New contributors

- [@hyfdev](https://github.com/hyfdev) made their first contribution in [pull request #1140](https://github.com/paulmillr/chokidar/pull/1140).
- [@mcecode](https://github.com/mcecode) made their first contribution in [pull request #1142](https://github.com/paulmillr/chokidar/pull/1142).
- [@nicks](https://github.com/nicks) made their first contribution in [pull request #1010](https://github.com/paulmillr/chokidar/pull/1010).
- [@alan-agius4](https://github.com/alan-agius4) made their first contribution in [pull request #1157](https://github.com/paulmillr/chokidar/pull/1157).

## 3.5.2 (2021-06-15)

- Updated glob-parent from `~5.1.0` to `~5.1.2` to silence vulnerability warnings.

## 3.5.1 (2021-01-15)

- Fixed symlink handling.

## 3.5.0 (2021-01-06)

- Added support for Apple Silicon Macs.
- Fixed symlinks not being removed when their target was deleted ([#1042](https://github.com/paulmillr/chokidar/issues/1042)).

## 3.4.3 (2020-10-13)

- Stopped watching circular symlinks that point to a parent directory, preventing infinite loops.

## 3.4.2 (2020-08-06)

- Fixed watching network drives on Windows.

## 3.4.1 (2020-07-16)

- Fixed files not being watched properly by a new watcher after a previous one was closed.

## 3.4.0 (2020-04-26)

- Added support for directory symlinks.
- Fixed invalid events on macOS when a file was replaced with a directory of the same name.
- Fixed errors being swallowed inside `.on()` event handlers.
- Known issue: `followSymlinks: false` on macOS still follows symlinked directories.

## 3.3.1 (2019-12-15)

- Updated fsevents and readdirp.

## 3.3.0 (2019-11-02)

- Made `close()` async. This ensures I/O operations finish properly and fixes a few segfaults.

## 3.2.3 (2019-10-28)

- Fixed memory leaks for directories that change frequently over a long time, present since 3.0.
- Raised the required Node.js version from 8.0 to 8.10, since dependencies use features only present in 8.10 and later.

## 3.2.2 (2019-10-16)

- Fixed a resource-starved CPU preventing `ready` by updating fsevents ([#873](https://github.com/paulmillr/chokidar/issues/873)).
- Improved low-level directory scan time by 50% by updating readdirp.

## 3.2.1 (2019-10-01)

- Lowered the required Node.js version in `package.json` from 8.16 to 8.0.

## 3.2.0 (2019-10-01)

- Improved Linux RAM usage by 50%.
- Fixed another case of "Expected pattern to be a non-empty string" ([#871](https://github.com/paulmillr/chokidar/issues/871)).
- Pinned dependency versions with `~` instead of `^` for stability.
- Fixed globs on Windows.

## 3.1.1 (2019-09-19)

- Fixed "Expected pattern to be a non-empty string" ([#871](https://github.com/paulmillr/chokidar/issues/871)).

## 3.1.0 (2019-09-16)

- **Breaking:** dotfiles are no longer filtered out by default. Use the `ignored` option if needed.
- Increased initial scan speed on Linux by 30–50% by removing unnecessary `realpath` calls ([#882](https://github.com/paulmillr/chokidar/issues/882)).
- Fixed `.add()` returning a promise and other type issues.
- Improved typings for watched paths.

## 3.0.2 (2019-07-07)

- Added `bigint` support to `stat` outputs on Windows.
- Fixed `ready` emission for symlinked directories.

## 3.0.1 (2019-06-02)

- Fixed the Node.js process crashing after `close()`.

## 3.0.0 (2019-04-30)

- **Breaking:** required Node.js 8 or later.
- Massively reduced CPU and RAM consumption.
- Reduced package and dependency size 17×.

## 2.1.8 (2019-08-21)

- Republished 2.1.7 to fix its npm dist-tag.

## 2.1.7 (2019-08-21)

- Fixed fsevents v2 interoperability: chokidar no longer starts fsevents v2 found in `node_modules`.

## 2.1.6 (2019-05-15)

- Fixed `close()` preventing the process from exiting when watching globs.

## 2.1.5 (2019-03-22)

- Reverted the atomic-writes workaround from 2.1.3.

## 2.1.4 (2019-03-22)

- Improved TypeScript type definitions for the `on` method.

## 2.1.3 (2019-03-22)

- Improved handling of atomic writes.

## 2.1.2 (2019-02-18)

- Added TypeScript type definitions.
- Fixed more access-time behavior ([#800](https://github.com/paulmillr/chokidar/issues/800)).

## 2.1.1 (2019-02-11)

- Handled simultaneous changes of access time and modification time ([#793](https://github.com/paulmillr/chokidar/issues/793)).

## 2.1.0 (2019-02-05)

- Ignored access-time updates caused by read operations ([#762](https://github.com/paulmillr/chokidar/issues/762)).
- Updated dependencies and removed `lodash.debounce`.

## 2.0.4 (2018-06-18)

- Fixed `close()` crashing ([#730](https://github.com/paulmillr/chokidar/issues/730)).

## 2.0.3 (2018-03-23)

- Fixed file descriptor 0 not being closed on Windows after an `EPERM` error.

## 2.0.2 (2018-02-14)

- Allowed semver range updates for the upath dependency.

## 2.0.1 (2018-02-08)

- Fixed globs on Windows when using `ignored` and `cwd` ([#668](https://github.com/paulmillr/chokidar/issues/668)), thanks to [@remy](https://github.com/remy).
- Fixed a possible uncaught exception with `awaitWriteFinish` ([#546](https://github.com/paulmillr/chokidar/issues/546)), thanks to [@dsagal](https://github.com/dsagal).

## 2.0.0 (2017-12-29)

- **Breaking:** upgraded globbing dependencies, which require stricter globs with POSIX-style slashes, because Windows-style slashes are escape sequences.
- Added the `CHOKIDAR_PRINT_FSEVENTS_REQUIRE_ERROR` environment variable to log FSEvents `require` errors.
- Fixed handling of braces in globs.

## 1.7.0 (2017-05-08)

- Added the `disableGlobbing` option.
- Added the `CHOKIDAR_INTERVAL` environment variable to force the polling interval.
- Fixed `close()` being called before `ready`.

## 1.6.1 (2016-10-14)

- Fixed a symlink issue.

## 1.6.0 (2016-06-22)

- Added the `CHOKIDAR_USEPOLLING` environment variable to force polling mode.

## 1.5.2 (2016-06-07)

- Fixed missing `addDir` events when using the `cwd` and `alwaysStat` options.
- Fixed missing `add` events for files within a renamed directory.

## 1.5.1 (2016-05-20)

- Consolidated watch instances on many siblings to their common parent, to avoid exhausting FSEvents system limits.

## 1.5.0 (2016-05-10)

- Made the debounce delay used with `atomic: true` customizable.
- Fixed and improved `awaitWriteFinish`.

## 1.4.3 (2016-02-27)

- Updated the async-each dependency to `^1.0.0`.

## 1.4.2 (2015-12-30)

- Fixed emitting `stats` with the `awaitWriteFinish` option.

## 1.4.1 (2015-12-09)

- Allowed subclassing the watcher with ES6 class syntax.

## 1.4.0 (2015-12-03)

- Added the `getWatched()` method, exposing all file system entries being watched.
- Applied `awaitWriteFinish` to `change` events in addition to `add`.
- Fixed handling of symlinks within glob paths ([#293](https://github.com/paulmillr/chokidar/issues/293)).
- Fixed `addDir` and `unlinkDir` events under globs ([#337](https://github.com/paulmillr/chokidar/issues/337), [#401](https://github.com/paulmillr/chokidar/issues/401)).
- Fixed issues with `unwatch()` ([#374](https://github.com/paulmillr/chokidar/issues/374), [#403](https://github.com/paulmillr/chokidar/issues/403)).

## 1.3.0 (2015-11-18)

- Improved `awaitWriteFinish` behavior and made it compatible with `cwd`.
- Fixed some `cwd` behavior on Windows.
- Fixed some race conditions.
- Fixed recreating a deleted directory not triggering an event ([#379](https://github.com/paulmillr/chokidar/issues/379)).
- Emitted `add` instead of `change` when a previously deleted file is added again.

## 1.2.0 (2015-10-01)

- Allowed nested arrays of paths in `watch()` and `add()`.
- Added the `awaitWriteFinish` option.

## 1.1.0 (2015-09-23)

- Updated dependencies, including fsevents 1.0.0, improving installation.

## 1.0.6 (2015-09-18)

- Fixed `unwatch()` with relative paths.

## 1.0.5 (2015-07-20)

- Fixed a regression with regexes and functions in `ignored`.

## 1.0.4 (2015-07-15)

- Fixed ignored files and globs while the `cwd` option is set.

## 1.0.3 (2015-06-04)

- Fixed a race with the `alwaysStat` option and removed files.

## 1.0.2 (2015-05-30)

- Fixed absolute paths and `ENAMETOOLONG` errors.

## 1.0.1 (2015-04-08)

- Fixed `close()` in `fs.watch` mode with `persistent: false`.

## 1.0.0 (2015-04-07)

- Added glob support in `watch()`, `add()`, and `unwatch()`.
- Added comprehensive symlink support.
- Added the `unwatch()` method.
- Made `ignored` accept a regex, function, glob, or array, through [anymatch](https://github.com/micromatch/anymatch).
- Added the `cwd`, `depth`, `alwaysStat`, `followSymlinks`, and `atomic` options.
- Added the `ready` event, emitted when the initial scan is done.
- Added the `raw` event, exposing data from the lower-level watch modules.
- Fixed many stability bugs.

## 0.12.6 (2015-01-06)

- Fixed `persistent: false` mode breaking when change events occur.

## 0.12.5 (2014-12-17)

- Fixed parent path detection for FSEvents instance sharing.
- Fixed ignored watch paths in Node.js fs modes.

## 0.12.4 (2014-12-14)

- Fixed the watcher leaking into `cwd` in `fs.watch` mode.
- Fixed symlinks to ignored paths preventing `ready`.

## 0.12.3 (2014-12-13)

- Fixed handling of special files such as named pipes and sockets.

## 0.12.2 (2014-12-13)

- Fixed recursive symlink handling and other path resolution problems.

## 0.12.1 (2014-12-10)

- Fixed file symlinks not being followed properly.

## 0.12.0 (2014-12-08)

- Added symlink support with the `followSymlinks` option, which defaults to `true`.
- Changed the default watch mode on Linux to non-polling `fs.watch`.
- Added the `atomic` option to normalize events from editors that use atomic writes, such as Vim and Sublime.
- Added the `raw` event, exposing data from the underlying watch method.

## 0.11.1 (2014-11-19)

- Fixed an error being thrown when `fs.watch` instantiation fails.

## 0.11.0 (2014-11-16)

- Added the `ready` event, emitted after the initial file scan.
- Fixed option keys explicitly set to `undefined`.

## 0.10.9 (2014-11-15)

- Fixed leftover issues from watcher reuse.

## 0.10.8 (2014-11-14)

- Removed an accidentally published `console.log` statement.

## 0.10.7 (2014-11-14)

- Applied watcher reuse to `fs.watch` and `fs.watchFile`.

## 0.10.6 (2014-11-12)

- Reused FSEvents instances more efficiently to avoid system limits.
- Handled errors thrown by `fs.watch` on invocation.

## 0.10.5 (2014-11-06)

- Limited the number of simultaneous FSEvents instances, falling back to other methods.
- Prevented some `EMFILE` errors during initialization.
- Fixed ignored files emitting events in some FSEvents cases.

## 0.10.4 (2014-11-05)

- Updated fsevents to `~0.3.1`, resolving build warnings and `npm rebuild` on non-Macs.

## 0.10.3 (2014-10-28)

- Fixed removed directories being emitted as `unlink` instead of `unlinkDir`.
- Fixed files changing to directories and vice versa ([#165](https://github.com/paulmillr/chokidar/issues/165)).
- Fixed the `ignored` option in FSEvents mode.

## 0.10.2 (2014-10-23)

- Improved watching of individual files.
- Fixed FSEvents keeping the process alive with `persistent: false`.

## 0.10.1 (2014-10-19)

- Improved handling of text editor atomic writes.

## 0.10.0 (2014-10-18)

- Improved stability and consistency, resolving many duplicate or wrong events.
- Corrected FSEvents inconsistencies.
- Standardized handling of errors and relative paths.
- Fixed watching `./`.

## 0.9.0 (2014-09-24)

- Updated fsevents to 0.3 and per-system defaults.
- Fixed closing a chokidar instance.
- Fixed duplicate `change` events on Windows.

## 0.8.4 (2014-08-14)

- Fixed regressions from 0.8.3.

## 0.8.3 (2014-08-14)

- Allowed FSEvents when not on Windows and polling is not explicitly disabled, contributed by [@wraithan](https://github.com/wraithan) in [pull request #134](https://github.com/paulmillr/chokidar/pull/134).
- Made closed watchers ignore further events and stop keeping the process alive, contributed by [@chrisdickinson](https://github.com/chrisdickinson) in [pull request #130](https://github.com/paulmillr/chokidar/pull/130).
- Ignored `ENOENT` errors, contributed by [@MichaelBailly](https://github.com/MichaelBailly) in [pull request #123](https://github.com/paulmillr/chokidar/pull/123).
- Worked around deleting directories on Windows, contributed by [@dkl-ppi](https://github.com/dkl-ppi) in [pull request #112](https://github.com/paulmillr/chokidar/pull/112).

## 0.8.2 (2014-03-25)

- Updated fsevents to 0.2, fixing npm issues.

## 0.8.1 (2013-12-16)

- Made optional dependencies truly optional on Windows and Linux.
- Rewrote the package in JavaScript again.
- Fixed some FSEvents bugs.

## 0.8.0 (2013-11-29)

- Added fast, low-CPU macOS watching with FSEvents, enabled by default.
- Added the `addDir` and `unlinkDir` events.
- Disabled polling by default on all platforms.

## 0.7.1 (2013-11-18)

- Made `close()` also remove all event listeners.

## 0.7.0 (2013-10-21)

- Called a two-argument `ignored` function again after stat, with the `stats` argument.
- Stopped emitting `unlink` for directories.

## 0.6.3 (2013-08-12)

- Added the `usePolling` option (default: `true`). When `false`, chokidar uses `fs.watch`, which is much faster but less reliable.

## 0.6.2 (2013-03-19)

- Fixed watching initially empty directories with the `ignoreInitial` option.

## 0.6.1 (2013-03-19)

- Added Node.js 0.10 support.

## 0.6.0 (2013-03-10)

- Passed file attributes (`stat()`) to `add` and `change` events as the second argument.
- Changed the default polling interval for binary files to 300 ms.

## 0.5.3 (2013-01-13)

- Stopped emitting `change` before `unlink`.

## 0.5.2 (2013-01-13)

- Removed the postinstall script to avoid npm bugs.

## 0.5.1 (2013-01-06)

- Stopped throwing `ENOENT` when watching paths that do not exist.
- Fixed absolute paths.

## 0.5.0 (2012-12-09)

- Added the `ignoreInitial` option to skip initial `add` events.
- Added the `ignorePermissionErrors` option.
- Added the `interval` and `binaryInterval` options to change polling intervals.

## 0.4.0 (2012-07-26)

- Added the `all` event, which receives the event name and path for `add`, `change`, and `unlink`.
- Switched to `fs.watchFile` on Node.js 0.8 on Windows.
- Fixed files not being unwatched after `unlink`.

## 0.3.0 (2012-06-24)

- Stopped emitting `unlink` for directories, for consistency with `add`.

## 0.2.6 (2012-06-08)

- Prevented duplicate `add` events.

## 0.2.5 (2012-06-08)

- Fixed new files in new directories not being added.

## 0.2.4 (2012-06-06)

- Fixed unlinked files emitting events after `unlink`.

## 0.2.3 (2012-05-12)

- Fixed watching files on Windows.

## 0.2.2 (2012-05-04)

- Fixed the watcher signature.

## 0.2.1 (2012-05-04)

- Fixed an invalid API bug when using `watch()`.

## 0.2.0 (2012-05-04)

- Rewrote the package in JavaScript.

## 0.1.1 (2012-04-26)

- Changed the API to `chokidar.watch()`.
- Fixed compilation on Windows.

## 0.1.0 (2012-04-20)

- Initial release, extracted from [Brunch](https://github.com/brunch/brunch/blob/9847a065aea300da99bd0753f90354cde9de1261/src/helpers.coffee#L66).
