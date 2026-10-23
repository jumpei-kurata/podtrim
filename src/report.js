#!/usr/bin/env node
// 自動編集の結果を「人間が検品できる形」で出す。
//  1) 継ぎ目ラベル: カット後の音声のどこが継ぎ目かを示す。Audacity に読み込んで飛びながら確認できる
//  2) 捨てた音声: 削除した区間だけを繋いだファイル。「消しすぎてないか」を耳で確認できる
// これがあるので、自動編集を信用しなくても検品できる。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const planPath = process.argv[2];
const outDir = process.argv[3];
if (!planPath || !outDir) {
  console.error('usage: node report.js <cuts.json> <outDir>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const { files, cuts, total } = plan;
fs.mkdirSync(outDir, { recursive: true });

// --- 1) 継ぎ目ラベル（出力タイムライン上の位置） ---
// 元の時刻 t が出力側でどこに来るかを計算し、各カットの継ぎ目位置を出す
let shift = 0;
const seams = [];
for (const [s, e] of cuts) {
  const seamAt = s - shift; // 出力タイムライン上での継ぎ目
  shift += e - s;
  seams.push({ outputTime: +seamAt.toFixed(3), removedSeconds: +(e - s).toFixed(3), originalStart: +s.toFixed(3) });
}
const labelLines = seams.map(
  s => `${s.outputTime}\t${s.outputTime}\t継ぎ目 -${s.removedSeconds}s (元 ${s.originalStart}s)`
);
fs.writeFileSync(path.join(outDir, 'seams-labels.txt'), labelLines.join('\n') + '\n');

// --- 2) 捨てた音声を1本にまとめる（全トラックを重ねる） ---
// 以前は「全員無音の区間なので1本ぶんで十分」として1本目だけを出していたが、リモート録音では
// トラックごとに中身が別物。1本目以外の人の小さな声を切っていても、1本目だけでは聞いて気づけない。
// 重ねるのは amix の normalize=0（入力数で割らない）。割ると小さな音がさらに小さくなり聞き逃す。
let removedFile = null;
if (cuts.length) {
  const filter =
    files
      .map((_, k) =>
        cuts
          .map(([s, e], i) => `[${k}:a]atrim=start=${s.toFixed(6)}:end=${e.toFixed(6)},asetpts=PTS-STARTPTS[r${k}_${i}]`)
          .join(';') +
        ';' +
        cuts.map((_, i) => `[r${k}_${i}]`).join('') +
        `concat=n=${cuts.length}:v=0:a=1[c${k}]`)
      .join(';') +
    ';' +
    (files.length > 1
      ? files.map((_, k) => `[c${k}]`).join('') + `amix=inputs=${files.length}:normalize=0[out]`
      : '[c0]anull[out]');
  const fPath = path.join(outDir, '_removed_filter.txt');
  fs.writeFileSync(fPath, filter);
  removedFile = path.join(outDir, 'removed-audio.wav');
  // フィルタは切る所の数だけ長くなるので、引数に書かずファイルで渡す。ffmpeg 7 からは「-/filter_complex <ファイル>」で、
  // 前の -filter_complex_script は ffmpeg 9 で無くなった（2026-10-22）。6 以前は -/ を知らないので、その時だけ前の指定でやり直す
  const mix = opt => spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', ...files.flatMap(f => ['-i', f]),
     opt, fPath, '-map', '[out]', removedFile],
    { encoding: 'utf8' }
  );
  let res = mix('-/filter_complex');
  if (res.status !== 0 && /Unrecognized option/.test(res.stderr)) res = mix('-filter_complex_script');
  if (res.status !== 0) throw new Error(`ffmpeg failed\n${res.stderr}`);
}

const removedTotal = cuts.reduce((a, [s, e]) => a + (e - s), 0);
console.log(
  JSON.stringify(
    {
      seamCount: seams.length,
      removedSeconds: +removedTotal.toFixed(1),
      removedPercent: +((removedTotal / total) * 100).toFixed(1),
      originalDuration: +total.toFixed(1),
      outputDuration: +(total - removedTotal).toFixed(1),
      artifacts: {
        seamLabels: path.join(outDir, 'seams-labels.txt'),
        removedAudio: removedFile,
      },
      seams: seams.slice(0, 10),
    },
    null,
    2
  )
);
