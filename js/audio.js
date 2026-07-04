// Web Audio APIによる曲のデコード・再生・時刻同期
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gain = null;
    this.startAt = 0; // 再生開始時のctx.currentTime
    this.startOffset = 0; // 再生開始時の曲内位置
    this.rate = 1; // 再生速度（エディタのスロー再生用）
    this.pausedAt = 0;
    this.playing = false;
    this.onended = null;
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async load(arrayBuffer) {
    this.ensureCtx();
    this.stop();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.pausedAt = 0;
    return this.buffer;
  }

  setVolume(v01) {
    if (this.gain) this.gain.gain.value = v01;
  }

  // offset秒から再生。leadIn秒だけ待ってから曲が始まる（負のoffset相当）
  play(offset = 0, leadIn = 0) {
    this.ensureCtx();
    this.stopSource();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = this.rate;
    this.source.connect(this.gain);
    const when = this.ctx.currentTime + leadIn;
    this.source.start(when, Math.max(0, offset));
    this.startAt = when;
    this.startOffset = Math.max(0, offset);
    this.playing = true;
    this.source.onended = () => {
      if (this.playing) {
        this.playing = false;
        if (this.onended) this.onended();
      }
    };
  }

  // 再生速度の変更（再生中でも位置を保ったまま切替できる）
  setRate(r) {
    if (this.playing && this.source) {
      this.startOffset = this.time();
      this.startAt = this.ctx.currentTime;
      this.source.playbackRate.value = r;
    }
    this.rate = r;
  }

  // 現在の曲内時刻（秒）。リードイン中は負の値
  time() {
    if (!this.playing) return this.pausedAt;
    return this.startOffset + (this.ctx.currentTime - this.startAt) * this.rate;
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.time();
    this.stopSource();
  }

  resume(leadIn = 0.5) {
    this.play(this.pausedAt, leadIn);
  }

  stopSource() {
    this.playing = false;
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch {}
      this.source = null;
    }
  }

  stop() {
    this.stopSource();
    this.pausedAt = 0;
  }

  duration() {
    return this.buffer ? this.buffer.duration : 0;
  }
}

window.audioEngine = new AudioEngine();
