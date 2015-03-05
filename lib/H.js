

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
}
module.exports = H;