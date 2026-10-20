#!/usr/bin/env node
// 完成版（人間が編集したもの）が、生音源のどこを使っているかを割り出す。
// 一定間隔で完成版から短い断片を取り、生音源のどこに一致するかを探すことで
// 「人間がどこを何秒切ったか」を逆算する。自動編集との比較に使う。
//
//   node test/map-manual-edit.js <完成版> <生音源(頭出し済み)> [間隔秒]
//
// 生音源は一度だけ読み込んで使い回す（毎回読むと遅い）。
// BGM が乗っていても効くよう、声の芯の帯域だけを生波形で相関させる。

const { spawnSync } = require('child_process');
const fs = require('fs');

const RATE = Number(process.env.RATE || 2000);
const BAND = process.env.BAND || 'highpass=f=200,lowpass=f=900';
const PROBE_LEN = Number(process.env.PROBE_LEN || 6);
const STEP = Number(process.argv[4] || 30);
const MIN_CORR = Number(process.env.MIN_CORR || 0.25);

function pcm(file, startSec, lenSec) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSec !== undefined) args.push('-ss', String(startSec));
  if (lenSec !== undefined) args.push('-t', String(lenSec));
  args.push('-i', file, '-af', BAND, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-');
  const r = spawnSync('ffmpeg', args, { maxBuffer: 2048 * 1024 * 1024, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${r.stderr}`);
  const n = r.stdout.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r.stdout.readFloatLE(i * 4);
  return out;
}

function duration(file) {
  return Number(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }).stdout.trim()
  );
}

// 総当たりの正規化相関。探索範囲を絞って呼ぶので十分速い
function locate(needle, hay, fromIdx, toIdx) {
  const L = needle.length;
  let nn = 0;
  for (const v of needle) nn += v * v;
  nn = Math.sqrt(nn);
  if (nn <= 0) return { at: -1, corr: -2, second: -2 };

  let best = -2, bestIdx = -1, second = -2;
  const lo = Math.max(0, fromIdx);
  const hi = Math.min(hay.length - L, toIdx);
  for (let off = lo; off < hi; off++) {
    let dot = 0, den = 0;
    for (let i = 0; i < L; i += 2) { // 2サンプルおき（粗探し。位置は±1サンプル程度ずれうる）
      const h = hay[off + i];
      dot += needle[i] * h;
      den += h * h;
    }
    const c = den > 0 ? dot / (nn * Math.sqrt(den * 2) / Math.SQRT2) : 0;
    if (c > best) { second = best; best = c; bestIdx = off; }
    else if (c > second && Math.abs(off - bestIdx) > RATE) second = c;
  }
  return { at: bestIdx / RATE, corr: best, second };
}

const completedFile = process.argv[2];
const rawFile = process.argv[3];

const compDur = duration(completedFile);
const rawDur = duration(rawFile);
process.stderr.write(`完成版 ${compDur.toFixed(1)}s / 生音源 ${rawDur.toFixed(1)}s を読み込み中...\n`);
const hay = pcm(rawFile);
process.stderr.write(`読み込み完了。${Math.floor(compDur / STEP)} 箇所を照合します\n`);

const rows = [];
let prevRaw = 0;
for (let t = 5; t + PROBE_LEN < compDur; t += STEP) {
  const needle = pcm(completedFile, t, PROBE_LEN);
  // 単調に進むはずなので、前回の一致位置以降だけを探せばよい（速度と誤検出対策）
  const from = Math.max(0, Math.round(prevRaw * RATE));
  const to = Math.min(hay.length, from + Math.round((STEP + 600) * RATE));
  const r = locate(needle, hay, from, to);
  const ok = r.corr >= MIN_CORR;
  if (ok) prevRaw = r.at;
  rows.push({
    completedAt: +t.toFixed(1),
    rawAt: ok ? +r.at.toFixed(1) : null,
    removedSoFar: ok ? +(r.at - t).toFixed(1) : null,
    corr: +r.corr.toFixed(3),
    matched: ok,
  });
  process.stderr.write(`  ${t.toFixed(0)}s → ${ok ? r.at.toFixed(1) + 's' : '不一致'} (corr ${r.corr.toFixed(2)})\n`);
}

const matched = rows.filter(r => r.matched);
const out = {
  completedDuration: +compDur.toFixed(1),
  rawDuration: +rawDur.toFixed(1),
  totalRemoved: +(rawDur - compDur).toFixed(1),
  probes: rows.length,
  matchedProbes: matched.length,
  rows,
};
fs.writeFileSync(process.env.OUT || 'manual-map.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, rows: undefined }, null, 2));
