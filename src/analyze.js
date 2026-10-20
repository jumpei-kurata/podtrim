#!/usr/bin/env node
// 3トラックの「全員無音」区間を検出し、カットリストを JSON で出力する。
// ファイルは一切変更しない（解析のみ）。

const { execFileSync, spawnSync } = require('child_process');

// 既定値はポッドキャスト向けの出発点。実音源で必ず調整すること。
// ffmpeg 既定(-60dB / 2秒)は会話音声には不適。auto-editor の既定(threshold 4% / margin 0.2秒)が裏付け。
const NOISE_DB = process.env.NOISE_DB || '-30dB'; // 無音とみなす音量閾値
const MIN_SIL = Number(process.env.MIN_SIL || 0.6); // silencedetect に渡す最小無音長
const PAD = Number(process.env.PAD || 0.2); // カット区間の前後に残す余白(秒)＝自然な間を殺さないため
// これより短くなる無音は削らない。実音源で手編集と突き合わせて校正した値。
//   1.2 → 手編集の67%・削りすぎ1区間  /  1.0 → 81%・削りすぎ2区間(最大2.8秒)  /  0.8 → 105%・10区間
// 倉田さんの要望「8割でいい」に合わせて 1.0 を既定にしている。
const MIN_CUT = Number(process.env.MIN_CUT || 1.0);

function duration(file) {
  return Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
      .toString()
      .trim()
  );
}

// 1ファイルの無音区間を [start, end] の配列で返す
function detectSilence(file, total) {
  // silencedetect の結果は stderr に出るので spawnSync で stderr を受け取る
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=n=${NOISE_DB}:d=${MIN_SIL}`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed on ${file}\n${res.stderr}`);
  const log = res.stderr;
  const spans = [];
  let open = null;
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) {
      spans.push([open, Number(e[1])]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, total]); // 末尾が無音のまま終わるケース
  return spans;
}

// 複数トラックの無音区間の積集合（＝全員が同時に無音の区間）
function intersect(listOfSpans) {
  return listOfSpans.reduce((acc, spans) => {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < acc.length && j < spans.length) {
      const lo = Math.max(acc[i][0], spans[j][0]);
      const hi = Math.min(acc[i][1], spans[j][1]);
      if (lo < hi) out.push([lo, hi]);
      if (acc[i][1] < spans[j][1]) i++;
      else j++;
    }
    return out;
  });
}

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error('usage: node analyze.js <track1> <track2> [track3...]');
  process.exit(1);
}

const durations = files.map(duration);
const total = Math.min(...durations);
const perTrack = files.map((f, i) => detectSilence(f, durations[i]));
const allSilent = intersect(perTrack);

// 余白を残し、短すぎる区間は削らない
const cuts = allSilent
  .map(([s, e]) => [s + PAD, e - PAD])
  .filter(([s, e]) => e - s >= MIN_CUT);

const removed = cuts.reduce((sum, [s, e]) => sum + (e - s), 0);

console.log(
  JSON.stringify(
    {
      files,
      durations,
      total,
      params: { NOISE_DB, MIN_SIL, PAD, MIN_CUT },
      silencePerTrack: perTrack.map((s, i) => ({ file: files[i], spans: s.map(r => r.map(n => +n.toFixed(3))) })),
      allSilent: allSilent.map(r => r.map(n => +n.toFixed(3))),
      cuts: cuts.map(r => r.map(n => +n.toFixed(3))),
      removedSeconds: +removed.toFixed(3),
      outputDuration: +(total - removed).toFixed(3),
    },
    null,
    2
  )
);
