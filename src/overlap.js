#!/usr/bin/env node
// 発話の被り区間を検出して「人間が判断するための候補リスト」を作る。
// 自動では消さない。誰を残すかは人間の判断に委ねる。
//
// 同室録音では他人の声が自分のマイクにも入る(bleed)ため、単純に「2本とも音がある」で
// 判定すると偽の被りだらけになる。そこで区間内の各トラックの実音量を測り、相対差で主話者を推定する。
// リモート録音では bleed が無いので、この判定は素通り＝全てが本当の被りとして出る（それが正しい）。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NOISE_DB = process.env.NOISE_DB || '-40dB';
const MIN_SIL = Number(process.env.MIN_SIL || 0.2);
const MIN_OVERLAP = Number(process.env.MIN_OVERLAP || 0.4); // これより短い被りは無視(相槌等)
const BLEED_MARGIN = Number(process.env.BLEED_MARGIN || 9); // dB差がこれ以上なら小さい方はかぶりと判定

function duration(file) {
  return Number(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }).stdout.trim()
  );
}

function silenceSpans(file, total) {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=n=${NOISE_DB}:d=${MIN_SIL}`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const spans = [];
  let open = null;
  for (const line of res.stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) {
      spans.push([open, Number(e[1])]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, total]);
  return spans;
}

// 無音区間の補集合 = 発話区間
function invert(spans, total) {
  const out = [];
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s > cursor) out.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < total) out.push([cursor, total]);
  return out;
}

function intersectPair(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (lo < hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

// 指定区間の平均音量(dB)を測る = かぶりか実発話かの判定材料
function meanDb(file, start, end) {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-ss', String(start), '-to', String(end), '-i', file,
     '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const m = res.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : -99;
}

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error('usage: node overlap.js <track1> <track2> [track3...]');
  process.exit(1);
}

const names = files.map(f => path.basename(f, path.extname(f)));
const durations = files.map(duration);
const total = Math.min(...durations);
const speech = files.map((f, i) => invert(silenceSpans(f, durations[i]), durations[i]));

// 全ペアの発話区間の重なりを取る
const overlaps = [];
for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    for (const [s, e] of intersectPair(speech[i], speech[j])) {
      if (e - s < MIN_OVERLAP) continue;
      const dbA = meanDb(files[i], s, e);
      const dbB = meanDb(files[j], s, e);
      const diff = dbA - dbB;
      let judgement;
      if (diff >= BLEED_MARGIN) judgement = `${names[j]} はマイクかぶりの可能性（${names[i]} が主）`;
      else if (diff <= -BLEED_MARGIN) judgement = `${names[i]} はマイクかぶりの可能性（${names[j]} が主）`;
      else judgement = '本当の被り（どちらを残すか要判断）';
      overlaps.push({
        start: +s.toFixed(3),
        end: +e.toFixed(3),
        seconds: +(e - s).toFixed(3),
        tracks: [names[i], names[j]],
        levelsDb: [+dbA.toFixed(1), +dbB.toFixed(1)],
        diffDb: +diff.toFixed(1),
        judgement,
      });
    }
  }
}
overlaps.sort((a, b) => a.start - b.start);

const real = overlaps.filter(o => o.judgement.startsWith('本当'));
const report = {
  files: names,
  total: +total.toFixed(3),
  params: { NOISE_DB, MIN_OVERLAP, BLEED_MARGIN },
  overlapCount: overlaps.length,
  needsHumanDecision: real.length,
  overlaps,
};

// Audacity のラベルトラック形式(タブ区切り)でも出力 → 被り箇所へジャンプして確認できる
const labels = overlaps.map(o => `${o.start}\t${o.end}\t${o.tracks.join('x')} ${o.judgement}`).join('\n');
if (process.env.LABELS_OUT) fs.writeFileSync(process.env.LABELS_OUT, labels + '\n');

console.log(JSON.stringify(report, null, 2));
