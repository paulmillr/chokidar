import normalizePath from 'normalize-path';
import path from 'path';
import type {Stats} from 'fs';

export type MatchFunction = (val: string, stats?: Stats) => boolean;
export interface MatcherObject {
  path: string;
  recursive?: boolean;
}
export type Matcher =
  | string
  | RegExp
  | MatchFunction
  | MatcherObject;

function arrify<T>(item: T | T[]): T[] {
  return Array.isArray(item) ? item : [item];
}

export const isMatcherObject = (matcher: Matcher): matcher is MatcherObject =>
    typeof matcher === 'object' &&
      matcher !== null &&
      !(matcher instanceof RegExp);

/**
 * @param {AnymatchPattern} matcher
 * @returns {MatchFunction}
 */
const createPattern = (matcher: Matcher): MatchFunction => {
  if (typeof matcher === 'function') {
    return matcher;
  }
  if (typeof matcher === 'string') {
    return (string) => matcher === string;
  }
  if (matcher instanceof RegExp) {
    return (string) => matcher.test(string);
  }
  if (typeof matcher === 'object' && matcher !== null) {
    return (string) => {
      if (matcher.path === string) {
        return true;
      }
      if (matcher.recursive) {
        const relative = path.relative(matcher.path, string);
        if (!relative) {
          return false;
        }
        return !relative.startsWith('..') && !path.isAbsolute(relative);
      }
      return false;
    };
  }
  return () => false;
};

/**
 * @param {Array<Function>} patterns
 * @param {String|Array} args
 * @param {Boolean} returnIndex
 * @returns {boolean|number}
 */
function matchPatterns(
  patterns: MatchFunction[],
  testString: string,
  stats?: Stats
): boolean {
  const path = normalizePath(testString);

  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path, stats)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {AnymatchMatcher} matchers
 * @param {Array|string} testString
 * @param {object} options
 * @returns {boolean|number|Function}
 */
function anymatch(
  matchers: Matcher[],
  testString: undefined
): MatchFunction;
function anymatch(
  matchers: Matcher[],
  testString: string
): boolean;
function anymatch(
  matchers: Matcher[],
  testString: string|undefined
): boolean|MatchFunction {
  if (matchers == null) {
    throw new TypeError('anymatch: specify first argument');
  }

  // Early cache for matchers.
  const matchersArray = arrify(matchers);
  const patterns = matchersArray
    .map(matcher => createPattern(matcher));

  if (testString == null) {
    return (testString: string, stats?: Stats): boolean => {
      return matchPatterns(patterns, testString, stats);
    };
  }

  return matchPatterns(patterns, testString);
}

export {anymatch};
