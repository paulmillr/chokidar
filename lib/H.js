

var
  Path = require('path'),
  AnyMatch = require('anymatch');
class H{
  static OptMissing(Key:String):Boolean{
    return this.options[Key] === undefined;
  }
  static IsntIgnored(Path:String, Stats:Object):Boolean{
    return !this._isIgnored(Path, Stats);
  }
  static EmitReady():void{
    if (++this._readyCalls>= this._readyCount) {
      this._emitReady = Function.prototype;
      // use process.nextTick to allow time for listener to be bound
      process.nextTick(this.emit.bind(this, 'ready'));
    }
  }
  static EmitEvent(Args:Object, Event:String):void{
    this.emit.apply(this, Args);
    if (Event !== 'error') this.emit.apply(this, ['all'].concat(Args));
  }
  static ClearThrottle(Throttled:Object, Timeout:Number, Path:String):void{
    delete Throttled[Path];
    clearTimeout(Timeout);
  }
  static EntryPath(WatchPath:String, Entry:Object):String{
    return Path.join(WatchPath, Path.relative(WatchPath, Entry.fullPath));
  }
  static FilterPath(HasGlob:Boolean, GlobFilter:Function, EntryPath:Function, Entry:Object):String{
    return (!HasGlob || GlobFilter(EntryPath(Entry))) &&
      this._isntIgnored(EntryPath(Entry), Entry.stat);
  }
  static GetDirParts(HasGlob:Boolean, WatchPath:String, EntryPath:String){
    if (!HasGlob) return false;
    return Path.relative(WatchPath, EntryPath).split(/[\/\\]/);
  }
  static FilterDir(HasGlob:Boolean, EntryPath:Function, GetDirParts:Function, DirParts:Object, Entry:Object){
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