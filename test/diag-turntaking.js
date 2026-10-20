#!/usr/bin/env node
// 実音源で「会話の譲り合い」がオフセット推定に使えるかを調べる診断ツール。
// 包絡をどれくらい平滑化すべきかを決めるため、平滑化の幅を変えて走査する。
//
//   node test/diag-turntaking.js <ref> <other> [正解オフセット]
//
// 20ms 程度の細かい包絡では音節レベルの揺れが支配的で、ターン（数秒）の構造が埋もれる。
// どこまで鈍らせれば「Aが喋る間はBが黙る」が相関として見えるかを実測する。

const { spawnSync } = require('child_process');

const RATE = 50; // 走査用の粗いレート（ターンは秒単位なので十分）
const SCAN = Number(process.env.SCAN || 8);
const STEP = Number(process.env.STEP || 0.1);
const SECS = Number(process.env.SECS || 1200);

function loadEnv(file, smoothSec) {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-t', String(SECS), '-i', file,
     '-ac', '1', '-ar', '4000', '-f', 'f32le', '-'],
    { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' }
  );
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const n = r.stdout.length / 4;
  // 4kHz で二乗 → smoothSec の移動平均 → RATE へ間引く
  const src = new Float64Array(n);
  for (let i = 0; i < n; i++) { const v = r.stdout.readFloatLE(i * 4); src[i] = v * v; }
  const win = Math.max(1, Math.round(4000 * smoothSec));
  const step = Math.round(4000 / RATE);
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += src[i];
    if (i >= win) acc -= src[i - win];
    if (i % step === 0) out.push(Math.sqrt(Math.max(0, acc) / Math.min(i + 1, win)));
  }
  const arr = Float64Array.from(out);
  let m = 0;
  for (const v of arr) m += v;
  m /= arr.length;
  for (let i = 0; i < arr.length; i++) arr[i] -= m;
  return arr;
}

function corrAt(a, b, lag) {
  let num = 0, da = 0, db = 0;
  const s = Math.max(0, -lag), e = Math.min(a.length, b.length - lag);
  for (let i = s; i < e; i++) {
    num += a[i] * b[i + lag];
    da += a[i] * a[i];
    db += b[i + lag] * b[i + lag];
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const [ref, other] = process.argv.slice(2, 4);
const truth = process.argv[4] !== undefined ? Number(process.argv[4]) : null;

for (const smooth of [0.02, 0.2, 0.5, 1.0, 2.0]) {
  const a = loadEnv(ref, smooth);
  const b = loadEnv(other, smooth);
  const rows = [];
  for (let off = -SCAN; off <= SCAN; off += STEP) {
    rows.push({ off: +off.toFixed(2), c: corrAt(a, b, Math.round(-off * RATE)) });
  }
  const min = rows.reduce((x, y) => (y.c < x.c ? y : x));
  const max = rows.reduce((x, y) => (y.c > x.c ? y : x));
  const atTruth = truth === null ? null : rows.reduce((x, y) => (Math.abs(y.off - truth) < Math.abs(x.off - truth) ? y : x));
  console.log(
    `平滑化 ${String(smooth).padStart(4)}s : 最小 ${min.c.toFixed(4)} @ ${String(min.off).padStart(6)}s` +
      `  最大 ${max.c.toFixed(4)} @ ${String(max.off).padStart(6)}s` +
      (atTruth ? `  正解(${truth}s)での値 ${atTruth.c.toFixed(4)}` : '')
  );
}
