# Chokidar 0.5.3 (January 13, 2012)
* Removed emitting of `change` events before `unlink`.

# Chokidar 0.5.2 (January 13, 2012)
* Removed postinstall script to prevent various npm bugs.

# Chokidar 0.5.1 (January 6, 2012)
* When starting to watch non-existing paths, chokidar will no longer throw
ENOENT error.
* Fixed bug with absolute path.

# Chokidar 0.5.0 (December 9, 2012)
* Added a bunch of new options:
    * `ignoreInitial` that allows to ignore initial `add` events.
    * `ignorePermissionErrors` that allows to ignore ENOENT etc perm errors.
    * `interval` and `binaryInterval` that allow to change default
    fs polling intervals.

# Chokidar 0.4.0 (July 26, 2012)
* Added `all` event that receives two args (event name and path) that
combines `add`, `change` and `unlink` events.
* Switched to `fs.watchFile` on node.js 0.8 on windows.
* Files are now correctly unwatched after unlink.

# Chokidar 0.3.0 (June 24, 2012)
* `unlink` event are no longer emitted for directories, for consistency
with `add`.

# Chokidar 0.2.6 (June 8, 2012)
* Prevented creating of duplicate 'add' events.

# Chokidar 0.2.5 (June 8, 2012)
* Fixed a bug when new files in new directories hadn't been added.

# Chokidar 0.2.4 (June 7, 2012)
* Fixed a bug when unlinked files emitted events after unlink.

# Chokidar 0.2.3 (May 12, 2012)
* Fixed watching of files on windows.

# Chokidar 0.2.2 (May 4, 2012)
* Fixed watcher signature.

# Chokidar 0.2.1 (May 4, 2012)
* Fixed invalid API bug when using `watch()`.

# Chokidar 0.2.0 (May 4, 2012)
* Rewritten in js.

# Chokidar 0.1.1 (April 26, 2012)
* Changed api to `chokidar.watch()`.
* Fixed compilation on windows.

# Chokidar 0.1.0 (April 20, 2012)
* Initial release.
