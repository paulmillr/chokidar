# Watcher Architecture

Chokidar has one observation pipeline:

```text
native/polling resource -> BackendTrigger -> per-root queue
  -> stat/scan -> TreeState transition -> EventPolicy -> public event
```

A backend callback is an invalidation, not filesystem truth. The observation engine confirms it
with `lstat`, `stat`, or `readdirp`, commits the result to the per-watcher tree, then asks the
event policy to publish. Tests in `src/*.test.ts` are the executable specification when this
document is unclear; option semantics live in `README.md`.

## Modules

| Module         | Owns                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| `runtime.ts`   | Platform/error helpers, `Scheduler`, types, path keys, matchers, `WatchHelper` |
| `backend.ts`   | `selectBackend()`; process-global native, recursive, and polling resources     |
| `tree.ts`      | `LifecycleScope`, `ReconciliationQueue`, `TreeState`, `WatcherContext` port    |
| `policy.ts`    | `EventPolicy`: atomic, awaitWriteFinish, change/remove windows, policy timers  |
| `reconcile.ts` | `ObservationEngine`: the only subscriber, scanner, and tree-transition engine  |
| `index.ts`     | `FSWatcher`: option resolution, ignores, ready, unwatch/close, public events   |

The import graph is a DAG, `runtime -> {backend, tree} -> policy -> reconcile -> index`
(`tree.ts` sees `EventPolicy` only as an erased type), and nothing enforces it mechanically.
Nothing below `index.ts` imports the watcher: `ObservationEngine` receives the narrow
`WatcherContext` port, the constructor cast in `index.ts` is the only bridge, and backends never
see that port, so they cannot mutate watcher state or publish events. `testing.ts` is the only
test seam and is not packaged.

## Invariants

1. Backend notifications are invalidations; `stat`/scan results are truth.
2. Only `ObservationEngine` commits additions, changes, removals, and scan diffs to `TreeState`.
3. Reconciliation is serial per logical root and coalesced per `(root, candidate)`.
4. Work from a stale lifecycle generation or path generation never commits after `close()` or
   `unwatch()`.
5. Every timer belongs to `EventPolicy`, a subscription closer, or a shared backend resource.
6. A directory subscription is established before its scan; callbacks arriving during the scan
   are buffered (at most 1024) and replayed without coalescing before the subscription goes
   live; overflow degrades to one bulk rescan.
7. Backend resources may be shared across watchers; trees, ignores, symlink state, and event
   timing never are.
8. `ready` means initial tracked-task quiescence: it fires at most once and never after close.
   There is no ready counter.
9. After any burst the final public state is truthful: an existing path is not left unlinked and
   a missing path is not left added.

## Path identities

- **Logical key** — `logicalPathKey(path)`: `path.resolve` with forward slashes, keeping the
  user's symlink spelling. Keys the tree, policy, closers, barriers, and queue.
- **Backend resource key** — lexical `path.resolve`. Exact matches share one OS handle; nested
  roots and symlink aliases do not. Poll resources are additionally keyed by `Scheduler`.
- **Presentation path** — produced only at emit time (Windows normalization, optional `cwd`
  relativization). Never a map key.

Native callback names are validated against their root before being joined, and containment
checks use path segments, never string prefixes.

## Configuration

Options are resolved and frozen once in the constructor: `usePolling`, IBM i, and
`CHOKIDAR_USEPOLLING` are folded into `backend`, then `selectBackend()` reduces `backend` and
`depth` to frozen capabilities `{kind, polling, recursive, perDirectory}`. Everything downstream
reads those, never option strings or env. Two defaults are easy to get wrong: a falsy
`CHOKIDAR_USEPOLLING` resets an explicit polling choice to `auto`, and `atomic` defaults to
`!polling` from the _raw_ option.

## Shared backends

Each process-global registry entry owns one handle or poll loop, a generation, and a subscriber set
that is its refcount; publish and teardown re-check registry identity so a stale callback or closer
cannot touch a replacement generation. `raw` is emitted at publish time, once per subscriber, and
never on replay.

**Native per-directory.** One `fs.watch` per exact directory key. Files never own handles: a file
inside a watched directory is a filtered child of that directory's subscription, an explicitly
watched file subscribes to its parent and filters its basename, and a followed file symlink
subscribes to the target's parent and projects the candidate back to the logical link.

**Native recursive.** `fs.watch(root, {recursive: true})` is a subscription topology, not a second
transition engine. Only `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` latches "unsupported" process-wide,
after which roots silently use per-directory subscriptions; any other setup or runtime error is
reported, and a runtime failure moves that root to per-directory fallback.

**Owned polling.** Polling never uses `fs.watchFile`: each watched path is a Chokidar-owned `stat`
loop, shared per `(resource key, Scheduler)` at the fastest subscriber interval. A changed
directory is rechecked once 1000 ms later because some filesystems bump directory mtime before
contents settle. Detection semantics are documented in `README.md`.

Native triggers are stamped with process-global `performance.now()`; poll triggers and all policy
timers use the injected `Scheduler`. The two time domains are never compared.

### Platform quirks

- **Windows**: native handles are opened on the realpath spelling (Node 24 compares callback paths
  against it) and absolute callback names are projected back to relative; keys stay lexical.
  `EPERM` on a deleted watched directory becomes one final `rename` invalidation before the
  resource closes. A directly watched directory also keeps a parent handle because Windows can
  retire an empty root's own handle on removal. Polling ignores inodes.
- **macOS**: explicitly watched files and followed file symlinks (both observed via a parent
  directory) also open a one-shot exact-target handle because FSEvents can miss the first parent
  callback after setup; the parent takes over on the first match and one fallback echo is
  deduplicated by stat snapshot. An explicitly watched unfollowed symlink is polled for deletion
  because the native handle can miss it. FSEvents batches rapid writes.

## Reconciliation

`ReconciliationQueue.enqueue(root, work, candidate)` chains work per root. If the same
`(root, candidate)` is invalidated while its work is queued or running, the newest closure replaces
the pending one and requests a replay; this repeats until a pass completes with no new
notification. Ignore checks walk ancestors before the candidate because recursive backends still
deliver callbacks from ignored subtrees.

Missing paths: a missing descendant climbs to the outermost missing ancestor so intermediate
`unlinkDir` events are retained; a missing root climbs to its nearest existing parent and watches
that parent for the basename to reappear (also used when the last watched file disappears).

`TreeState.observed` records native stat facts only to suppress backend-shaped echoes: a
create-then-change echo within 25 ms, a same-kind write echo within 10 ms, and an unchanged
initial/null-name file invalidation. The 50 ms `change` window in `EventPolicy` remains the only
user-visible burst window.

## Event policy

`EventPolicy.emit` applies, in order:

```text
closed/path-generation check -> Windows/cwd presentation -> pending write bump
  -> atomic unlink/add pairing -> await-write-finish -> 50 ms change window
  -> alwaysStat -> publish (+ all)
```

- Await-write-finish starts only after `ready`.
- The change window replays the newest differing stats once when it closes.
- `removePath` has a 100 ms `remove` gate so concurrent removal paths cannot double-emit.
- `alwaysStat` fills missing stats; a stat failure suppresses that event and reports the error.
- The `readdir`/`watch`/`add` throttle types are legacy: queue coalescing replaced them.

## Ignores, depth, and symlinks

Ignore order: editor temp files (only when `atomic`) -> user matchers -> unwatch matchers. User
path matchers are normalized against `cwd` and, on non-Windows, also matched against a cached
realpath projection so `/var` and `/private/var` agree on macOS. Stats-aware matcher functions are
called twice: without stats, then with. An unwatched path stays ignored until re-`add()`ed. Depth
is counted in segments from the logical root.

Symlinks start with `lstat`. With `followSymlinks: false` the link is a leaf and retargeting emits
`change`. With following on, the logical spelling is kept while a realpath ancestry set breaks
cycles; a followed directory symlink is watched per-directory even under a recursive root.

## Lifecycle and testing

`close()` is memoized and terminal; `add()` after close throws. `unwatch()` is synchronous: it
records a path barrier (a new path generation) so in-flight work scoped at or under that path can
no longer commit, then closes the path and adds an ignore matcher.

Tests reach internals only through `src/testing.ts` (`inspectWatcher`, `backendTesting`); never
add test hooks to `FSWatcher` or `ObservationEngine`. `src/index.test.ts` is the sole entry and
runs the shared suite under native per-directory, recursive-preferred (where supported), and owned
polling; timing tests inject a virtual `Scheduler` and assert that no timers survive close.

Only `./index.js` is exported. `package.json.files` lists each runtime module's `.js` and `.d.ts`
explicitly, so a new runtime module must be added there; `testing.js` and tests never ship.
