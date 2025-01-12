const red = '\x1b[31m';
const green = '\x1b[32m';
const reset = '\x1b[0m';
// We can write 'pending' test name and then overwrite it with actual result by using ${up}.
// However, if test prints something to STDOUT, last line would get removed.
// We can wrap process.stdout also, but in that case there can be issues with non-node.js env.
// But we already use node modules for parallel cases, so maybe worth investigating.
const up = '\x1b[A';

const LEAF_N = '├─';
const LEAF_E = '│ ';
const LEAF_L = '└─';
const LEAF_S = '  ';
// With padding
// const LEAF_N = '├─ ';
// const LEAF_E = '│  ';
// const LEAF_L = '└─ ';
// const LEAF_S = '   ';

let consuming = false;
let only;

async function runTest(info, printTree = false, multiLine = false, stopAtError = true) {
  if (!printTree && multiLine) console.log();
  let output = info.message;
  if (printTree && info.only) {
    for (const parent of info.path) console.log(`${parent.prefix}${parent.message}`);
  }

  const path = `${info.path.map((i) => i.message).join('/')}/`;

  // Skip is always single-line
  if (multiLine && !info.skip) {
    console.log(printTree ? `${info.prefix}${output}: ☆` : `☆ ${path}${output}:`);
  } else if (info.skip) {
    console.log(printTree ? `${info.prefix}${output} (skip)` : `☆ ${path}${output} (skip)`);
    return true;
  }
  const printResult = (color, symbol) =>
    console.log(
      printTree
        ? `${info.childPrefix}${color}${output}: ${symbol}${reset}`
        : `${color}${symbol} ${path}${output}${reset}`
    );
  try {
    // Run beforeEach hooks from parent contexts
    for (const parent of info.path) {
      if (parent.beforeEach) {
        try {
          await parent.beforeEach();
        } catch (error) {
          printResult(red, '☓');
          console.log(`${red}beforeEach ERROR:${reset}`, error);
          if (stopAtError) throw error;
          return false;
        }
      }
    }

    let result = await info.test();

    // Run afterEach hooks from parent contexts (in reverse order)
    for (const parent of [...info.path].reverse()) {
      if (parent.afterEach) {
        try {
          await parent.afterEach();
        } catch (error) {
          printResult(red, '☓');
          console.log(`${red}afterEach ERROR:${reset}`, error);
          if (stopAtError) throw error;
          return false;
        }
      }
    }

    printResult(green, '✓');
    return true;
  } catch (error) {
    printResult(red, '☓');
    if (stopAtError) throw error;
    else console.log(`${red}ERROR:${reset}`, error);
  }
}

async function runParallel(tasks, cb) {
  // node.js / common.js-only
  const { cpus } = require('node:os');
  const cluster = require('node:cluster');

  tasks = tasks.filter((i) => !!i.test); // Filter describe elements

  const clusterId = cluster && cluster.worker ? `W${cluster.worker.id}` : 'M';
  const WORKERS = Number.parseInt(process.env.WORKERS, 10) || cpus().length;
  // Workers
  if (!cluster.isMaster) {
    process.on('error', (err) => console.log('Error (child crashed?):', err));
    let tasksDone = 0;
    for (let i = 0; i < tasks.length; i++) {
      if (cluster.worker.id - 1 !== i % WORKERS) continue;
      await cb(tasks[i], false, false);
      tasksDone++;
    }
    process.send({ name: 'parallelTests', worker: clusterId, tasksDone });
    process.exit();
  }
  // Master
  return await new Promise((resolve, reject) => {
    console.log(`Starting parallel tests with ${WORKERS} workers and ${tasks.length} tasks`);
    cluster.on('exit', (worker, code) => {
      if (!code) return;
      console.error(
        `${red}Worker W${worker.id} (pid: ${worker.process.pid}) died with code: ${code}${reset}`
      );
      reject(new Error('Test worker died in agony'));
    });
    let tasksDone = 0;
    let workersDone = 0;
    for (let i = 0; i < WORKERS; i++) {
      const worker = cluster.fork();
      worker.on('error', (err) => reject(err));
      worker.on('message', (msg) => {
        if (!msg || msg.name !== 'parallelTests') return;
        workersDone++;
        tasksDone += msg.tasksDone;
        if (workersDone === WORKERS) {
          if (tasksDone !== tasks.length) reject(new Error('Not all tasks finished.'));
          else resolve(tasksDone);
        }
      });
    }
  });
}

const stack = [{ children: [] }];

const stackTop = () => stack[stack.length - 1];
const stackPop = () => stack.pop();
const stackClean = () => {
  stack.splice(0, stack.length);
  stack.push({ children: [] });
};
const stackAdd = (info) => {
  const c = { ...info, children: [] };
  stackTop().children.push(c);
  stack.push(c);
};

function formatPrefix(depth, prefix, isLast) {
  if (depth === 0) return { prefix: '', childPrefix: '' };
  return {
    prefix: `${prefix}${isLast ? LEAF_L : LEAF_N}`,
    childPrefix: `${prefix}${isLast ? LEAF_S : LEAF_E}`,
  };
}

function stackFlatten(elm) {
  const out = [];
  const walk = (elm, depth = 0, isLast = false, prevPrefix = '', path = []) => {
    const { prefix, childPrefix } = formatPrefix(depth, prevPrefix, isLast);
    const newElm = { ...elm, prefix, childPrefix, path };
    out.push(newElm);
    path = path.concat([newElm]); // Save prefixes so we can print path in 'only' case

    for (let i = 0; i < elm.children.length; i++)
      walk(elm.children[i], depth + 1, i === elm.children.length - 1, childPrefix, path);
  };
  // Skip root
  for (const child of elm.children) walk(child);
  return out;
}

function describe(message, fn) {
  stackAdd({ message });
  fn(); // Run function in the context of current stack path
  stackPop();
}
describe.skip = (message, fn) => {
  stackAdd({ message, skip: true })
  // fn();
  stackPop();
}

function beforeEach(fn) {
  stackTop().beforeEach = fn;
}

function afterEach(fn) {
  stackTop().afterEach = fn;
}

function enqueue(info) {
  stackAdd(info);
  stackPop(); // remove from stack since there are no children
}

function runTests() {
  if (consuming) throw new Error('should.run() has already been called');
  consuming = true;
  const start = Date.now();
  const items = should.consumeQueue();
  const total = items.length;
  // Return promise, so we can wait before section is complete without breaking anything
  return (async () => {
    for (const test of items) {
      if (should.PRINT_TREE && !test.test) console.log(`${test.prefix}${test.message}`);
      if (!test.test) continue;
      await runTest(test, should.PRINT_TREE, should.PRINT_MULTILINE, should.STOP_AT_ERROR);
    }
    const diff = Math.round((Date.now() - start) / 1000);
    const fdiff = diff > 60 ? `${Math.floor(diff / 60)} min ${diff % 60} sec` : `${diff} sec`
    console.log(`${green}${total}${reset} tests passed in ${fdiff}`);
    consuming = false;
    // console.log(green, total.toString(), reset, 'tests passed in', .toString(), 'seconds');
  })();
}

const should = (message, test) => enqueue({ message, test });
should.stack = stack;
should.queue = () => stackFlatten(stack[0]);
should.consumeQueue = () => {
  let items = should.queue().slice();
  if (only) items = items.filter((i) => i.test === only.test);
  stackClean(); // Remove all elements, so next call won't process them twice
  only = undefined;
  return items;
};
should.only = (message, test) => enqueue((only = { message, test, only: true }));
should.skip = (message, test) => enqueue({ message, test, skip: true });
should.PRINT_TREE = true;
should.PRINT_MULTILINE = true;
should.STOP_AT_ERROR = true;
should.run = runTests;
// Doesn't support tree and multiline
should.runParallel = () =>
  runParallel(should.consumeQueue(), (info) => runTest(info, false, false, should.STOP_AT_ERROR));

export { should, should as it, describe, beforeEach, afterEach };
export default should;
