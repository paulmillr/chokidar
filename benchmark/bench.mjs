// Benchmark: chokidar per-directory watchers vs useRecursiveWatch
// Run `npm run build` first: this imports the compiled index.js.
// Usage: node benchmark/bench.mjs [file-count ...]   (parent)
//        node benchmark/bench.mjs <mode> <dir> <json-config> [result-file]  (child)
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as sp from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CHOKIDAR = new URL('../index.js', import.meta.url).href;
const DEFAULT_FILE_COUNTS = [20_000];
const FILES_PER_DIR = Number(process.env.CHOKIDAR_BENCH_FILES_PER_DIR ?? 100);
const LATENCY_SAMPLES = Number(process.env.CHOKIDAR_BENCH_LATENCY_SAMPLES ?? 200);
const CHURN_FILES = Number(process.env.CHOKIDAR_BENCH_CHURN_FILES ?? 500);
const ROUNDS = Number(process.env.CHOKIDAR_BENCH_ROUNDS ?? 3);
const BENCH_TMPDIR = process.env.CHOKIDAR_BENCH_TMPDIR ?? tmpdir();
const MODES = ['per-directory', 'recursive'];

const parseCount = (raw) => {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(raw.replaceAll('_', ''));
  if (!match) throw new Error(`invalid file count: ${raw}`);
  const scale =
    match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid file count: ${raw}`);
  return value;
};

const treeConfig = (fileCount) => {
  const leafDirs = Math.ceil(fileCount / FILES_PER_DIR);
  const dirsL1 = Math.min(100, leafDirs);
  const dirsL2 = Math.ceil(leafDirs / dirsL1);
  return { fileCount, leafDirs, dirsL1, dirsL2, filesPerDir: FILES_PER_DIR };
};

const dirPathForIndex = (root, config, dirIndex) => {
  const l1 = dirIndex % config.dirsL1;
  const l2 = Math.floor(dirIndex / config.dirsL1);
  return sp.join(root, `d${l1}`, `d${l2}`);
};

const filePathForIndex = (root, config, fileIndex) => {
  const dirIndex = Math.floor(fileIndex / config.filesPerDir);
  const fileInDir = fileIndex % config.filesPerDir;
  return sp.join(dirPathForIndex(root, config, dirIndex), `f${fileInDir}.txt`);
};

const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function inotifyWatchCount() {
  let count = 0;
  try {
    const fds = await readdir('/proc/self/fd');
    for (const fd of fds) {
      try {
        const link = await readlink(`/proc/self/fd/${fd}`);
        if (!link.includes('inotify')) continue;
        const info = await readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
        count += (info.match(/^inotify wd:/gm) || []).length;
      } catch {}
    }
  } catch {}
  return count;
}

async function runChild(mode, dir, rawConfig, resultFile) {
  const config = JSON.parse(rawConfig);
  const chokidar = await import(CHOKIDAR);
  const opts = { useRecursiveWatch: mode === 'recursive', usePolling: mode === 'polling' };
  if (mode === 'polling') opts.interval = 100;

  global.gc();
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const watcher = chokidar.watch(dir, opts);
  let initialEvents = 0;
  const countInitial = () => initialEvents++;
  watcher.on('all', countInitial);
  await new Promise((resolve, reject) => {
    watcher.on('ready', resolve);
    watcher.on('error', reject);
  });
  watcher.off('all', countInitial);
  const readyMs = performance.now() - t0;
  global.gc();
  const rssAfterReady = process.memoryUsage().rss;
  const watches = await inotifyWatchCount();

  // change latency: write existing files one at a time, await 'change'
  const latencies = [];
  const changeWaiters = new Map();
  watcher.on('change', (p) => {
    const w = changeWaiters.get(p);
    if (w) {
      latencies.push(performance.now() - w.t);
      changeWaiters.delete(p);
      w.resolve();
    }
  });
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const p = filePathForIndex(dir, config, (i * 7919) % config.fileCount);
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        changeWaiters.delete(p);
        latencies.push(NaN);
        resolve();
      }, 5000);
      changeWaiters.set(p, {
        t: performance.now(),
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      writeFile(p, `x${i}-${Date.now()}`);
    });
  }
  const okLat = latencies.filter((x) => !Number.isNaN(x));

  // churn: create N new files at once, time until all adds arrive
  const churnDir = dirPathForIndex(dir, config, 0);
  let added = 0;
  let churnDone;
  const churnPromise = new Promise((r) => (churnDone = r));
  watcher.on('add', () => {
    added++;
    if (added >= CHURN_FILES) churnDone();
  });
  const tChurn = performance.now();
  await Promise.all(
    Array.from({ length: CHURN_FILES }, (_, i) => writeFile(sp.join(churnDir, `new${i}.txt`), 'x'))
  );
  const churnTimeout = setTimeout(() => churnDone(), 15000);
  await churnPromise;
  clearTimeout(churnTimeout);
  const churnMs = performance.now() - tChurn;

  const tClose = performance.now();
  await watcher.close();
  const closeMs = performance.now() - tClose;

  const result = {
    fileCount: config.fileCount,
    leafDirs: config.leafDirs,
    topDirs: config.dirsL1,
    mode,
    readyMs: +readyMs.toFixed(1),
    initialEvents,
    rssMB: +((rssAfterReady - rssBefore) / 1048576).toFixed(1),
    inotifyWatches: watches,
    latencyMedianMs: +percentile(okLat, 50).toFixed(2),
    latencyP95Ms: +percentile(okLat, 95).toFixed(2),
    latencyTimeouts: latencies.length - okLat.length,
    churnAddsReceived: added,
    churnMs: +churnMs.toFixed(1),
    closeMs: +closeMs.toFixed(1),
  };
  const line = JSON.stringify(result);
  if (resultFile) await writeFile(resultFile, line);
  process.stdout.write(`${line}\n`);
}

async function buildTree(root, config) {
  for (let dirIndex = 0; dirIndex < config.leafDirs; dirIndex++) {
    const d = dirPathForIndex(root, config, dirIndex);
    await mkdir(d, { recursive: true });
    const firstFile = dirIndex * config.filesPerDir;
    const lastFile = Math.min(config.fileCount, firstFile + config.filesPerDir);
    await Promise.all(
      Array.from({ length: lastFile - firstFile }, (_, offset) =>
        writeFile(sp.join(d, `f${offset}.txt`), 'seed')
      )
    );
  }
}

async function resetChurnDir(root, config) {
  const churnDir = dirPathForIndex(root, config, 0);
  await rm(churnDir, { recursive: true, force: true });
  await mkdir(churnDir, { recursive: true });
  const filesInDir = Math.min(config.fileCount, config.filesPerDir);
  await Promise.all(
    Array.from({ length: filesInDir }, (_, f) => writeFile(sp.join(churnDir, `f${f}.txt`), 'seed'))
  );
}

async function main() {
  const [, , mode, dir, rawConfig, resultFile] = process.argv;
  if (MODES.includes(mode)) return runChild(mode, dir, rawConfig, resultFile);
  if (mode === 'reset') return resetChurnDir(dir, JSON.parse(rawConfig));

  const pexec = promisify(execFile);
  const self = fileURLToPath(import.meta.url);
  const results = [];
  const fileCounts = process.argv.slice(2).map(parseCount);
  const counts = fileCounts.length ? fileCounts : DEFAULT_FILE_COUNTS;
  await mkdir(BENCH_TMPDIR, { recursive: true });
  for (const fileCount of counts) {
    const config = treeConfig(fileCount);
    const root = sp.join(BENCH_TMPDIR, `chokidar-bench-${fileCount}-${Date.now()}`);
    console.error(
      `building tree: ${config.fileCount} files, ${config.leafDirs} leaf dirs, ${config.dirsL1} top dirs in ${root}`
    );
    await buildTree(root, config);
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const order = round % 2 === 0 ? MODES : [...MODES].reverse();
        for (const m of order) {
          await resetChurnDir(root, config);
          const resultFile = sp.join(
            BENCH_TMPDIR,
            `chokidar-bench-result-${process.pid}-${fileCount}-${m}-${round}-${Date.now()}.json`
          );
          await pexec(
            process.execPath,
            ['--expose-gc', self, m, root, JSON.stringify(config), resultFile],
            {
              timeout: 900000,
            }
          );
          const r = JSON.parse(await readFile(resultFile, 'utf8'));
          await rm(resultFile, { force: true });
          r.round = round;
          results.push(r);
          console.error(JSON.stringify(r));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(results, null, 1));
}

await main();
