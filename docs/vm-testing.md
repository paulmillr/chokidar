# Cross-platform CI

Chokidar's watcher behavior must be exercised on real Linux, macOS, and Windows
filesystems. The CI matrix provisions fresh GitHub-hosted virtual machines for each run:

| Guest   | GitHub runner  | Filesystem under test   |
| ------- | -------------- | ----------------------- |
| Linux   | `ubuntu-24.04` | Native runner workspace |
| macOS   | `macos-15`     | Native runner workspace |
| Windows | `windows-2025` | Native runner workspace |

The test directory is deliberately not a Vagrant, SMB, VirtioFS, or host-shared mount.
Those layers can change or suppress filesystem notifications and would test the mount
implementation as much as Chokidar.

GitHub-hosted runners are used because each job receives a fresh VM and macOS remains on
Apple hardware. Public repositories receive standard hosted runners without Actions-minute
charges; private forks are subject to the account's Actions allowance.

## One-time setup

1. Install [GitHub CLI](https://cli.github.com/) and run `gh auth login`.
2. Ensure `.github/workflows/test-js.yml` is registered on the repository's default branch.
   Pushes and pull requests start the matrix automatically.
3. Give the authenticated account Actions access to the target repository.

The watcher script does not create a run, commit, or push code. It only locates the automatic
run for an identifiable pushed commit and follows it using read-only Actions access.

## Development loop

Run fast tests locally while editing. A push automatically starts the CI matrix:

```sh
git switch v6
git commit -am "WIP: watcher lifecycle"
git push -u origin v6
```

`npm run test:vms` verifies that tracked files are clean and the local and remote commits
match. It finds the automatic run for that commit, prints its URL, waits for the matrix,
and exits non-zero if any guest fails. Untracked files are ignored because they cannot be
part of the pushed commit.

Useful variants:

```sh
# Print the matching run without waiting for it.
npm run test:vms -- --no-wait

# Watch the automatic run for another pushed branch.
npm run test:vms -- --ref watcher-backends

# Watch a fork while verifying its `fork` remote.
npm run test:vms -- --remote fork --repo owner/chokidar
```

The matrix runs the latest releases of Node `22`, `24`, and `26` on every operating system. OS
and runtime differences therefore remain separable without a second workflow.

## What every VM run checks

Each guest performs, in order:

1. `npm ci`
2. `npm run lint`
3. `npm run build`
4. `npm pack --dry-run`
5. `npm test`
6. A small backend-parity benchmark on Node 22 and 24

Building before testing is required because the tests import the generated root files,
not TypeScript directly. The matrix is configured with `fail-fast: false`, so a Linux
failure does not hide macOS or Windows results. A newer push for the same Git reference
cancels its older run to keep development feedback current.

These machines are disposable test environments, not persistent interactive desktops.
Use the retained Actions logs and push a follow-up commit when diagnosing an OS-specific
case; the read-only helper cannot rerun jobs. If persistent macOS guests are ever
introduced, they must run on Apple-branded hardware; Linux-hosted macOS emulation is
intentionally outside this setup.
