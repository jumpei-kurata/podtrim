#!/usr/bin/env node
// 「ある音声の一部が、別の音声のどこに出てくるか」を探す。
//
//   node test/find-segment.js <針(探したい側)> <干し草(探される側)> [針の開始秒] [長さ秒]
//
// 用途:
//  - 完成版が、どの生音源から作られたものかを判定する
//  - 完成版の各部分が生音源のどこに対応するかを割り出し、手編集がどこを切ったかを逆算する
//
// 包絡の相関で粗く当たりを付けてから、生波形でサンプル精度まで詰める。
// BGMやラウドネス調整が入っていても、声の抑揚（包絡）は残るので当たりは付く。

const { spawnSync } = require('child_process');
const path = require('path');

const ENV_RATE = 200; // 粗探し用
const FINE_RATE = 16000; // 精密化用
const SMOOTH = 0.05;

function pcm(file, rate, startSec, lenSec) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSec !== undefined) args.push('-ss', String(startSec));
  if (lenSec !== undefined) args.push('-t', String(lenSec));
  args.push('-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-');
  const r = spawnSync('ffmpeg', args, { maxBuffer: 2048 * 1024 * 1024, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${r.stderr}`);
  const n = r.stdout.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r.stdout.readFloatLE(i * 4);
  return out;
}

// 二乗の移動平均 → 包絡（平均を引いて相関のバイアスを消す）
function envelope(x, rate) {
  const win = Math.max(1, Math.round(rate * SMOOTH));
  const out = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= win) acc -= x[i - win] * x[i - win];
    out[i] = Math.sqrt(Math.max(0, acc) / Math.min(i + 1, win));
  }
  let m = 0;
  for (const v of out) m += v;
  m /= out.length;
  for (let i = 0; i < out.length; i++) out[i] -= m;
  return out;
}

function normCorr(a, b, offset) {
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const j = offset + i;
    if (j < 0 || j >= b.length) return -2;
    num += a[i] * b[j];
    da += a[i] * a[i];
    db += b[j] * b[j];
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const needleFile = process.argv[2];
const hayFile = process.argv[3];
const needleStart = Number(process.argv[4] || 300);
const needleLen = Number(process.argv[5] || 10);

// 粗探し: 包絡どうしを全域で走査
const nEnv = envelope(pcm(needleFile, ENV_RATE, needleStart, needleLen), ENV_RATE);
const hEnv = envelope(pcm(hayFile, ENV_RATE), ENV_RATE);

let best = -2, bestIdx = -1;
const scores = [];
for (let off = 0; off + nEnv.length < hEnv.length; off++) {
  const c = normCorr(nEnv, hEnv, off);
  scores.push(c);
  if (c > best) { best = c; bestIdx = off; }
}
// 2位（ピーク近傍を除く）と比べて、当たりが際立っているか
let second = -2;
for (let i = 0; i < scores.length; i++) {
  if (Math.abs(i - bestIdx) < ENV_RATE * 3) continue;
  if (scores[i] > second) second = scores[i];
}

const coarseAt = bestIdx / ENV_RATE;
const result = {
  needle: `${path.basename(needleFile)} @ ${needleStart}s (${needleLen}s)`,
  haystack: path.basename(hayFile),
  coarseMatchAt: +coarseAt.toFixed(3),
  coarseCorr: +best.toFixed(4),
  secondBest: +second.toFixed(4),
  distinct: best - second >= 0.15,
};

// 精密化: 当たり位置の周辺だけ生波形で詰める
if (result.distinct) {
  const PAD = 0.5;
  const nFine = pcm(needleFile, FINE_RATE, needleStart, needleLen);
  const hFine = pcm(hayFile, FINE_RATE, Math.max(0, coarseAt - PAD), needleLen + PAD * 2);
  const searchN = Math.round(PAD * 2 * FINE_RATE);
  let fb = -2, fi = 0;
  for (let s = 0; s < searchN; s++) {
    const c = normCorr(nFine, hFine, s);
    if (c > fb) { fb = c; fi = s; }
  }
  result.fineMatchAt = +(Math.max(0, coarseAt - PAD) + fi / FINE_RATE).toFixed(4);
  result.fineCorr = +fb.toFixed(4);
  result.sameRecording = fb > 0.9;
}

console.log(JSON.stringify(result, null, 2));
