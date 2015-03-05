

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
}
module.exports = H;