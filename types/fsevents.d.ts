declare module 'fsevents' {
  type Event = 'created' | 'cloned' | 'modified' | 'deleted' | 'moved' | 'root-changed' | 'unknown';
  type Type = 'file' | 'directory' | 'symlink';
  type FileChanges = {
    inode: boolean;
    finder: boolean;
    access: boolean;
    xattrs: boolean;
  };
  type Info = {
    event: Event;
    path: string;
    type: Type;
    changes: FileChanges;
    flags: number;
  };
  type WatchHandler = (path: string, flags: number, id: string) => void;
  export function watch(path: string, handler: WatchHandler): () => Promise<void>;
  export function watch(path: string, since: number, handler: WatchHandler): () => Promise<void>;
  export function getInfo(path: string, flags: number): Info;
}
