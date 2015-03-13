

var
  Path = require('path'),
  AnyMatch = require('anymatch');
class H{
  static OptMissing(Key){
    return this.options[Key] === undefined;
  }
  static IsntIgnored(Path, Stats){
    return !this._isIgnored(Path, Stats);
  }
  static EmitReady():void{
    if (++this._readyCalls>= this._readyCount) {
      this._emitReady = Function.prototype;
      // use process.nextTick to allow time for listener to be bound
      process.nextTick(this.emit.bind(this, 'ready'));
    }
  }
  static EmitEvent(Args, Event){
    this.emit.apply(this, Args);
    if (Event !== 'error') this.emit.apply(this, ['all'].concat(Args));
  }
  static ClearThrottle(Throttled, Timeout, Path):void{
    delete Throttled[Path];
    clearTimeout(Timeout);
  }
  static EntryPath(WatchPath, Entry):String{
    return Path.join(WatchPath, Path.relative(WatchPath, Entry.fullPath));
  }
  static FilterPath(HasGlob, GlobFilter, EntryPath, Entry){
    return (!HasGlob || GlobFilter(EntryPath(Entry))) &&
      this._isntIgnored(EntryPath(Entry), Entry.stat);
  }
  static GetDirParts(HasGlob, WatchPath, EntryPath){
    if (!HasGlob) return false;
    return Path.relative(WatchPath, EntryPath).split(/[\/\\]/);
  }
  static FilterDir(HasGlob, EntryPath, GetDirParts, DirParts, Entry){
    var unmatchedGlob;
    if (HasGlob) {
      var entryParts = GetDirParts(Entry.fullPath);
      unmatchedGlob = !DirParts.every(function(part, i) {
        return !entryParts[i] || AnyMatch(part, entryParts[i]);
      });
    }

    return !unmatchedGlob && this._isntIgnored(EntryPath(Entry), Entry.stat);
  }
}
module.exports = H;