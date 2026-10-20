#!/usr/bin/env node
// 「完成版のこの部分が、生音源のどこか」を生波形の相互相関(FFT)で特定する。
//
//   node test/find-segment-raw.js <完成版> <生音源> <開始秒> [長さ秒]
//
// なぜ包絡ではダメか:
//   完成版には BGM が乗っており、生音源では無音だった箇所が音で埋まる。
//   包絡（音量の起伏）は BGM に支配されて別物になり、相関が立たない（実測で不一致になった）。
//   生波形なら BGM は加算的な別信号として乗るだけなので、声そのものの相関は残る。

const { spawnSync } = require('child_process');
const path = require('path');

const RATE = Number(process.env.RATE || 2000); // 生波形相関用。低くするほど速いが位相に敏感になる
const BAND = process.env.BAND || 'highpass=f=200,lowpass=f=900'; // 声の芯だけ残してBGMの影響を減らす

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

// needle が hay のどこにあるか。正規化のため hay 側の移動二乗和で割る
function locate(needle, hay) {
  let n = 1;
  while (n < hay.length + needle.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(hay);
  // 相関にするため needle を反転して畳み込む
  for (let i = 0; i < needle.length; i++) br[i] = needle[needle.length - 1 - i];
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const rr = ar[i] * br[i] - ai[i] * bi[i];
    const ii = ai[i] * br[i] + ar[i] * bi[i];
    ar[i] = rr; ai[i] = ii;
  }
  fft(ar, ai, true);

  // needle のノルム
  let nn = 0;
  for (const v of needle) nn += v * v;
  nn = Math.sqrt(nn);

  // hay の移動二乗和（正規化用）
  const L = needle.length;
  let run = 0;
  for (let i = 0; i < L && i < hay.length; i++) run += hay[i] * hay[i];

  let best = -2, bestIdx = -1;
  const scores = new Float64Array(Math.max(0, hay.length - L));
  for (let off = 0; off + L < hay.length; off++) {
    const dot = ar[off + L - 1];
    const denom = nn * Math.sqrt(Math.max(run, 1e-12));
    const c = denom > 0 ? dot / denom : 0;
    scores[off] = c;
    if (c > best) { best = c; bestIdx = off; }
    run += hay[off + L] * hay[off + L] - hay[off] * hay[off];
  }

  let second = -2;
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(i - bestIdx) < RATE * 2) continue;
    if (scores[i] > second) second = scores[i];
  }
  return { at: bestIdx / RATE, corr: best, second };
}

const needleFile = process.argv[2];
const hayFile = process.argv[3];
const start = Number(process.argv[4] || 300);
const len = Number(process.argv[5] || 8);

const needle = pcm(needleFile, start, len);
const hay = pcm(hayFile);
const r = locate(needle, hay);

console.log(
  JSON.stringify(
    {
      needle: `${path.basename(needleFile)} @ ${start}s (${len}s)`,
      haystack: path.basename(hayFile),
      matchAt: +r.at.toFixed(3),
      corr: +r.corr.toFixed(4),
      secondBest: +r.second.toFixed(4),
      margin: +(r.corr - r.second).toFixed(4),
      sameRecording: r.corr > 0.3 && r.corr - r.second > 0.1,
    },
    null,
    2
  )
);
