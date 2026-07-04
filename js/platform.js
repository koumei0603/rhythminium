// 実行環境の吸収層: Electron(管理者) / PWA(プレイ専用)
// PWAビルドには editor.js / chartgen.js が含まれず、管理系メソッドは呼ばれない
(function () {
  const isAdmin = !!window.electronAPI;

  const electronImpl = {
    isAdmin: true,
    listSongs: () => window.electronAPI.listSongs(),
    getAudio: async (id) => {
      const buf = await window.electronAPI.getAudio(id);
      // IPC経由のBufferはUint8Arrayとして届く
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    getChart: (id, diff) => window.electronAPI.getChart(id, diff),
    getScores: () => window.electronAPI.getScores(),
    setScores: (s) => window.electronAPI.setScores(s),
    importSong: (name, arrayBuffer) => window.electronAPI.importSong(name, new Uint8Array(arrayBuffer)),
    saveChart: (id, diff, chart) => window.electronAPI.saveChart(id, diff, chart),
    deleteSong: (id) => window.electronAPI.deleteSong(id),
    saveMeta: (id, title) => window.electronAPI.saveMeta(id, title),
    setThumb: (id, name, arrayBuffer) => window.electronAPI.setThumb(id, name, new Uint8Array(arrayBuffer)),
    thumbURL: (song) => song.thumbUrl || null,
    exportPWA: (i192, i512) => window.electronAPI.exportPWA(i192, i512),
  };

  const webImpl = {
    isAdmin: false,
    _index: null,
    listSongs: async function () {
      if (!this._index) {
        const res = await fetch('songs-index.json');
        this._index = res.ok ? await res.json() : [];
      }
      return this._index;
    },
    getAudio: async function (id) {
      const songs = await this.listSongs();
      const s = songs.find((x) => x.id === id);
      const res = await fetch(`songs/${id}/${s.file}`);
      return res.arrayBuffer();
    },
    getChart: async (id, diff) => {
      const res = await fetch(`songs/${id}/chart-${diff}.json`);
      return res.ok ? res.json() : null;
    },
    getScores: async () => JSON.parse(localStorage.getItem('rg-scores') || '{}'),
    setScores: async (s) => localStorage.setItem('rg-scores', JSON.stringify(s)),
    thumbURL: (song) => (song.thumb ? `songs/${song.id}/${song.thumb}` : null),
  };

  window.Platform = isAdmin ? electronImpl : webImpl;

  // 設定は両環境ともlocalStorage
  window.Settings = {
    data: Object.assign({ speed: 5, volume: 8, tap: 4 }, JSON.parse(localStorage.getItem('rg-settings') || '{}')),
    save() { localStorage.setItem('rg-settings', JSON.stringify(this.data)); },
  };
})();
