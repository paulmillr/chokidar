// Benchmark: chokidar per-directory watchers vs useRecursiveWatch
// Run `npm run build` first: this imports the compiled index.js.
// Usage: node benchmark/bench.mjs            (parent: builds tree, spawns one child per mode)
//        node benchmark/bench.mjs <mode> <dir>  (child)
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as sp from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CHOKIDAR = new URL('../index.js', import.meta.url).href;
const DIRS_L1 = 40;
const DIRS_L2 = 50; // 40*50 = 2000 dirs
const FILES_PER_DIR = 10; // 20_000 files
const LATENCY_SAMPLES = 200;
const CHURN_FILES = 500;

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

async function runChild(mode, dir) {
  const chokidar = await import(CHOKIDAR);
  const opts = { useRecursiveWatch: mode === 'recursive', usePolling: mode === 'polling' };
  if (mode === 'polling') opts.interval = 100;

  global.gc();
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const watcher = chokidar.watch(dir, opts);
  let initialEvents = 0;
  watcher.on('all', () => initialEvents++);
  await new Promise((resolve, reject) => {
    watcher.on('ready', resolve);
    watcher.on('error', reject);
  });
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
    const l1 = i % DIRS_L1;
    const l2 = (i * 7) % DIRS_L2;
    const f = (i * 13) % FILES_PER_DIR;
    const p = sp.join(dir, `d${l1}`, `d${l2}`, `f${f}.txt`);
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
  const churnDir = sp.join(dir, 'd0', 'd0');
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

  console.log(
    JSON.stringify({
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
    })
  );
}

async function main() {
  const [, , mode, dir] = process.argv;
  if (mode) return runChild(mode, dir);

  const root = sp.join(tmpdir(), `chokidar-bench-${Date.now()}`);
  console.error(`building tree: ${DIRS_L1 * DIRS_L2} dirs, ${DIRS_L1 * DIRS_L2 * FILES_PER_DIR} files in ${root}`);
  for (let i = 0; i < DIRS_L1; i++) {
    for (let j = 0; j < DIRS_L2; j++) {
      const d = sp.join(root, `d${i}`, `d${j}`);
      await mkdir(d, { recursive: true });
      await Promise.all(
        Array.from({ length: FILES_PER_DIR }, (_, f) => writeFile(sp.join(d, `f${f}.txt`), 'seed'))
      );
    }
  }

  const pexec = promisify(execFile);
  const self = fileURLToPath(import.meta.url);
  const results = [];
  for (const m of ['per-directory', 'recursive']) {
    for (let round = 0; round < 3; round++) {
      // fresh churn dir per run
      await rm(sp.join(root, 'd0', 'd0'), { recursive: true, force: true });
      await mkdir(sp.join(root, 'd0', 'd0'), { recursive: true });
      await Promise.all(
        Array.from({ length: FILES_PER_DIR }, (_, f) =>
          writeFile(sp.join(root, 'd0', 'd0', `f${f}.txt`), 'seed')
        )
      );
      const { stdout } = await pexec(
        process.execPath,
        ['--expose-gc', self, m, root],
        { timeout: 300000 }
      );
      const r = JSON.parse(stdout);
      r.round = round;
      results.push(r);
      console.error(JSON.stringify(r));
    }
  }
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 1));
}

main();
