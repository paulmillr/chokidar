import type { Stats, WatchEventType } from 'node:fs';
import { type as osType } from 'node:os';
import * as sp from 'node:path';
import type { EntryInfo } from 'readdirp';

const platform = process.platform;

export const isWindows: boolean = platform === 'win32';
export const isMacos: boolean = platform === 'darwin';
export const isLinux: boolean = platform === 'linux';
export const isFreeBSD: boolean = platform === 'freebsd';
export const isIBMi: boolean = osType() === 'OS400';

export type ErrorClass = 'missing' | 'permission' | 'recursive-unsupported' | 'other';

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function classifyError(error: unknown): ErrorClass {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (code === 'EPERM' || code === 'EACCES') return 'permission';
  if (code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') return 'recursive-unsupported';
  return 'other';
}

export function isMissingError(error: unknown): boolean {
  return classifyError(error) === 'missing';
}
export function isPermissionError(error: unknown): boolean {
  return classifyError(error) === 'permission';
}
export function isRecursiveWatchUnsupported(error: unknown): boolean {
  return classifyError(error) === 'recursive-unsupported';
}

export interface SchedulerTimer {
  ref(): SchedulerTimer;
  unref(): SchedulerTimer;
}

export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, delay: number): SchedulerTimer;
  clearTimeout(timer: SchedulerTimer | undefined): void;
}

export const systemScheduler: Scheduler = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  clearTimeout: (timer: SchedulerTimer | undefined) => {
    if (timer) clearTimeout(timer as NodeJS.Timeout);
  },
});

export type Path = string;
export type LogicalPathKey = string & { readonly __logicalPathKey: unique symbol };
export type BackendResourceKey = string & { readonly __backendResourceKey: unique symbol };

export const EVENTS = {
  ALL: 'all',
  READY: 'ready',
  ADD: 'add',
  CHANGE: 'change',
  ADD_DIR: 'addDir',
  UNLINK: 'unlink',
  UNLINK_DIR: 'unlinkDir',
  RAW: 'raw',
  ERROR: 'error',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export type NativeTrigger = {
  kind: 'native';
  resource: BackendResourceKey;
  rawEvent: WatchEventType;
  relativePath: string | null;
  sequence: number;
  observedAt: number;
};
export type MissingPollObservation = { missing: true };
export type PollObservation = Stats | MissingPollObservation;
export type PollTrigger = {
  kind: 'poll';
  resource: BackendResourceKey;
  current: PollObservation;
  previous?: PollObservation;
  sequence: number;
  observedAt: number;
};
export type BackendTrigger = NativeTrigger | PollTrigger;
export interface BackendSubscription {
  readonly resource: BackendResourceKey;
  close(): void | Promise<void>;
}
export interface WatchHandlers {
  errHandler: (err: unknown) => void;
  rawEmitter: (ev: WatchEventType, path: string | null, opts: unknown) => void;
}

export type AWF = { stabilityThreshold: number; pollInterval: number };
export type WatchBackend = 'auto' | 'native' | 'native-recursive' | 'polling';
export type BackendStrategy = 'polling' | 'native-per-directory' | 'native-recursive-preferred';
export type MatcherObject = { path: string; recursive?: boolean };
export type MatchFunction = (val: string, stats?: Stats) => boolean;
export type Matcher = string | RegExp | MatchFunction | MatcherObject;
type BasicOptions = {
  persistent: boolean;
  ignoreInitial: boolean;
  followSymlinks: boolean;
  cwd?: string;
  backend: WatchBackend;
  /** @deprecated Use `backend: 'polling'` instead. */
  usePolling: boolean;
  pollingInterval: number;
  pollingBinaryInterval: number;
  /** @deprecated Use `pollingInterval` instead. */
  interval: number;
  /** @deprecated Use `pollingBinaryInterval` instead. */
  binaryInterval: number;
  alwaysStat?: boolean;
  depth?: number;
  ignorePermissionErrors: boolean;
  atomic: boolean | number;
};
export type ChokidarOptions = Partial<
  BasicOptions & { ignored: Matcher | Matcher[]; awaitWriteFinish: boolean | Partial<AWF> }
>;
export type FSWInstanceOptions = BasicOptions & {
  ignored: readonly Matcher[];
  awaitWriteFinish: false | AWF;
  backendStrategy: BackendStrategy;
  backendCapabilities: import('./backend.js').BackendCapabilities;
};
export type ThrottleType = 'readdir' | 'watch' | 'add' | 'remove' | 'change';
export type Throttler = {
  timeoutObject: SchedulerTimer;
  clear: (invokeRelease?: boolean) => number;
  count: number;
};
export type EmitArgs = [path: Path, stats?: Stats];
export type EmitErrorArgs = [error: Error, stats?: Stats];
export type EmitArgsWithName = [event: EventName, ...EmitArgs];
const BACK_SLASH_RE = /\\/g;
const DOUBLE_SLASH_RE = /\/\//g;
export function normalizePath(path: Path): Path {
  if (typeof path !== 'string') throw new TypeError('string expected');
  const unix = path.replace(BACK_SLASH_RE, '/');
  const unc = unix.startsWith('//');
  let normalized = sp.normalize(unix).replace(BACK_SLASH_RE, '/').replace(DOUBLE_SLASH_RE, '/');
  if (unc && !normalized.startsWith('//')) normalized = `/${normalized}`;
  return normalized;
}
export function logicalPathKey(path: Path): LogicalPathKey {
  const resolved = sp.resolve(path);
  return (
    isWindows || !resolved.includes('\\')
      ? resolved.replace(BACK_SLASH_RE, '/')
      : normalizePath(resolved)
  ) as LogicalPathKey;
}
function isInsideRelativePath(relative: string): boolean {
  return relative !== '..' && !relative.startsWith(`..${sp.sep}`) && !sp.isAbsolute(relative);
}
export function isSameOrInside(root: Path, candidate: Path): boolean {
  const relative = sp.relative(root, candidate);
  return relative === '' || isInsideRelativePath(relative);
}
export function isStrictlyInside(root: Path, candidate: Path): boolean {
  const relative = sp.relative(root, candidate);
  return relative !== '' && isInsideRelativePath(relative);
}
export function isMatcherObject(matcher: Matcher): matcher is MatcherObject {
  return typeof matcher === 'object' && matcher !== null && !(matcher instanceof RegExp);
}
export function cloneOwnedMatcher(matcher: Matcher): Matcher {
  if (matcher instanceof RegExp) return new RegExp(matcher.source, matcher.flags);
  if (isMatcherObject(matcher)) return Object.freeze({ ...matcher });
  return matcher;
}
function compileMatcher(matcher: Matcher): MatchFunction {
  if (typeof matcher === 'function') return matcher;
  if (typeof matcher === 'string') return (candidate) => matcher === candidate;
  if (matcher instanceof RegExp) {
    return (candidate) => {
      matcher.lastIndex = 0;
      return matcher.test(candidate);
    };
  }
  if (isMatcherObject(matcher)) {
    return (candidate) =>
      matcher.path === candidate ||
      Boolean(matcher.recursive && isStrictlyInside(matcher.path, candidate));
  }
  return () => false;
}
export function compileMatchers(matchers: readonly Matcher[]): MatchFunction {
  const patterns = matchers.map(compileMatcher);
  return (candidate: string, stats?: Stats): boolean => {
    if (patterns.length === 0) return false;
    const normalized = normalizePath(candidate);
    return patterns.some((pattern) => pattern(normalized, stats));
  };
}
export function normalizeMatcher(matcher: Matcher, cwd: string = process.cwd()): Matcher {
  if (typeof matcher === 'string') {
    return normalizePath(sp.isAbsolute(matcher) ? matcher : sp.join(cwd, matcher));
  }
  if (isMatcherObject(matcher)) {
    return {
      path: normalizePath(sp.isAbsolute(matcher.path) ? matcher.path : sp.join(cwd, matcher.path)),
      recursive: matcher.recursive,
    };
  }
  return matcher;
}

const REPLACER_RE = /^\.[/\\]/;
export type WatchHelperContext = {
  capturePathGeneration: () => number;
  isntIgnored: (path: Path, stats?: EntryInfo['stats']) => boolean;
};
/** Temporary traversal scope; replaced by the observation engine's root scope. */
export class WatchHelper {
  watchPath: string;
  followSymlinks: boolean;
  recursiveRoot?: string;
  recursiveDisabled?: boolean;
  observationTrigger?: NativeTrigger;
  realpathAncestry: Set<string>;
  pathGeneration: number;
  private readonly context: WatchHelperContext;

  constructor(path: string, follow: boolean, context: WatchHelperContext) {
    this.context = context;
    this.watchPath = path.replace(REPLACER_RE, '');
    this.followSymlinks = follow;
    this.realpathAncestry = new Set();
    this.pathGeneration = context.capturePathGeneration();
  }
  fork(path: string): WatchHelper {
    const helper = new WatchHelper(path, this.followSymlinks, this.context);
    helper.filterPath = (entry) => this.filterPath(entry);
    helper.filterDir = (entry) => this.filterDir(entry);
    helper.recursiveRoot = this.recursiveRoot;
    helper.recursiveDisabled = this.recursiveDisabled;
    helper.observationTrigger = this.observationTrigger;
    helper.realpathAncestry = new Set(this.realpathAncestry);
    helper.pathGeneration = this.pathGeneration;
    return helper;
  }
  withObservation(trigger: NativeTrigger): WatchHelper {
    const helper = Object.create(this) as WatchHelper;
    helper.observationTrigger = trigger;
    return helper;
  }
  filterPath(entry: EntryInfo): boolean {
    return entry.stats?.isSymbolicLink()
      ? this.filterDir(entry)
      : this.context.isntIgnored(sp.join(this.watchPath, entry.path), entry.stats);
  }
  filterDir(entry: EntryInfo): boolean {
    return this.context.isntIgnored(sp.join(this.watchPath, entry.path), entry.stats);
  }
}
