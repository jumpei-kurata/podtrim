#!/usr/bin/env node
// 実音源の冒頭で「何が鳴っているか」を粗く可視化する診断ツール。
// 手拍子がどこにあるか、検出器が何を拾っているかを人間の目で確かめるため。
//
//   node test/diag-onset.js <file> [秒数]

const { spawnSync } = require('child_process');

const file = process.argv[2];
const SECS = Number(process.argv[3] || 60);
const RATE = 16000;
const HPF = Number(process.env.HPF || 2000);

function pcm(hp) {
  const af = hp ? ['-af', `highpass=f=${HPF}`] : [];
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-t', String(SECS), '-i', file, ...af,
     '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
    { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' }
  );
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const n = r.stdout.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r.stdout.readFloatLE(i * 4);
  return out;
}

const full = pcm(false);
const hp = pcm(true);

// 50ms ごとのピーク値を棒グラフで出す（全帯域と高域）
const BLK = Math.round(RATE * 0.05);
const rows = [];
for (let b = 0; b * BLK < full.length; b++) {
  let pf = 0, ph = 0;
  for (let i = b * BLK; i < Math.min((b + 1) * BLK, full.length); i++) {
    if (Math.abs(full[i]) > pf) pf = Math.abs(full[i]);
    if (Math.abs(hp[i]) > ph) ph = Math.abs(hp[i]);
  }
  rows.push({ t: +(b * 0.05).toFixed(2), full: pf, hp: ph });
}

// 高域のピークが目立つ順（＝拍手らしさ）に上位を出す
const top = [...rows].sort((a, b) => b.hp - a.hp).slice(0, 15);
console.log('高域(>' + HPF + 'Hz)のピークが大きい順 上位15:');
for (const r of top) {
  const bar = '#'.repeat(Math.round(r.hp * 60));
  console.log(`  ${String(r.t).padStart(7)}s  hp=${r.hp.toFixed(4)}  full=${r.full.toFixed(4)}  ${bar}`);
}

// 冒頭の様子を時系列で（音が出ている所だけ）
console.log('\n冒頭20秒の音の出方（全帯域ピーク）:');
for (const r of rows.filter(r => r.t < 20 && r.full > 0.01)) {
  const bar = '#'.repeat(Math.round(r.full * 50));
  console.log(`  ${String(r.t).padStart(6)}s ${bar}`);
}
