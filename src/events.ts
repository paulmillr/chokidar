// prettier-ignore
export type EventName = 'all'|'add'|'addDir'|'change'|'unlink'|'unlinkDir'|'raw'|'error'|'ready';

export const ALL: EventName = 'all';
export const READY: EventName = 'ready';
export const ADD: EventName = 'add';
export const CHANGE: EventName = 'change';
export const ADD_DIR: EventName = 'addDir';
export const UNLINK: EventName = 'unlink';
export const UNLINK_DIR: EventName = 'unlinkDir';
export const RAW: EventName = 'raw';
export const ERROR: EventName = 'error';
