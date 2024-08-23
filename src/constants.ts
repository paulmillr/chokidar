import { type as osType } from 'os';

export type Path = string;

export const STR_DATA = 'data';
export const STR_END = 'end';
export const STR_CLOSE = 'close';

export const KEY_LISTENERS = 'listeners';
export const KEY_ERR = 'errHandlers';
export const KEY_RAW = 'rawEmitters';
export const HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR, KEY_RAW];

export const BACK_SLASH_RE = /\\/g;
export const DOUBLE_SLASH_RE = /\/\//;
export const SLASH_OR_BACK_SLASH_RE = /[/\\]/;
export const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
export const REPLACER_RE = /^\.[/\\]/;

export const SLASH = '/';
export const SLASH_SLASH = '//';
export const ONE_DOT = '.';
export const TWO_DOTS = '..';
export const STRING_TYPE = 'string';
export const EMPTY_FN = () => {};
export const IDENTITY_FN = (val: any) => val;

const p = process.platform;
export const isWindows = p === 'win32';
export const isMacos = p === 'darwin';
export const isLinux = p === 'linux';
export const isIBMi = osType() === 'OS400';
