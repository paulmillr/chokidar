#!/usr/bin/env node

var childProcess = require('child_process');
var Promise = require('bluebird');
var _ = require('lodash');
var minimatch = require('minimatch')
var chokidar = require('../index');

var defaultOpts = {
    debounce: 400,
    followSymlinks: false,
    ignore: null,
    polling: false,
    pollInterval: 100,
    pollIntervalBinary: 300
};

var argv = require('yargs')
    .usage(
        'Usage: $0 <command> <pattern> [options]\n\n' +
        '<command>:\n' +
        'Command to be executed when a change is detected.\n' +
        'Needs to be surrounded with quotes when command contains spaces\n\n'+
        '<pattern>:\n' +
        'Glob pattern to specify files to be watched.\n' +
        'Needs to be surrounded with quotes to prevent shell globbing.\n' +
        'Guide to globs: https://github.com/isaacs/node-glob#glob-primer'
    )
    .example('$0 "npm run build-js" "**/*.js"', 'build when any .js file changes')
    .demand(2)
    .option('d', {
        alias: 'debounce',
        default: defaultOpts.debounce,
        describe: 'Debounce timeout in ms for executing command',
        type: 'number'
    })
    .option('s', {
        alias: 'follow-symlinks',
        default: defaultOpts.followSymlinks,
        describe: 'When not set, only the symlinks themselves will be watched ' +
                  'for changes instead of following the link references and ' +
                  'bubbling events through the links path',
        type: 'boolean'
    })
    .option('i', {
        alias: 'ignore',
        describe: 'Pattern for files which should be ignored. ' +
                  'Needs to be surrounded with quotes to prevent shell globbing. ' +
                  'The whole relative or absolute path is tested, not just filename'
    })
    .option('p', {
        alias: 'polling',
        describe: 'Whether to use fs.watchFile(backed by polling) instead of ' +
                  'fs.watch. This might lead to high CPU utilization. ' +
                  'It is typically necessary to set this to true to ' +
                  'successfully watch files over a network, and it may be ' +
                  'necessary to successfully watch files in other ' +
                  'non-standard situations',
        default: defaultOpts.polling,
        type: 'boolean'
    })
    .option('poll-interval', {
        describe: 'Interval of file system polling. Effective when --polling ' +
                  'is set',
        default: defaultOpts.pollInterval,
        type: 'number'
    })
    .option('poll-interval-binary', {
        describe: 'Interval of file system polling for binary files. ' +
                  'Effective when --polling is set',
        default: defaultOpts.pollIntervalBinary,
        type: 'number'
    })
    .help('h')
    .alias('h', 'help')
    .alias('v', 'version')
    .version(require('../package.json').version)
    .argv;


function main() {
    var userOpts = getUserOpts(argv);

    var opts = _.merge(defaultOpts, userOpts);
    startWatching(opts);
}

function getUserOpts(argv) {
    return {
        command: argv._[0],
        pattern: argv._[1],
        debounce: argv.debounce,
        followSymlinks: argv.followSymlinks,
        ignore: argv.ignore,
        polling: argv.polling,
        pollInterval: argv.pollInterval,
        pollIntervalBinary: argv.pollIntervalBinary
    };
}

// Estimates spent working hours based on commit dates
function startWatching(opts) {
    var chokidarOpts = createChokidarOpts(opts);
    var watcher = chokidar.watch(opts.pattern, chokidarOpts);

    var debouncedRun = _.debounce(run, opts.debounce);
    watcher.on('change', function(path, stats) {
        // TODO: commands might be run concurrently
        debouncedRun(opts.command);
    });

    watcher.on('error', function(error) {
        console.error('Error:', error);
        console.error(error.stack);
    });

    watcher.on('ready', function() {
        console.log('Watching', '"' + opts.pattern + '" ..');
    });
}

function createChokidarOpts(opts) {
    var chokidarOpts = {
        followSymlinks: opts.followSymlinks,
        usePolling: opts.polling,
        interval: opts.pollInterval,
        binaryInterval: opts.pollIntervalBinary
    };
    if (opts.ignore) chokidarOpts.ignore = opts.ignore;

    return chokidarOpts;
}

function run(cmd) {
    var child;
    var parts = cmd.split(' ');
    try {
        child = childProcess.spawn(_.head(parts), _.tail(parts));
    } catch (e) {
        return Promise.reject(e);
    }

    // TODO: Is there a chance of locking/waiting forever?
    child.stdin.pipe(process.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    return new Promise(function(resolve, reject) {
        child.on('error', function(err) {
            console.error('Error when executing', cmd);
            console.error(err.stack);
            reject(err);
        });

        child.on('close', function(exitCode) {
            resolve(exitCode);
        });
    });
}

main();
