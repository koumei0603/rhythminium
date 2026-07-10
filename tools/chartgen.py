#!/usr/bin/env python3
"""音ハメ重視の譜面自動生成ツール

音声のオンセット（音の立ち上がり）をスペクトラルフラックスで検出し、
実際に音が鳴っている瞬間にノーツを置く。BPMグリッドへの機械的な
配置は行わないため、リズムが揺れる曲でも音とノーツが一致する。

使い方:
  python3 tools/chartgen.py songs/<id> [songs/<id> ...]
  （chart-easy/normal/hard.json を上書きし、songs-index.json の
    noteCount / duration / bpm も更新する）

必要環境: ffmpeg, numpy, scipy
"""
import json, math, os, subprocess, sys
import numpy as np
from scipy.ndimage import median_filter, maximum_filter

SR = 22050
HOP = 256          # 約11.6ms
WIN = 1024
LANES = 7

# 難易度ごとのパラメータ
DIFFS = {
    # min_gap: ノーツ最小間隔 / lane_gap: 同一レーン最小間隔 /
    # target_nps: 目標ノーツ密度(個/秒) / max_gap: これ以上の空白は埋める / chords: 同時押し
    'easy':   dict(min_gap=0.32, lane_gap=0.60, target_nps=0.85, max_gap=3.0, chords=False),
    'normal': dict(min_gap=0.17, lane_gap=0.34, target_nps=2.10, max_gap=2.2, chords=False),
    'hard':   dict(min_gap=0.105, lane_gap=0.22, target_nps=3.40, max_gap=1.6, chords=True),
}


def load_audio(path):
    raw = subprocess.run(
        ['ffmpeg', '-v', 'quiet', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
        capture_output=True).stdout
    y = np.frombuffer(raw, dtype=np.float32)
    if len(y) == 0:
        raise RuntimeError(f'音声のデコードに失敗: {path}')
    return y


def stft_mag(y):
    n = 1 + (len(y) - WIN) // HOP
    window = np.hanning(WIN)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    frames = y[idx] * window
    return np.abs(np.fft.rfft(frames, axis=1))


def onset_detect(y):
    """オンセット時刻・強さ・音高（スペクトル重心）を返す"""
    mag = stft_mag(y)
    logmag = np.log1p(10 * mag)
    flux = np.diff(logmag, axis=0)
    flux[flux < 0] = 0
    env = flux.sum(axis=1)
    times = (np.arange(len(env)) + 1) * HOP / SR + (WIN / 2) / SR

    # 適応しきい値（移動中央値）で局所ピークを拾う
    med = median_filter(env, size=int(0.35 * SR / HOP) | 1)
    thresh = med * 1.4 + 0.25 * env.mean()
    localmax = env == maximum_filter(env, size=5)
    cand = np.where((env > thresh) & localmax)[0]

    # 静かなパートでも相対的な強さで選べるよう、局所正規化した強さも持つ
    loc = median_filter(env, size=int(4.0 * SR / HOP) | 1) + 1e-6

    freqs = np.fft.rfftfreq(WIN, 1 / SR)
    onsets = []
    for i in cand:
        # 放物線補間でピーク時刻をサブフレーム精度に
        t = times[i]
        if 0 < i < len(env) - 1:
            a, b, c = env[i - 1], env[i], env[i + 1]
            denom = a - 2 * b + c
            if abs(denom) > 1e-9:
                t += 0.5 * (a - c) / denom * HOP / SR
        # オンセット直後のスペクトル重心 → レーン割当に使う
        j = min(i + 1, len(mag) - 1)
        m = mag[j:j + 4].mean(axis=0)
        centroid = float((m * freqs).sum() / (m.sum() + 1e-9))
        onsets.append((t, float(env[i] / loc[i]), centroid))

    # 近接（35ms以内）は強い方に統合
    onsets.sort()
    merged = []
    for o in onsets:
        if merged and o[0] - merged[-1][0] < 0.035:
            if o[1] > merged[-1][1]:
                merged[-1] = o
            continue
        merged.append(o)
    return merged, env, times


def estimate_bpm(env, times):
    """オンセット包絡の自己相関からBPMを推定（メタ情報用）"""
    e = env - env.mean()
    ac = np.correlate(e, e, mode='full')[len(e) - 1:]
    dt = HOP / SR
    lo, hi = int(60 / 200 / dt), int(60 / 60 / dt)  # 60-200 BPM
    lag = lo + int(np.argmax(ac[lo:hi]))
    return round(60 / (lag * dt), 1)


def assign_lanes(notes, lane_gap, rng):
    """スペクトル重心（低音=左, 高音=右）に沿ってレーンを割り当てる。
    直近の同一レーン連打は隣に逃がして叩きやすくする。"""
    cents = np.array([c for _, _, c in notes])
    qs = np.quantile(cents, np.linspace(0, 1, LANES + 1)[1:-1]) if len(cents) > LANES else []
    last_used = [-9.0] * LANES
    prev_lane = LANES // 2
    out = []
    for t, s, c in notes:
        lane = int(np.searchsorted(qs, c)) if len(qs) else rng.integers(0, LANES)
        # 手の移動が飛びすぎないよう1ステップ縮める
        if abs(lane - prev_lane) >= 4:
            lane += -1 if lane > prev_lane else 1
        # 同一レーンが近すぎるときは空いている近隣レーンへ
        if t - last_used[lane] < lane_gap:
            order = sorted(range(LANES), key=lambda l: (abs(l - lane), abs(l - prev_lane)))
            for l in order:
                if t - last_used[l] >= lane_gap:
                    lane = l
                    break
        last_used[lane] = t
        prev_lane = lane
        out.append({'t': round(t, 3), 'lane': lane, '_s': s})
    return out


def select_notes(onsets, duration, min_gap, target_nps, max_gap):
    """強い音を優先して目標密度まで選ぶ。最小間隔は必ず守る。"""
    target = int(duration * target_nps)
    by_strength = sorted(onsets, key=lambda o: -o[1])
    chosen_times = []
    chosen = []

    def try_add(o):
        t = o[0]
        i = np.searchsorted(chosen_times, t)
        if i > 0 and t - chosen_times[i - 1] < min_gap:
            return False
        if i < len(chosen_times) and chosen_times[i] - t < min_gap:
            return False
        chosen_times.insert(i, t)
        chosen.insert(i, o)
        return True

    for o in by_strength:
        if len(chosen) >= target:
            break
        try_add(o)

    # 音が鳴っているのにノーツが長時間来ない区間を埋める
    # （静かなパートでも局所的に強い音を拾う。無音区間はオンセット自体が無いので埋まらない）
    changed = True
    while changed:
        changed = False
        for a, b in zip(chosen_times[:-1], chosen_times[1:]):
            if b - a <= max_gap:
                continue
            inside = [o for o in onsets if a + min_gap <= o[0] <= b - min_gap]
            for o in sorted(inside, key=lambda o: -o[1]):
                if try_add(o):
                    changed = True
                    break
            if changed:
                break
    chosen.sort()
    return chosen


def add_chords(notes, lane_gap, rng):
    """特に強い音に同時押し（2レーン）を足す（hardのみ）。
    相方のレーンも同一レーン最小間隔を守れる場所だけに置く。"""
    if not notes:
        return notes
    strengths = np.array([n['_s'] for n in notes])
    th = np.quantile(strengths, 0.93)
    out = list(notes)
    last_chord_t = -9.0
    for k, n in enumerate(notes):
        if n['_s'] < th or n['t'] - last_chord_t < 1.2:
            continue
        # 前後 lane_gap 以内に使われているレーンは避ける
        busy = {m['lane'] for m in notes if abs(m['t'] - n['t']) < lane_gap}
        cands = [n['lane'] + d for d in rng.permutation([-3, -2, 2, 3])]
        partner = next((int(c) for c in cands if 0 <= c < LANES and c not in busy), None)
        if partner is None:
            continue
        out.append({'t': n['t'], 'lane': partner, '_s': n['_s']})
        last_chord_t = n['t']
    out.sort(key=lambda n: (n['t'], n['lane']))
    return out


def generate(song_dir, index_entry):
    y = load_audio(os.path.join(song_dir, 'song.mp3'))
    duration = round(len(y) / SR, 3)
    onsets, env, times = onset_detect(y)
    bpm = estimate_bpm(env, times)
    print(f'{song_dir}: {duration:.1f}s, onsets={len(onsets)}, bpm~{bpm}')

    for diff, p in DIFFS.items():
        rng = np.random.default_rng(hash(diff) % (2 ** 31))
        chosen = select_notes(onsets, duration, p['min_gap'], p['target_nps'], p['max_gap'])
        notes = assign_lanes(chosen, p['lane_gap'], rng)
        if p['chords']:
            notes = add_chords(notes, p['lane_gap'], rng)
        for n in notes:
            n.pop('_s', None)
        path = os.path.join(song_dir, f'chart-{diff}.json')
        old = json.load(open(path)) if os.path.exists(path) else {}
        chart = {
            'difficulty': diff,
            'level': old.get('level', {'easy': 2, 'normal': 6, 'hard': 10}[diff]),
            'duration': duration,
            'bpm': bpm,
            'notes': notes,
        }
        json.dump(chart, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))
        print(f'  {diff}: {len(notes)} notes ({len(notes)/duration:.2f}/s)')
        if index_entry is not None:
            index_entry.setdefault('charts', {}).setdefault(diff, {})
            index_entry['charts'][diff]['level'] = chart['level']
            index_entry['charts'][diff]['noteCount'] = len(notes)


def main(dirs):
    index_path = 'songs-index.json'
    index = json.load(open(index_path)) if os.path.exists(index_path) else None
    for d in dirs:
        sid = os.path.basename(d.rstrip('/'))
        entry = next((s for s in index if s['id'] == sid), None) if index else None
        generate(d, entry)
    if index is not None:
        json.dump(index, open(index_path, 'w'), ensure_ascii=False, indent=2)
        print('songs-index.json updated')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
