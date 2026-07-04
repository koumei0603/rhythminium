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

  setTapVolume(v01) {
    this.tapVol = v01;
  }

  setTapSound(name) {
    this.tapSound = name;
  }

  // ---- タップ効果音（全レーン同じ音。音色は設定で選択） ----
  _noiseBuffer() {
    if (!this._noise) {
      const len = Math.floor(this.ctx.sampleRate * 0.12);
      this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this._noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._noise;
  }

  // 減衰エンベロープ付きゲインを作って destination へ
  _env(t, vol, dur) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.ctx.destination); // BGM音量とは独立
    return g;
  }

  _tone(type, freq, g, t, dur, glideTo) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur * 0.7);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  _noiseHit(g, t, dur, filterType, filterFreq) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = filterFreq;
    src.connect(f);
    f.connect(g);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  tap() {
    if (!this.tapVol || this.tapVol <= 0 || this.tapSound === 'none') return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    const v = this.tapVol;
    switch (this.tapSound) {
      case 'taiko': { // 太鼓: 低い皮の音＋アタックのノイズ
        const g = this._env(t, v * 1.2, 0.26);
        this._tone('sine', 160, g, t, 0.26, 55);
        const g2 = this._env(t, v * 0.5, 0.05);
        this._noiseHit(g2, t, 0.05, 'lowpass', 500);
        break;
      }
      case 'pok': { // ポク（木魚風）: 乾いた短い音
        const g = this._env(t, v, 0.07);
        this._tone('sine', 830, g, t, 0.07, 620);
        const g2 = this._env(t, v * 0.6, 0.03);
        this._noiseHit(g2, t, 0.03, 'bandpass', 1900);
        break;
      }
      case 'drop': { // 水滴: 高い音がすっと落ちる
        const g = this._env(t, v * 0.9, 0.16);
        this._tone('sine', 1050, g, t, 0.16, 260);
        break;
      }
      case 'beep': { // 電子音: レトロゲームのピッ
        const g = this._env(t, v * 0.55, 0.09);
        this._tone('square', 880, g, t, 0.09, 760);
        break;
      }
      case 'bell': { // ベル: 澄んだ余韻（非整数倍音）
        const g = this._env(t, v * 0.6, 0.45);
        this._tone('sine', 660, g, t, 0.45);
        const g2 = this._env(t, v * 0.2, 0.3);
        this._tone('sine', 660 * 2.4, g2, t, 0.3);
        const g3 = this._env(t, v * 0.1, 0.2);
        this._tone('sine', 660 * 3.9, g3, t, 0.2);
        break;
      }
      case 'click': { // クリック: ごく短いカチッ
        const g = this._env(t, v * 0.9, 0.025);
        this._noiseHit(g, t, 0.025, 'highpass', 2500);
        break;
      }
      default: { // piano: やわらかい単音（音程は固定）
        const g = this._env(t, v, 0.22);
        this._tone('sine', 440, g, t, 0.22);
        const g2 = this._env(t, v * 0.3, 0.16);
        this._tone('triangle', 880, g2, t, 0.16);
      }
    }
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
