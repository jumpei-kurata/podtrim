#!/usr/bin/env node
// 回の再生用音声（voices.wav）から、人ごとの話し声の大きさと、全員が黙っている所（間）を測って project.json に入れる。
//
//   node ui/analyze-project.js <回のID>
//
// 既にある回に足す時に使う（prep.js で作り直すと編集の状態が退避されるので、作り直さずに足す）。
// prep.js も回を作る最後にこれを呼ぶ。
//
// 話し声の大きさ（tracks[].speechDb）: 50ms ごとの大きさのうち、声が出ている所だけの平均。
//   全体の平均では、黙っている時間が長い人ほど小さく出てしまうので、声の所だけで測る。画面の「声をそろえる」が使う。
// 間（silences）: 全員が -30dB より小さい所（0.3秒以上）。画面の「詰め具合」のつまみが、ここから切る所を作り直す。
//   自動編集（src/analyze.js）は 0.6 秒以上の無音しか拾わないので、つまみで細かく詰められるよう短い無音まで拾っておく。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const DATA = require('./data-dir');

const RATE = 8000;
const FRAME = 0.05;
const NOISE_DB = -30;
const MIN_SIL = 0.3;

function decodeChannel(file, k) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', `pan=mono|c0=c${k}`,
    '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${r.stderr}`);
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)));
}

// 声が出ている所だけの平均の大きさ（dB）
function speechDb(samples) {
  const fl = Math.round(RATE * FRAME);
  const n = Math.floor(samples.length / fl);
  const power = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) s += samples[i] * samples[i];
    power[f] = s / fl;
  }
  const db = Array.from(power, p => 10 * Math.log10(p + 1e-12)).sort((a, b) => a - b);
  if (!db.length) return null;
  const pct = q => db[Math.floor(q * (db.length - 1))];
  // 声の所 = 静かな所（下から1割）より15dB以上大きく、大きい方から1%の所より30dB下まで。
  // ほとんど黙らない人は「下から1割」も声になるので、大きい方から10dB下より上は必ず声として数える
  const thr = Math.min(Math.max(pct(0.1) + 15, pct(0.99) - 30), pct(0.99) - 10);
  let sum = 0, cnt = 0;
  for (const p of power) {
    if (10 * Math.log10(p + 1e-12) > thr) { sum += p; cnt++; }
  }
  return cnt ? 10 * Math.log10(sum / cnt) : null;
}

// 1つのチャンネルの無音区間（silencedetect。src/analyze.js と同じ判定）
function silenceSpans(file, k, total, noiseDb) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af',
    `pan=mono|c0=c${k},silencedetect=n=${noiseDb}dB:d=${MIN_SIL}`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${r.stderr}`);
  const spans = [];
  let open = null;
  for (const line of r.stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) { spans.push([open, Number(e[1])]); open = null; }
  }
  if (open !== null) spans.push([open, total]);
  return spans;
}

function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (lo < hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

function analyzeProject(dir) {
  const projFile = path.join(dir, 'project.json');
  const project = JSON.parse(fs.readFileSync(projFile, 'utf8'));
  const voices = path.join(dir, project.voices);
  // 無音とみなす大きさは、自動編集と同じにする（違うと、つまみを既定に戻した時と切る所がずれる）
  const noiseDb = project.autoParams && Number.isFinite(project.autoParams.noiseDb) ? project.autoParams.noiseDb : NOISE_DB;
  const perTrack = project.tracks.map((t, k) => {
    const db = speechDb(decodeChannel(voices, k));
    t.speechDb = db === null ? null : +db.toFixed(1);
    return silenceSpans(voices, k, project.duration, noiseDb);
  });
  project.silences = perTrack.reduce(intersect).map(([s, e]) => [+s.toFixed(3), +e.toFixed(3)]);
  project.silenceParams = { noiseDb, minSil: MIN_SIL };
  // 書きかけのファイルを残さないよう、別名に書いてから置き換える（画面のサーバーが同時に読むため）
  fs.writeFileSync(projFile + '.tmp', JSON.stringify(project, null, 2));
  fs.renameSync(projFile + '.tmp', projFile);
  return project;
}

module.exports = { analyzeProject, speechDb };

if (require.main === module) {
  const id = process.argv[2];
  if (!id || !/^[\w.-]+$/.test(id)) {
    console.error('usage: node ui/analyze-project.js <回のID>');
    process.exit(1);
  }
  const p = analyzeProject(path.join(DATA, id));
  console.log(`話し声の大きさ: ${p.tracks.map(t => `${t.name} ${t.speechDb}dB`).join(' / ')}`);
  console.log(`全員が黙っている所（${p.silenceParams.minSil}秒以上）: ${p.silences.length}か所`);
}
