#!/usr/bin/env node
// sync.js が出したオフセットを使って、3本の頭出しを揃えた新しいファイルを書く。
// 元ファイルは読むだけ。出力は別ディレクトリ。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { probe, wavCodecFor } = require('./format');

const syncJson = process.argv[2];
const outDir = process.argv[3];
if (!syncJson || !outDir) {
  console.error('usage: node align.js <sync.json> <outDir>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(syncJson, 'utf8'));

// 同期が確定していないトラックがあるまま先へ進むと、会話がずれた成果物が黙って出来上がる。
// ここで止めて、人間に判断させる。
const unresolved = plan.results.filter(r => r.role !== '基準' && (r.offsetSeconds === null || r.offsetSeconds === undefined));
if (unresolved.length) {
  console.error('同期が確定していないトラックがあります。先へ進みません:');
  for (const u of unresolved) {
    console.error(`  - ${u.file}: ${u.note || '要確認'}`);
    if (u.candidates) {
      console.error('    候補:');
      u.candidates.forEach((c, i) => console.error(
        `      ${i + 1}. offset=${c.offsetSeconds}s (手拍子 ${c.clapAt ?? '—'}s / 波形一致 ${c.localCorr} / 全編の相関 ${c.globalCorr})`));
    }
  }
  console.error('\nオフセットを手で決めて sync.json の offsetSeconds に入れてから再実行してください。');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

// offsetSeconds が負 = そのトラックは基準より遅れている → 先頭をその分カットして揃える
// 正 = 基準より早い → 先頭に無音を足して揃える
const results = [];
for (const r of plan.results) {
  const src = plan.resolved[r.file];
  const out = path.join(outDir, path.basename(r.file, path.extname(r.file)) + '_sync.wav');
  const off = r.offsetSeconds || 0;
  // 出力コーデックを指定しないと ffmpeg の既定で 16bit に落ちる。
  // 24bit素材が黙って劣化するので必ず元のビット深度に合わせる。
  const fmt = probe(src);

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (off < 0) {
    args.push('-ss', String(-off), '-i', src); // 遅れている分だけ頭を落とす
  } else if (off > 0) {
    args.push('-i', src, '-af', `adelay=${Math.round(off * 1000)}:all=1`); // 早い分だけ無音を足す
  } else {
    args.push('-i', src);
  }
  args.push('-c:a', wavCodecFor(fmt.bits), out);

  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${src}\n${res.stderr}`);
  results.push({ file: path.basename(out), appliedOffset: off, format: `${fmt.rate}Hz ${fmt.channels}ch ${fmt.bits}bit` });
}

console.log(JSON.stringify({ outDir, results }, null, 2));
