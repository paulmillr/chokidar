#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const WORKFLOW = 'test-js.yml';

const help = `Usage: node scripts/test-vms.mjs [options]

Find the automatic cross-platform CI run for a pushed commit and watch it.

Options:
  --ref <branch>       Pushed branch to test (default: current branch)
  --remote <name>      Git remote used to verify the pushed commit (default: origin)
  --repo <owner/name>  GitHub repository containing the run (default: inferred by gh)
  --no-wait            Print the matching run and return without watching it
  -h, --help           Show this help
`;

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function execute(command, args, { inherit = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });

  if (result.error?.code === 'ENOENT') {
    die(`required command not found: ${command}`);
  }
  if (result.error) {
    die(`${command} could not be started: ${result.error.message}`);
  }
  return result;
}

function capture(command, args, failureMessage) {
  const result = execute(command, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    die(detail ? `${failureMessage}\n${detail}` : failureMessage);
  }
  return result.stdout.trim();
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) die(`${option} requires a value`);
  return value;
}

const cliArgs = process.argv.slice(2);
let ref;
let remote = 'origin';
let repository;
let wait = true;

for (let index = 0; index < cliArgs.length; index += 1) {
  const option = cliArgs[index];
  if (option === '--ref') {
    ref = readValue(cliArgs, index, option);
    index += 1;
  } else if (option === '--remote') {
    remote = readValue(cliArgs, index, option);
    index += 1;
  } else if (option === '--repo') {
    repository = readValue(cliArgs, index, option);
    index += 1;
  } else if (option === '--no-wait') {
    wait = false;
  } else if (option === '--help' || option === '-h') {
    process.stdout.write(help);
    process.exit(0);
  } else {
    die(`unknown option: ${option}\n\n${help}`);
  }
}

capture('git', ['rev-parse', '--show-toplevel'], 'run this command inside the Chokidar repository');
capture('gh', ['--version'], 'install GitHub CLI (gh) before watching CI runs');

const authArgs = ['auth', 'status', '--hostname', 'github.com'];
capture('gh', authArgs, 'authenticate GitHub CLI with `gh auth login`');

const currentBranchResult = execute('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
const currentBranch =
  currentBranchResult.status === 0 ? currentBranchResult.stdout.trim() : undefined;
if (!ref) {
  if (!currentBranch) die('HEAD is detached; pass --ref with a pushed branch name');
  ref = currentBranch;
}

if (ref === currentBranch) {
  const worktree = capture(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    'could not inspect the worktree'
  );
  if (worktree) {
    die(
      'the worktree has tracked changes. Commit and push the code before watching CI; ' +
        'the automatic run only covers the pushed commit.'
    );
  }
}

const localSha = capture('git', ['rev-parse', `${ref}^{commit}`], `local branch not found: ${ref}`);
const remoteLine = capture(
  'git',
  ['ls-remote', remote, `refs/heads/${ref}`],
  `could not read ${remote}/${ref}`
);
if (!remoteLine) die(`branch ${ref} has not been pushed to ${remote}`);
const remoteSha = remoteLine.split(/\s+/u)[0];
if (localSha !== remoteSha) {
  die(
    `${ref} is not fully pushed to ${remote} (local ${localSha.slice(0, 12)}, ` +
      `remote ${remoteSha.slice(0, 12)})`
  );
}

const repositoryArgs = repository ? ['--repo', repository] : [];
const workflowView = execute('gh', ['workflow', 'view', WORKFLOW, ...repositoryArgs]);
if (workflowView.status !== 0) {
  die(
    `${WORKFLOW} is not registered on the repository's default branch. ` +
      'Land the workflow there before watching feature-branch runs.'
  );
}

let run;
for (let attempt = 0; attempt < 30 && !run; attempt += 1) {
  const runsJson = capture(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--branch',
      ref,
      '--limit',
      '20',
      '--json',
      'databaseId,headSha,status,url',
      ...repositoryArgs,
    ],
    'could not list automatic CI runs'
  );
  const runs = JSON.parse(runsJson);
  run = runs.find((candidate) => candidate.headSha === remoteSha);
  if (!run) await new Promise((resolve) => setTimeout(resolve, 2_000));
}

if (!run) {
  die(
    `no automatic ${WORKFLOW} run appeared for ${remoteSha.slice(0, 12)} within 60 seconds; ` +
      'push the commit or check whether GitHub Actions is enabled'
  );
}
console.log(`Cross-platform CI run: ${run.url}`);
if (!wait) process.exit(0);

const watchResult = execute(
  'gh',
  ['run', 'watch', String(run.databaseId), '--compact', '--exit-status', ...repositoryArgs],
  { inherit: true }
);
if (watchResult.status !== 0) {
  execute('gh', ['run', 'view', String(run.databaseId), '--log-failed', ...repositoryArgs], {
    inherit: true,
  });
  process.exit(watchResult.status ?? 1);
}
