#!/usr/bin/env node
// カットする区間に、トラックごとに「音」が残っていないかを数える（声の小さい人の発話を切っていないかの確認）。
// 全員無音の判定は固定の -30dB なので、声の小さい人のささやき・相槌が「無音」扱いで切られる恐れがある。
//
//   node test/check-cut-content.js <cuts.json>
//
// 3人の実音源（2026-10-17・ピープルウェアー回と守りのトークン抑え回）では、カット区間に残る音は
// 3人とも大きい声より20〜30dB小さい息や物音くらい（最大 -33dB・大きい声は -14〜-18dB）だった。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const RATE = 8000;
const FRAME = 0.05;
const fl = Math.round(RATE * FRAME);

function framesDb(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
    { maxBuffer: 2048 * 1024 * 1024, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const n = Math.floor(r.stdout.length / 4);
  const out = new Float64Array(Math.floor(n / fl));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) { const v = r.stdout.readFloatLE(i * 4); s += v * v; }
    out[f] = 10 * Math.log10(s / fl + 1e-12);
  }
  return out;
}

const cutTotal = plan.cuts.reduce((a, [s, e]) => a + (e - s), 0);
console.log(`カット ${plan.cuts.length}区間・計 ${cutTotal.toFixed(1)}秒`);
for (const file of plan.files) {
  const db = framesDb(file);
  const sorted = Float64Array.from(db).sort();
  const floor = sorted[Math.floor(0.1 * (sorted.length - 1))];
  const loud = sorted[Math.floor(0.99 * (sorted.length - 1))];
  const SOUND = floor + 20; // 床の雑音より20dB上＝何かの音（声・息・物音）
  let soundSec = 0;
  const perCut = [];
  for (const [s, e] of plan.cuts) {
    let mx = -200, cnt = 0;
    for (let f = Math.ceil(s / FRAME); f < Math.floor(e / FRAME) && f < db.length; f++) {
      if (db[f] > mx) mx = db[f];
      if (db[f] > SOUND) cnt++;
    }
    soundSec += cnt * FRAME;
    perCut.push({ s, e, mx, soundSec: cnt * FRAME });
  }
  perCut.sort((a, b) => b.mx - a.mx);
  console.log(`\n${path.basename(file)}  床 ${floor.toFixed(1)}dB / 大きい声 ${loud.toFixed(1)}dB / 「音あり」の線 ${SOUND.toFixed(1)}dB`);
  console.log(`  カット区間の中で「音あり」: 計 ${soundSec.toFixed(2)}秒（${perCut.filter(c => c.soundSec > 0).length}区間）`);
  console.log('  カット区間の中で大きい順 上位8: ' + perCut.slice(0, 8).map(c => `${c.s.toFixed(1)}s〜(${(c.e - c.s).toFixed(1)}秒) 最大${c.mx.toFixed(1)}dB 音あり${c.soundSec.toFixed(2)}s`).join(' / '));
}
