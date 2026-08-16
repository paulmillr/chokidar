#!/usr/bin/env node

// Reproducible backend benchmark. Run `npm run build` first.
// Parent: node benchmark/bench.mjs [file-count ...]
// Child:  node benchmark/bench.mjs --child <mode> <root> <config-json> <result-file>
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import * as sp from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CHOKIDAR = new URL('../index.js', import.meta.url).href;
const ALL_MODES = ['native-per-directory', 'native-recursive', 'polling'];
const ALL_SHAPES = ['balanced', 'wide', 'deep'];
const ALL_SCENARIOS = ['baseline', 'ignored-depth'];
const MODES = selection('CHOKIDAR_BENCH_MODES', ALL_MODES);
const SHAPES = selection('CHOKIDAR_BENCH_SHAPES', ALL_SHAPES);
const SCENARIOS = selection('CHOKIDAR_BENCH_SCENARIOS', ALL_SCENARIOS);
const DEFAULT_FILE_COUNTS = [20_000];
const FILES_PER_DIR = positiveInteger('CHOKIDAR_BENCH_FILES_PER_DIR', 100);
const LATENCY_SAMPLES = positiveInteger('CHOKIDAR_BENCH_LATENCY_SAMPLES', 100);
const BURST_FILES = positiveInteger('CHOKIDAR_BENCH_BURST_FILES', 500);
const ROUNDS = positiveInteger('CHOKIDAR_BENCH_ROUNDS', 3);
const BENCH_TMPDIR = process.env.CHOKIDAR_BENCH_TMPDIR ?? tmpdir();
const BENCH_OUTPUT = process.env.CHOKIDAR_BENCH_OUTPUT;
const execFileAsync = promisify(execFile);

function selection(name, allowed) {
  const raw = process.env[name];
  if (!raw) return allowed;
  const values = raw.split(',').map((value) => value.trim());
  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length > 0) throw new Error(`${name} contains unknown values: ${invalid.join(', ')}`);
  return values;
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function parseCount(raw) {
  const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(raw.replaceAll('_', ''));
  if (!match) throw new Error(`invalid file count: ${raw}`);
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1_000 : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid file count: ${raw}`);
  return value;
}

function treeConfig(fileCount, shape, scenario) {
  const leafDirs = Math.ceil(fileCount / FILES_PER_DIR);
  return {
    fileCount,
    filesPerDir: FILES_PER_DIR,
    leafDirs,
    shape,
    scenario,
    depth: scenario === 'ignored-depth' ? 2 : undefined,
  };
}

function directoryForIndex(root, config, index) {
  if (config.shape === 'wide') return sp.join(root, `wide-${index}`);
  if (config.shape === 'deep') {
    const depth = Math.min(index + 1, 64);
    return sp.join(root, ...Array.from({ length: depth }, (_, part) => `deep-${part}`));
  }
  const first = index % Math.min(100, config.leafDirs);
  const second = Math.floor(index / Math.min(100, config.leafDirs));
  return sp.join(root, `balanced-${first}`, `leaf-${second}`);
}

function fileForIndex(root, config, index) {
  const directoryIndex = Math.floor(index / config.filesPerDir);
  return sp.join(directoryForIndex(root, config, directoryIndex), `file-${index}.txt`);
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * sorted.length));
  return sorted[index];
}

function collapseAdjacentDuplicates(events) {
  return events.filter((event, index) => index === 0 || event !== events[index - 1]);
}

async function inotifyWatchCount() {
  if (process.platform !== 'linux') return null;
  let count = 0;
  try {
    for (const fd of await readdir('/proc/self/fd')) {
      try {
        const link = await readlink(`/proc/self/fd/${fd}`);
        if (!link.includes('inotify')) continue;
        const info = await readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
        count += info.match(/^inotify wd:/gmu)?.length ?? 0;
      } catch {}
    }
  } catch {
    return null;
  }
  return count;
}

async function waitForEvent(watcher, event, expectedPath, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      watcher.off(event, listener);
      reject(new Error(`timeout waiting for ${event}: ${expectedPath}`));
    }, timeoutMs);
    const listener = (path) => {
      if (path !== expectedPath) return;
      clearTimeout(timeout);
      watcher.off(event, listener);
      resolve();
    };
    watcher.on(event, listener);
  });
}

async function candidateFiles(root, config) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => sp.join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(`${sp.join(root, 'ignored')}${sp.sep}`))
    .filter((path) => {
      if (config.depth === undefined) return true;
      return sp.relative(root, path).split(sp.sep).length <= config.depth + 1;
    });
}

function watcherOptions(root, mode, config) {
  const options = {
    backend:
      mode === 'polling' ? 'polling' : mode === 'native-recursive' ? 'native-recursive' : 'native',
    atomic: false,
  };
  if (mode === 'polling') options.pollingInterval = 25;
  if (config.depth !== undefined) options.depth = config.depth;
  if (config.scenario === 'ignored-depth') {
    options.ignored = { path: sp.join(root, 'ignored'), recursive: true };
  }
  return options;
}

async function resetRuntimePaths(root) {
  await Promise.all([
    rm(sp.join(root, 'burst'), { recursive: true, force: true }),
    rm(sp.join(root, 'trace-file.txt'), { force: true }),
    rm(sp.join(root, 'trace-moved'), { recursive: true, force: true }),
  ]);
}

async function normalizedTrace(watcher, root) {
  const trace = [];
  const collect = (event, path) => {
    const relative = sp.relative(root, path);
    if (
      relative !== 'trace-file.txt' &&
      relative !== 'trace-moved' &&
      !relative.startsWith(`trace-moved${sp.sep}`)
    )
      return;
    trace.push(`${event}:${relative}`);
  };
  watcher.on('all', collect);
  const file = sp.join(root, 'trace-file.txt');
  const add = waitForEvent(watcher, 'add', file);
  await writeFile(file, 'one');
  await add;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const change = waitForEvent(watcher, 'change', file);
  await writeFile(file, 'two-with-a-different-size');
  await change;
  const remove = waitForEvent(watcher, 'unlink', file);
  await unlink(file);
  await remove;

  const source = await mkdtemp(sp.join(BENCH_TMPDIR, 'chokidar-move-'));
  await writeFile(sp.join(source, 'inside.txt'), 'inside');
  const destination = sp.join(root, 'trace-moved');
  const movedChild = sp.join(destination, 'inside.txt');
  const addDir = waitForEvent(watcher, 'addDir', destination);
  const addChild = waitForEvent(watcher, 'add', movedChild);
  await rename(source, destination);
  await Promise.all([addDir, addChild]);
  const removeDir = waitForEvent(watcher, 'unlinkDir', destination);
  await rm(destination, { recursive: true });
  await removeDir;
  watcher.off('all', collect);
  return collapseAdjacentDuplicates(trace);
}

async function runChild(mode, root, rawConfig, resultFile) {
  const config = JSON.parse(rawConfig);
  await resetRuntimePaths(root);
  const chokidar = await import(CHOKIDAR);
  const options = watcherOptions(root, mode, config);
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const initialCounts = {};
  const readyStarted = performance.now();
  const watcher = chokidar.watch(root, options);
  const countInitial = (event) => {
    initialCounts[event] = (initialCounts[event] ?? 0) + 1;
  };
  watcher.on('all', countInitial);
  await new Promise((resolve, reject) => {
    watcher.once('ready', resolve);
    watcher.once('error', reject);
  });
  watcher.off('all', countInitial);
  const readyMs = performance.now() - readyStarted;
  global.gc?.();
  const rssAfterReady = process.memoryUsage().rss;
  const kernelWatches = await inotifyWatchCount();

  const files = await candidateFiles(root, config);
  if (files.length === 0) throw new Error('scenario produced no watched latency candidates');
  const latencies = [];
  let latencyTimeouts = 0;
  for (let index = 0; index < LATENCY_SAMPLES; index++) {
    const path = files[(index * 7919) % files.length];
    const started = performance.now();
    try {
      const changed = waitForEvent(watcher, 'change', path, 5_000);
      await writeFile(path, `latency-${index}-${Date.now()}`);
      await changed;
      latencies.push(performance.now() - started);
    } catch {
      latencyTimeouts += 1;
    }
  }

  const burstDirectory = sp.join(root, 'burst');
  await mkdir(burstDirectory);
  let burstAdds = 0;
  let finishBurst;
  const burstFinished = new Promise((resolve) => {
    finishBurst = resolve;
  });
  const countBurst = (path) => {
    if (sp.dirname(path) !== burstDirectory) return;
    burstAdds += 1;
    if (burstAdds === BURST_FILES) finishBurst();
  };
  watcher.on('add', countBurst);
  const burstStarted = performance.now();
  await Promise.all(
    Array.from({ length: BURST_FILES }, (_, index) =>
      writeFile(sp.join(burstDirectory, `burst-${index}.txt`), 'burst')
    )
  );
  let burstTimeout;
  await Promise.race([
    burstFinished,
    new Promise((resolve) => {
      burstTimeout = setTimeout(resolve, 15_000);
    }),
  ]);
  clearTimeout(burstTimeout);
  const burstMs = performance.now() - burstStarted;
  watcher.off('add', countBurst);

  const trace = await normalizedTrace(watcher, root);
  const closeStarted = performance.now();
  await watcher.close();
  const closeMs = performance.now() - closeStarted;
  await resetRuntimePaths(root);

  const result = {
    node: process.version,
    platform: process.platform,
    osRelease: osRelease(),
    arch: process.arch,
    mode,
    options,
    ...config,
    readyMs,
    rssDeltaBytes: rssAfterReady - rssBefore,
    kernelWatches,
    initialCounts,
    latencyMedianMs: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyTimeouts,
    burstExpected: BURST_FILES,
    burstAdds,
    burstMs,
    closeMs,
    normalizedTrace: trace,
  };
  await writeFile(resultFile, JSON.stringify(result));
}

async function buildTree(root, config) {
  for (let directoryIndex = 0; directoryIndex < config.leafDirs; directoryIndex++) {
    const directory = directoryForIndex(root, config, directoryIndex);
    await mkdir(directory, { recursive: true });
    const first = directoryIndex * config.filesPerDir;
    const last = Math.min(config.fileCount, first + config.filesPerDir);
    await Promise.all(
      Array.from({ length: last - first }, (_, offset) => {
        const index = first + offset;
        return writeFile(fileForIndex(root, config, index), 'seed');
      })
    );
  }
  const ignored = sp.join(root, 'ignored', 'nested');
  await mkdir(ignored, { recursive: true });
  await writeFile(sp.join(ignored, 'ignored.txt'), 'ignored');
  await symlink(
    directoryForIndex(root, config, 0),
    sp.join(root, 'sample-link'),
    process.platform === 'win32' ? 'junction' : undefined
  );
}

function summarize(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.fileCount}/${result.shape}/${result.scenario}/${result.mode}`;
    const values = groups.get(key) ?? [];
    values.push(result);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, values]) => ({
    key,
    rounds: values.length,
    readyMedianMs: percentile(
      values.map((value) => value.readyMs),
      50
    ),
    readyP95Ms: percentile(
      values.map((value) => value.readyMs),
      95
    ),
    rssMedianBytes: percentile(
      values.map((value) => value.rssDeltaBytes),
      50
    ),
    kernelWatchesMedian: percentile(
      values.map((value) => value.kernelWatches).filter((value) => value !== null),
      50
    ),
    latencyMedianMs: percentile(
      values.map((value) => value.latencyMedianMs).filter((value) => value !== null),
      50
    ),
    latencyP95Ms: percentile(
      values.map((value) => value.latencyP95Ms).filter((value) => value !== null),
      95
    ),
    latencyTimeouts: values.map((value) => value.latencyTimeouts),
    burstCompleteness: values.map((value) => `${value.burstAdds}/${value.burstExpected}`),
    burstMedianMs: percentile(
      values.map((value) => value.burstMs),
      50
    ),
    burstP95Ms: percentile(
      values.map((value) => value.burstMs),
      95
    ),
    closeMedianMs: percentile(
      values.map((value) => value.closeMs),
      50
    ),
    closeP95Ms: percentile(
      values.map((value) => value.closeMs),
      95
    ),
  }));
}

function parity(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.fileCount}/${result.shape}/${result.scenario}/round-${result.round}`;
    const values = groups.get(key) ?? [];
    values.push(result);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, values]) => {
    const traces = Object.fromEntries(values.map((value) => [value.mode, value.normalizedTrace]));
    const initialCounts = Object.fromEntries(
      values.map((value) => [value.mode, value.initialCounts])
    );
    return {
      key,
      tracesMatch: new Set(Object.values(traces).map((trace) => JSON.stringify(trace))).size === 1,
      initialCountsMatch:
        new Set(Object.values(initialCounts).map((counts) => JSON.stringify(counts))).size === 1,
      traces,
      initialCounts,
    };
  });
}

async function runParent() {
  const self = fileURLToPath(import.meta.url);
  const counts = process.argv.slice(2).map(parseCount);
  const fileCounts = counts.length ? counts : DEFAULT_FILE_COUNTS;
  const results = [];
  await mkdir(BENCH_TMPDIR, { recursive: true });
  for (const fileCount of fileCounts) {
    for (const shape of SHAPES) {
      for (const scenario of SCENARIOS) {
        const config = treeConfig(fileCount, shape, scenario);
        const root = await mkdtemp(sp.join(BENCH_TMPDIR, 'chokidar-bench-'));
        await buildTree(root, config);
        try {
          const filesystem = await statfs(root);
          for (let round = 0; round < ROUNDS; round++) {
            const order = round % 2 === 0 ? MODES : [...MODES].reverse();
            for (const mode of order) {
              const resultFile = sp.join(
                BENCH_TMPDIR,
                `chokidar-result-${process.pid}-${Date.now()}.json`
              );
              await execFileAsync(
                process.execPath,
                ['--expose-gc', self, '--child', mode, root, JSON.stringify(config), resultFile],
                { timeout: 15 * 60_000 }
              );
              const result = JSON.parse(await readFile(resultFile, 'utf8'));
              await rm(resultFile, { force: true });
              result.round = round;
              result.filesystemType = filesystem.type;
              results.push(result);
              process.stderr.write(`${JSON.stringify(result)}\n`);
            }
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
  const parityResults = parity(results);
  const report = { results, summary: summarize(results), parity: parityResults };
  if (BENCH_OUTPUT) {
    const output = sp.resolve(BENCH_OUTPUT);
    await mkdir(sp.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const failures = [];
  for (const result of results) {
    if (result.latencyTimeouts > 0) {
      failures.push(`${result.mode} had ${result.latencyTimeouts} latency timeout(s)`);
    }
    if (result.burstAdds !== result.burstExpected) {
      failures.push(
        `${result.mode} observed ${result.burstAdds}/${result.burstExpected} burst adds`
      );
    }
  }
  for (const result of parityResults) {
    if (!result.tracesMatch) failures.push(`${result.key} normalized traces differ`);
    if (!result.initialCountsMatch) failures.push(`${result.key} initial counts differ`);
  }
  if (failures.length > 0) {
    throw new Error(`benchmark correctness checks failed:\n${failures.join('\n')}`);
  }
}

if (process.argv[2] === '--child') {
  const [, , , mode, root, rawConfig, resultFile] = process.argv;
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  await runChild(mode, root, rawConfig, resultFile);
} else {
  await runParent();
}
