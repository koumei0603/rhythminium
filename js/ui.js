// 画面遷移・曲一覧・設定・リザルト・管理者機能の統括
(function () {
  const $ = (id) => document.getElementById(id);
  const P = window.Platform;

  let songs = [];
  let scores = {};
  let current = null; // 選択中の曲
  let currentDiff = 'normal';
  let lastPlay = null; // リトライ用 {song, diff, chart}
  let loadedAudioId = null; // audioEngineにロード済みの曲ID

  // ---- 画面切替 ----
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---- 簡易プロンプト（Electronはwindow.prompt非対応） ----
  function ask(title, def = '') {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = `<div class="modal-box">
        <div class="modal-title" style="font-size:17px">${title}</div>
        <input type="text" style="font-family:inherit;font-size:15px;padding:10px;background:#0a0908;border:1px solid #4a453a;color:#e8e2d5;border-radius:4px">
        <div style="display:flex;gap:10px;justify-content:center">
          <button class="btn" data-ok>OK</button><button class="btn" data-cancel>キャンセル</button>
        </div></div>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('input');
      input.value = def;
      input.focus(); input.select();
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-ok]').onclick = () => done(input.value.trim());
      wrap.querySelector('[data-cancel]').onclick = () => done(null);
      input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); };
    });
  }

  function confirmBox(title) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = `<div class="modal-box">
        <div class="modal-title" style="font-size:17px">${title}</div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button class="btn btn-danger" data-ok>実行</button><button class="btn" data-cancel>キャンセル</button>
        </div></div>`;
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-ok]').onclick = () => done(true);
      wrap.querySelector('[data-cancel]').onclick = () => done(false);
    });
  }

  // ---- 曲一覧 ----
  async function refreshSongs(keepSelection = true) {
    songs = await P.listSongs();
    scores = await P.getScores();
    const list = $('song-list');
    list.innerHTML = '';
    for (const s of songs) {
      const li = document.createElement('li');
      const bestAll = bestOf(s.id);
      li.innerHTML = `<span class="li-title">${escapeHtml(s.title)}</span><span class="li-best">${bestAll ? bestAll.toFixed(2) + '%' : ''}</span>`;
      li.onclick = () => selectSong(s);
      li.dataset.id = s.id;
      list.appendChild(li);
    }
    $('song-empty').classList.toggle('hidden', songs.length > 0);
    $('song-detail').classList.toggle('hidden', songs.length === 0);
    if (songs.length > 0) {
      const keep = keepSelection && current && songs.find((x) => x.id === current.id);
      selectSong(keep || songs[0]);
    } else {
      current = null;
    }
  }

  function bestOf(id, diff) {
    const s = scores[id];
    if (!s) return null;
    if (diff) return s[diff] ? s[diff].best : null;
    let m = null;
    for (const d of Object.keys(s)) m = Math.max(m ?? 0, s[d].best);
    return m;
  }

  function selectSong(s) {
    current = s;
    document.querySelectorAll('#song-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === s.id));
    $('detail-title').textContent = s.title;
    // その曲のサムネを右側に表示（未設定なら非表示）
    const art = $('song-art');
    const url = P.thumbURL(s);
    if (url) {
      art.style.backgroundImage = `url("${url}")`;
      art.classList.add('visible');
    } else {
      art.classList.remove('visible');
      art.style.backgroundImage = '';
    }
    // 難易度チップ
    const row = $('diff-row');
    row.innerHTML = '';
    const diffs = ['easy', 'normal', 'hard'];
    if (!s.charts[currentDiff]) currentDiff = diffs.find((d) => s.charts[d]) || 'normal';
    for (const d of diffs) {
      const chip = document.createElement('div');
      const c = s.charts[d];
      chip.className = 'diff-chip' + (c ? '' : ' none') + (d === currentDiff && c ? ' selected' : '');
      chip.textContent = c ? `${d.toUpperCase()} Lv.${c.level}` : d.toUpperCase();
      if (c) chip.onclick = () => { currentDiff = d; selectSong(s); };
      row.appendChild(chip);
    }
    const b = bestOf(s.id, currentDiff);
    $('detail-best').textContent = b != null ? `BEST ${b.toFixed(2)}%` : '';
  }

  function escapeHtml(t) {
    return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- プレイ ----
  async function loadAudioFor(id) {
    if (loadedAudioId === id && window.audioEngine.buffer) return window.audioEngine.buffer;
    const ab = await P.getAudio(id);
    const buf = await window.audioEngine.load(ab);
    loadedAudioId = id;
    return buf;
  }

  async function startPlay(song, diff) {
    const chart = await P.getChart(song.id, diff);
    if (!chart || !chart.notes.length) { toast('この難易度の譜面がありません'); return; }
    toast('読み込み中...', 60000);
    try {
      await loadAudioFor(song.id);
    } finally {
      $('toast').classList.add('hidden');
    }
    lastPlay = { song, diff, chart };
    $('hud-title').textContent = song.title;
    $('hud-diff').textContent = `${diff.charAt(0).toUpperCase() + diff.slice(1)} LV${chart.level}`;
    $('game-pause').classList.add('hidden');
    show('screen-game');
    window.Game.start({
      title: song.title,
      chart,
      onFinish: showResult,
      onPause: () => $('game-pause').classList.remove('hidden'),
    });
  }

  async function showResult(r) {
    $('result-title').textContent = lastPlay.song.title;
    $('result-pct').textContent = r.pct.toFixed(2) + ' %';
    $('rc-charming').textContent = r.charming;
    $('rc-fine').textContent = r.fine;
    $('rc-miss').textContent = r.miss;
    $('rc-combo').textContent = r.maxCombo;
    // ベスト更新
    const id = lastPlay.song.id, d = lastPlay.diff;
    scores[id] = scores[id] || {};
    const prev = scores[id][d] ? scores[id][d].best : -1;
    const isNew = r.pct > prev;
    if (isNew) {
      scores[id][d] = { best: Math.round(r.pct * 100) / 100, at: Date.now() };
      await P.setScores(scores);
    }
    $('result-new-best').classList.toggle('hidden', !isNew);
    show('screen-result');
  }

  // ---- イベント配線 ----
  // マスコット（ファイルがあるときだけ表示）
  const mascot = $('title-mascot');
  mascot.onload = () => mascot.classList.remove('hidden');
  mascot.src = 'assets/mascot.png';

  $('screen-title').onclick = () => { window.audioEngine.ensureCtx(); refreshSongs().then(() => show('screen-songs')); };
  $('btn-to-title').onclick = () => show('screen-title');
  $('btn-play').onclick = () => current && startPlay(current, currentDiff);

  $('btn-pause').onclick = () => window.Game.pause();
  $('btn-resume').onclick = () => { $('game-pause').classList.add('hidden'); window.Game.resume(); };
  $('btn-retry').onclick = () => { window.Game.quit(); startPlay(lastPlay.song, lastPlay.diff); };
  $('btn-quit').onclick = () => { window.Game.quit(); show('screen-songs'); refreshSongs(); };
  $('btn-result-retry').onclick = () => startPlay(lastPlay.song, lastPlay.diff);
  $('btn-result-back').onclick = () => { refreshSongs().then(() => show('screen-songs')); };

  // 設定
  const setSpeed = $('set-speed'), setVol = $('set-volume'), setTap = $('set-tap'), setTapSound = $('set-tapsound');
  function syncSettingsUI() {
    setSpeed.value = window.Settings.data.speed;
    setVol.value = window.Settings.data.volume;
    setTap.value = window.Settings.data.tap;
    setTapSound.value = window.Settings.data.tapSound;
    $('speed-val').textContent = Number(window.Settings.data.speed).toFixed(1);
    $('volume-val').textContent = Number(window.Settings.data.volume).toFixed(1);
    $('tap-val').textContent = Number(window.Settings.data.tap).toFixed(1);
  }
  $('btn-settings').onclick = () => { syncSettingsUI(); $('settings-modal').classList.remove('hidden'); };
  $('btn-settings-close').onclick = () => $('settings-modal').classList.add('hidden');
  setSpeed.oninput = () => { window.Settings.data.speed = Number(setSpeed.value); window.Settings.save(); syncSettingsUI(); };
  setVol.oninput = () => {
    window.Settings.data.volume = Number(setVol.value);
    window.Settings.save(); syncSettingsUI();
    window.audioEngine.setVolume(window.Settings.data.volume / 10);
  };
  setTap.oninput = () => {
    window.Settings.data.tap = Number(setTap.value);
    window.Settings.save(); syncSettingsUI();
    window.audioEngine.setTapVolume((window.Settings.data.tap / 10) * 0.5);
    window.audioEngine.tap(); // 試し鳴り
  };
  setTapSound.onchange = () => {
    window.Settings.data.tapSound = setTapSound.value;
    window.Settings.save();
    window.audioEngine.setTapVolume((window.Settings.data.tap / 10) * 0.5);
    window.audioEngine.setTapSound(setTapSound.value);
    window.audioEngine.tap(); // 試し鳴り
  };

  // ---- 管理者機能（Electronのみ。PWAビルドにはこのUI自体が現れない） ----
  if (P.isAdmin) {
    $('admin-bar').classList.remove('hidden');
    $('detail-admin').classList.remove('hidden');

    // エディタと譜面生成モジュールを動的ロード（PWA書き出し対象外のファイル）
    for (const src of ['js/chartgen.js', 'js/editor.js']) {
      const sc = document.createElement('script');
      sc.src = src;
      document.body.appendChild(sc);
    }

    async function importFile(file) {
      toast('曲を解析して譜面を自動生成中...', 120000);
      try {
        const ab = await file.arrayBuffer();
        const meta = await P.importSong(file.name, ab);
        const buf = await window.audioEngine.load(ab.slice(0));
        loadedAudioId = meta.id;
        const charts = window.generateCharts(buf);
        for (const d of Object.keys(charts)) await P.saveChart(meta.id, d, charts[d]);
        await refreshSongs(false);
        selectSong(songs.find((x) => x.id === meta.id));
        toast(`「${meta.title}」を追加しました（Easy/Normal/Hard譜面を自動生成）`);
      } catch (err) {
        toast('取り込み失敗: ' + err.message, 5000);
      }
    }

    $('btn-import').onclick = () => $('file-input').click();
    $('file-input').onchange = (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; };

    const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

    async function setThumbFile(file) {
      if (!current) { toast('先に曲を選んでください'); return; }
      try {
        await P.setThumb(current.id, file.name, await file.arrayBuffer());
        await refreshSongs();
        toast('サムネを設定しました');
      } catch (err) {
        toast('サムネ設定失敗: ' + err.message, 5000);
      }
    }

    $('btn-thumb').onclick = () => $('thumb-input').click();
    $('thumb-input').onchange = (e) => { if (e.target.files[0]) setThumbFile(e.target.files[0]); e.target.value = ''; };

    // ドラッグ&ドロップ: 音声=曲の取込 / 画像=選択中の曲のサムネ
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!$('screen-songs').classList.contains('active') || !f) return;
      if (IMG_RE.test(f.name)) setThumbFile(f);
      else importFile(f);
    });

    $('btn-regen').onclick = async () => {
      if (!current) return;
      if (!(await confirmBox(`「${current.title}」の譜面を再生成します（手動調整は失われます）`))) return;
      toast('譜面を再生成中...', 120000);
      const buf = await loadAudioFor(current.id);
      const charts = window.generateCharts(buf);
      for (const d of Object.keys(charts)) await P.saveChart(current.id, d, charts[d]);
      await refreshSongs();
      toast('譜面を再生成しました');
    };

    $('btn-rename').onclick = async () => {
      if (!current) return;
      const name = await ask('曲名を変更', current.title);
      if (name) { await P.saveMeta(current.id, name); await refreshSongs(); }
    };

    $('btn-delete').onclick = async () => {
      if (!current) return;
      if (!(await confirmBox(`「${current.title}」を削除します。元に戻せません`))) return;
      await P.deleteSong(current.id);
      if (loadedAudioId === current.id) loadedAudioId = null;
      current = null;
      await refreshSongs(false);
      toast('削除しました');
    };

    $('btn-edit').onclick = async () => {
      if (!current || !window.Editor) return;
      const chart = await P.getChart(current.id, currentDiff);
      if (!chart) { toast('譜面がありません'); return; }
      await loadAudioFor(current.id);
      // 画面を表示してから初期化する（非表示中はキャンバスの寸法が0になるため）
      show('screen-editor');
      window.Editor.open(current, currentDiff, chart, async () => {
        await refreshSongs();
        show('screen-songs');
      });
    };

    // PWA書き出し（アイコンはCanvasで生成）
    function makeIcon(size) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, size, size);
      const grad = g.createRadialGradient(size / 2, size * 0.4, 0, size / 2, size * 0.4, size * 0.7);
      grad.addColorStop(0, '#2a2620');
      grad.addColorStop(1, '#000');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      // 白く光るノーツバー
      g.shadowColor = '#fff';
      g.shadowBlur = size * 0.06;
      g.fillStyle = '#f5efe2';
      const bw = size * 0.52, bh = size * 0.09;
      roundR(g, (size - bw) / 2, size * 0.30 - bh / 2, bw, bh, bh / 2); g.fill();
      roundR(g, (size - bw * 0.7) / 2, size * 0.52 - bh / 2, bw * 0.7, bh, bh / 2); g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#e8e2d5';
      g.fillRect(0, size * 0.78, size, size * 0.02);
      return c.toDataURL('image/png').split(',')[1];
    }
    function roundR(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    $('btn-export').onclick = async () => {
      toast('公開用PWAを書き出し中...', 60000);
      try {
        const r = await P.exportPWA(makeIcon(192), makeIcon(512));
        toast(`書き出し完了（曲${r.songCount}件）→ dist-pwa フォルダ`, 6000);
        window.electronAPI.openFolder('dist');
      } catch (err) {
        toast('書き出し失敗: ' + err.message, 5000);
      }
    };
  }

  // ---- PWA: Service Worker登録（プレイ専用ビルドのみ） ----
  if (!P.isAdmin && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
