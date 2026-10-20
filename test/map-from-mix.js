#!/usr/bin/env node
// 完成版（手編集）の各時刻が、頭を揃えた生音源のどこに当たるかの対応表を作る（map-manual-edit.js の複数トラック版）。
// 頭を揃えた生音源は同じ時間軸なので、どのトラックで一致しても同じ位置になる。窓ごとに一番強く一致したトラックを使う。
// 1本ずつ総当たりする map-manual-edit.js は、3人の回だと遅く、話していない人のトラックでは外れる。こちらは FFT で速い。
// 出力は map-manual-edit.js と同じ形（compare-manual.js・tune.js にそのまま渡せる）。
//
//   node test/map-from-mix.js <出力map.json> <完成版> <頭を揃えた生音源...>
//   例: ピープルウェアー回（2026-10-17）は 232 窓中 215 で一致し、手編集は 477 秒・自動は 311 秒（65%）削っていた
const { spawnSync } = require('child_process');
const fs = require('fs');

const RATE = 2000;
const BAND = 'highpass=f=200,lowpass=f=900'; // 声の芯だけ残して BGM の影響を減らす
const WIN = Number(process.env.WIN || 4);
const STEP = Number(process.env.STEP || 10);
const SEARCH = 60;
const MIN_CORR = 0.5;
const MIN_MARGIN = 0.15;

const [outFile, mixFile, ...raws] = process.argv.slice(2);
if (!outFile || !mixFile || !raws.length) {
  console.error('usage: node test/map-from-mix.js <出力map.json> <完成版> <頭を揃えた生音源...>');
  process.exit(1);
}

function pcm(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', BAND, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
    { maxBuffer: 2048 * 1024 * 1024, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${r.stderr}`);
  const n = r.stdout.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r.stdout.readFloatLE(i * 4);
  return out;
}

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// needle が hay[lo, hi) のどこにあるか（正規化相互相関・FFT）
function locate(needle, hay, lo, hi) {
  lo = Math.max(0, lo);
  hi = Math.min(hay.length, hi);
  const seg = hay.subarray(lo, hi);
  const L = needle.length;
  if (seg.length <= L) return { at: -1, corr: -2, second: -2 };
  let n = 1;
  while (n < seg.length + L) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(seg);
  for (let i = 0; i < L; i++) br[i] = needle[L - 1 - i];
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const rr = ar[i] * br[i] - ai[i] * bi[i];
    const ii = ai[i] * br[i] + ar[i] * bi[i];
    ar[i] = rr; ai[i] = ii;
  }
  fft(ar, ai, true);
  let nn = 0;
  for (const v of needle) nn += v * v;
  nn = Math.sqrt(nn);
  let run = 0;
  for (let i = 0; i < L; i++) run += seg[i] * seg[i];
  const scores = new Float64Array(seg.length - L);
  let best = -2, bestIdx = -1;
  for (let off = 0; off + L < seg.length; off++) {
    const c = nn > 0 && run > 1e-12 ? ar[off + L - 1] / (nn * Math.sqrt(run)) : 0;
    scores[off] = c;
    if (c > best) { best = c; bestIdx = off; }
    run += seg[off + L] * seg[off + L] - seg[off] * seg[off];
  }
  let second = -2;
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(i - bestIdx) < RATE * 0.5) continue;
    if (scores[i] > second) second = scores[i];
  }
  return { at: (lo + bestIdx) / RATE, corr: best, second };
}

const mix = pcm(mixFile);
const hays = raws.map(pcm);
const compDur = mix.length / RATE;
const rawDur = Math.min(...hays.map(h => h.length / RATE));
process.stderr.write(`完成版 ${compDur.toFixed(1)}s / 生音源 ${rawDur.toFixed(1)}s\n`);

const rows = [];
let lastRaw = null;
let lastT = null;
for (let t = 5; t + WIN < compDur; t += STEP) {
  const needle = mix.subarray(Math.round(t * RATE), Math.round((t + WIN) * RATE));
  let best = null;
  hays.forEach(h => {
    // 最初の一致までは全体を探す。以降は直前の一致位置から（カットで生音源の方が速く進む）
    const r = lastRaw === null
      ? locate(needle, h, 0, h.length)
      : locate(needle, h, Math.round((lastRaw + (t - lastT) - 5) * RATE), Math.round((lastRaw + (t - lastT) + SEARCH + WIN) * RATE));
    if (!best || r.corr > best.corr) best = r;
  });
  const ok = best.corr >= MIN_CORR && best.corr - best.second >= MIN_MARGIN;
  if (ok) { lastRaw = best.at; lastT = t; }
  rows.push({
    completedAt: +t.toFixed(1),
    rawAt: ok ? +best.at.toFixed(2) : null,
    removedSoFar: ok ? +(best.at - t).toFixed(2) : null,
    corr: +best.corr.toFixed(3),
    matched: ok,
  });
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
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, rows: undefined }, null, 2));
