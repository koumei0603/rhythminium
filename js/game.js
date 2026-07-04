// プレイ画面: 遠近法（奥から手前へ）ノーツ描画・判定・スコア
(function () {
  const LANES = 7;
  const KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'];
  const KEY_LABELS = ['A', 'S', 'D', 'F', 'J', 'K', 'L'];
  const CHARMING = 0.08; // 秒
  const FINE = 0.15;
  const LEAD_IN = 2.0;

  // 遠近パラメータ: ノーツは奥(zFar)から手前(zNear)へ等速で進む
  const Z_NEAR = 1.0;
  const Z_FAR = 3.6;

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const hudPct = document.getElementById('hud-pct');
  const hudCombo = document.getElementById('hud-combo');

  let st = null; // 進行中のゲーム状態
  let raf = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => { if (st) resize(); });

  function fallSeconds() {
    // 速度1(遅い)〜9(速い)
    return 3.9 - 0.35 * window.Settings.data.speed;
  }

  function start({ title, chart, onFinish, onPause }) {
    resize();
    st = {
      title,
      notes: chart.notes.map((n) => ({ t: n.t, lane: n.lane, judged: null })),
      total: chart.notes.length,
      duration: chart.duration,
      charming: 0, fine: 0, miss: 0,
      combo: 0, maxCombo: 0, earned: 0,
      effects: [], laneFlash: new Array(LANES).fill(0),
      onFinish, onPause,
      paused: false, finished: false,
    };
    hudPct.textContent = '0.00 %';
    hudCombo.textContent = '';
    window.audioEngine.setVolume(window.Settings.data.volume / 10);
    window.audioEngine.setRate(1); // プレイは常に等速（エディタのスロー設定を引き継がない）
    window.audioEngine.play(0, LEAD_IN);
    window.audioEngine.onended = () => { if (st && !st.paused) setTimeout(tryFinish, 600); };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function tryFinish() {
    if (!st || st.finished) return;
    st.finished = true;
    cancelAnimationFrame(raf);
    const r = {
      pct: st.total ? (st.earned / st.total) * 100 : 0,
      charming: st.charming, fine: st.fine, miss: st.miss,
      maxCombo: st.maxCombo, total: st.total,
    };
    const cb = st.onFinish;
    st = null;
    cb(r);
  }

  function judge(lane) {
    if (!st || st.paused) return;
    const now = window.audioEngine.time();
    st.laneFlash[lane] = 1;
    let best = null, bestDt = Infinity;
    for (const n of st.notes) {
      if (n.judged || n.lane !== lane) continue;
      const dt = n.t - now;
      if (dt > FINE) break; // notesはt順: 以降は全て未来
      const adt = Math.abs(dt);
      if (adt <= FINE && adt < bestDt) { best = n; bestDt = adt; }
    }
    if (!best) return;
    if (bestDt <= CHARMING) { best.judged = 'charming'; st.charming++; st.earned += 1; }
    else { best.judged = 'fine'; st.fine++; st.earned += 0.5; }
    st.combo++;
    st.maxCombo = Math.max(st.maxCombo, st.combo);
    st.effects.push({ kind: best.judged, lane, t0: performance.now() });
    updateHud();
  }

  function updateHud() {
    hudPct.textContent = ((st.earned / st.total) * 100).toFixed(2) + ' %';
    hudCombo.textContent = st.combo >= 5 ? st.combo + ' COMBO' : '';
  }

  function loop() {
    if (!st || st.paused) return;
    const now = window.audioEngine.time();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const horizonY = h * 0.14;
    const lineY = h * 0.8;
    const cx = w / 2;
    const laneW = w / LANES;
    const fall = fallSeconds();

    // 遠近投影: p=0(奥・出現) → p=1(判定ライン)
    const proj = (p, lane) => {
      const z = Z_NEAR + (1 - p) * (Z_FAR - Z_NEAR);
      const s = Z_NEAR / z; // 大きさ・横位置のスケール
      const f = (1 / z - 1 / Z_FAR) / (1 / Z_NEAR - 1 / Z_FAR); // 画面上の進行率
      return {
        x: cx + (lane - (LANES - 1) / 2) * laneW * s,
        y: horizonY + (lineY - horizonY) * f,
        s,
      };
    };

    // ミス確定
    for (const n of st.notes) {
      if (!n.judged && now - n.t > FINE) {
        n.judged = 'miss';
        st.miss++;
        st.combo = 0;
        st.effects.push({ kind: 'miss', lane: n.lane, t0: performance.now() });
        updateHud();
      }
    }

    // ---- 背景 ----
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    // 奥（消失点付近）のかすかな光
    const glow = ctx.createRadialGradient(cx, horizonY, 0, cx, horizonY, h * 0.55);
    glow.addColorStop(0, 'rgba(90,84,70,0.20)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    // 手前に向かう床明かり
    const bg = ctx.createLinearGradient(0, horizonY, 0, lineY);
    bg.addColorStop(0, 'rgba(0,0,0,0)');
    bg.addColorStop(0.75, 'rgba(35,32,26,0.35)');
    bg.addColorStop(1, 'rgba(74,69,58,0.85)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, horizonY, w, lineY - horizonY);

    // 五線譜と曲名の透かし（DEEMO風の背景装飾）
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = '#cfc7b5';
    ctx.lineWidth = 1;
    const staffC = h * 0.46;
    for (let i = -2; i <= 2; i++) {
      const sy = staffC + i * h * 0.022;
      const sw = w * (0.30 + 0.09 * (i + 2)); // 下の線ほど広く（奥行き感）
      ctx.beginPath();
      ctx.moveTo(cx - sw / 2, sy);
      ctx.lineTo(cx + sw / 2, sy);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.06;
    ctx.font = `italic ${Math.floor(h * 0.085)}px Georgia`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#cfc7b5';
    ctx.fillText(st.title, cx, staffC + h * 0.028);
    ctx.restore();

    // レーンガイド（消失点から手前へ広がる線）
    ctx.strokeStyle = 'rgba(180,172,150,0.10)';
    ctx.lineWidth = 1;
    for (let l = 0; l <= LANES; l++) {
      const xNear = l * laneW;
      const xFar = cx + (xNear - cx) * (Z_NEAR / Z_FAR);
      ctx.beginPath();
      ctx.moveTo(xFar, horizonY);
      ctx.lineTo(xNear, lineY);
      ctx.stroke();
    }

    // キー押下フラッシュ（レーンの台形を光らせる）
    for (let l = 0; l < LANES; l++) {
      if (st.laneFlash[l] > 0.01) {
        const a = proj(1, l - 0.5 + 0.5); // ライン上のレーン中心
        const xN0 = l * laneW, xN1 = (l + 1) * laneW;
        const xF0 = cx + (xN0 - cx) * (Z_NEAR / Z_FAR);
        const xF1 = cx + (xN1 - cx) * (Z_NEAR / Z_FAR);
        ctx.fillStyle = `rgba(255,250,230,${st.laneFlash[l] * 0.16})`;
        ctx.beginPath();
        ctx.moveTo(xF0, horizonY);
        ctx.lineTo(xF1, horizonY);
        ctx.lineTo(xN1, lineY);
        ctx.lineTo(xN0, lineY);
        ctx.closePath();
        ctx.fill();
        st.laneFlash[l] *= 0.82;
      }
    }

    // 床（判定ラインより手前は明るい床）
    const floor = ctx.createLinearGradient(0, lineY, 0, h);
    floor.addColorStop(0, '#d8d2c4');
    floor.addColorStop(0.15, '#b8b2a4');
    floor.addColorStop(1, '#8a8478');
    ctx.fillStyle = floor;
    ctx.fillRect(0, lineY, w, h - lineY);

    // 判定ライン
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,240,0.8)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = 'rgba(255,255,250,0.95)';
    ctx.fillRect(0, lineY - 1.5, w, 3);
    ctx.restore();

    // キーラベル（床に薄く）
    ctx.textAlign = 'center';
    ctx.font = '13px Georgia';
    ctx.fillStyle = 'rgba(60,55,45,0.5)';
    for (let l = 0; l < LANES; l++) {
      ctx.fillText(KEY_LABELS[l], l * laneW + laneW / 2, lineY + 24);
    }

    // ---- ノーツ（奥から手前へ、近づくほど大きく速く） ----
    const noteHBase = Math.max(11, h * 0.026);
    for (const n of st.notes) {
      if (n.judged && n.judged !== 'miss') continue;
      const dt = n.t - now;
      if (dt > fall) break; // t順ソート済み: 以降はまだ奥
      if (n.judged === 'miss' && now - n.t > 0.22) continue;
      const p = Math.min(1.02, 1 - dt / fall);
      const { x, y, s } = proj(p, n.lane);
      const nw = laneW * 0.72 * s;
      const nh = noteHBase * s;
      const appear = Math.min(1, (p / 0.18)); // 奥でふわっと出現
      const alpha = (n.judged === 'miss' ? 0.25 : 1) * appear;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = 'rgba(255,255,245,0.95)';
      ctx.shadowBlur = 18 * s;
      ctx.fillStyle = '#f8f6ee';
      roundRect(x - nw / 2, y - nh / 2, nw, nh, nh / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#14120e';
      roundRect(x - nw / 2 + nh * 0.45, y - nh * 0.18, nw - nh * 0.9, nh * 0.36, nh * 0.18);
      ctx.fill();
      ctx.restore();
    }

    // ヒットエフェクト（判定ライン上）
    const nowMs = performance.now();
    st.effects = st.effects.filter((ef) => nowMs - ef.t0 < 450);
    for (const ef of st.effects) {
      const p = (nowMs - ef.t0) / 450;
      const x = ef.lane * laneW + laneW / 2;
      if (ef.kind !== 'miss') {
        const r = 14 + p * laneW * 0.5;
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.strokeStyle = ef.kind === 'charming' ? '#ffe9a8' : '#ffffff';
        ctx.lineWidth = 3 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(x, lineY, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.font = '16px Georgia';
      ctx.textAlign = 'center';
      ctx.fillStyle = ef.kind === 'charming' ? '#f5d87a' : ef.kind === 'fine' ? '#e8e2d5' : '#77705f';
      ctx.fillText(ef.kind.toUpperCase(), x, lineY - 34 - p * 22);
      ctx.restore();
    }

    // 終了判定（曲が短く終わる場合の保険）
    if (now > st.duration + 1.2) { tryFinish(); return; }

    raf = requestAnimationFrame(loop);
  }

  function roundRect(x, y, w2, h2, r) {
    r = Math.min(r, w2 / 2, h2 / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w2, y, x + w2, y + h2, r);
    ctx.arcTo(x + w2, y + h2, x, y + h2, r);
    ctx.arcTo(x, y + h2, x, y, r);
    ctx.arcTo(x, y, x + w2, y, r);
    ctx.closePath();
  }

  // ---- 入力 ----
  window.addEventListener('keydown', (e) => {
    if (!st || st.paused) return;
    if (e.code === 'Escape') { pause(); return; }
    const lane = KEYS.indexOf(e.code);
    if (lane >= 0 && !e.repeat) judge(lane);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!st || st.paused) return;
    const lane = Math.min(LANES - 1, Math.max(0, Math.floor((e.clientX / canvas.clientWidth) * LANES)));
    judge(lane);
  });
  // マルチタッチ（pointerdownは各指で発火するのでこれで対応済み）

  // ウィンドウが最小化・非表示になったら自動ポーズ（音だけ進む事故を防ぐ）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !window.__testMode) pause();
  });

  function pause() {
    if (!st || st.finished || st.paused) return;
    st.paused = true;
    window.audioEngine.pause();
    cancelAnimationFrame(raf);
    if (st.onPause) st.onPause();
  }

  function resume() {
    if (!st) return;
    st.paused = false;
    window.audioEngine.resume(0.8);
    raf = requestAnimationFrame(loop);
  }

  function quit() {
    window.audioEngine.stop();
    cancelAnimationFrame(raf);
    st = null;
  }

  window.Game = { start, pause, resume, quit };
})();
