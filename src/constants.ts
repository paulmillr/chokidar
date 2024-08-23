import { type as osType } from 'os';

export type Path = string;

export const STR_DATA = 'data';
export const STR_END = 'end';
export const STR_CLOSE = 'close';
export const EMPTY_FN = () => {};
export const IDENTITY_FN = (val: any) => val;

const p = process.platform;
export const isWindows = p === 'win32';
export const isMacos = p === 'darwin';
export const isLinux = p === 'linux';
export const isIBMi = osType() === 'OS400';
