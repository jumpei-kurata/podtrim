#!/usr/bin/env node
// カット適用（本命の実装）。
// ffmpeg のフィルタ式は区間が数百になると破綻する（分岐版は激遅・単一式版はパーサが落ちる）。
// ここでは ffmpeg を「デコード/エンコードだけ」に使い、切り貼りは Node が生の PCM に対して行う。
//  - サンプル単位の一致が構造的に保証される（全トラックで同じサンプル番号を使うため）
//  - 区間数に上限がない / 速い（I/O律速）
//
// 元素材の品質は勝手に下げない。入力のサンプルレート・チャンネル数・ビット深度を保つ。
// 中間表現は s32le（32bit整数）で、24bit までを損失なく保持できる。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requireSameFormat, wavCodecFor } = require('./format');

// 継ぎ目のマイクロフェード(ms)。実測では 5ms でも低域(55Hz級)のクリックが残るため既定は 10ms。
// 5ms は許容下限。ゼロクロス点を探す方式は併用しても利得がないので採らない。
const FADE_MS = Number(process.env.FADE_MS || 10);
const BYTES = 4; // 中間表現 s32le の1サンプルあたりバイト数

const planPath = process.argv[2];
const outDir = process.argv[3];
if (!planPath || !outDir) {
  console.error('usage: node apply.js <cuts.json> <outDir>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const { files, cuts, total } = plan;
fs.mkdirSync(outDir, { recursive: true });

// 入力のフォーマットを確認して揃える。レート/チャンネル数が違うと
// 同じサンプル番号で切っても実時間がずれて同期が壊れるのでここで弾く。
const fmt = requireSameFormat(files);
const RATE = fmt.rate;
const CH = fmt.channels;
const FRAME = BYTES * CH; // 1フレーム = 全チャンネル分。ここを間違えるとL/Rが入れ替わる

// 残す区間（秒）→ サンプル番号。全トラックで同じ値を使うので同期は構造的に保証される
const keepSec = [];
let cursor = 0;
for (const [s, e] of cuts) {
  if (s > cursor) keepSec.push([cursor, s]);
  cursor = e;
}
if (cursor < total) keepSec.push([cursor, total]);
const keep = keepSec.map(([s, e]) => [Math.round(s * RATE), Math.round(e * RATE)]);

const results = [];
for (const f of files) {
  const rawIn = path.join(outDir, '_in.raw');
  const rawOut = path.join(outDir, '_out.raw');

  // 1) デコード（フォーマットは保ったまま生PCMへ）
  let res = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', f,
     '-ac', String(CH), '-ar', String(RATE), '-f', 's32le', rawIn],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) throw new Error(`decode failed: ${f}\n${res.stderr}`);

  // 2) 切り貼りは Node がバイト列に対して行う
  const src = fs.readFileSync(rawIn);

  // Buffer.subarray は範囲外を例外なく静かに切り詰める。1本でも短いファイルが混ざると
  // エラーも出さずに短い成果物が出来上がり、同期が黙って壊れる。ここで明示的に弾く。
  const lastSample = keep.length ? keep[keep.length - 1][1] : 0;
  const availSamples = Math.floor(src.length / FRAME);
  if (availSamples < lastSample) {
    throw new Error(
      `${path.basename(f)} が短すぎます: ${availSamples} サンプルしかないのに` +
        `カットリストは ${lastSample} サンプル目まで要求しています` +
        `（不足 ${lastSample - availSamples} サンプル / 約 ${((lastSample - availSamples) / RATE).toFixed(3)} 秒）。\n` +
        `カットリストを作った時と同じ音源を指定しているか確認してください。`
    );
  }

  const totalSamples = keep.reduce((a, [s, e]) => a + (e - s), 0);
  const fd = fs.openSync(rawOut, 'w');
  const fade = Math.round((FADE_MS / 1000) * RATE);
  let written = 0;

  for (const [s, e] of keep) {
    const from = s * FRAME;
    const to = e * FRAME;
    if (to <= from) continue;
    const seg = Buffer.from(src.subarray(from, to)); // コピーして元データを壊さない
    const n = seg.length / FRAME;
    // 継ぎ目のクリック音対策: 各断片の先頭と末尾を数ms だけフェードする（全チャンネルに適用）
    const fn = Math.min(fade, Math.floor(n / 2));
    for (let i = 0; i < fn; i++) {
      const g = i / fade;
      for (let c = 0; c < CH; c++) {
        const head = i * FRAME + c * BYTES;
        seg.writeInt32LE(Math.round(seg.readInt32LE(head) * g), head);
        const tail = (n - 1 - i) * FRAME + c * BYTES;
        seg.writeInt32LE(Math.round(seg.readInt32LE(tail) * g), tail);
      }
    }
    fs.writeSync(fd, seg);
    written += n;
  }
  fs.closeSync(fd);
  if (written !== totalSamples) {
    throw new Error(`書き出したサンプル数(${written})が計算値(${totalSamples})と一致しません。`);
  }

  // 3) エンコード（元のビット深度を保つ）
  const outFile = path.join(outDir, path.basename(f, path.extname(f)) + '_cut.wav');
  res = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-f', 's32le', '-ar', String(RATE), '-ac', String(CH), '-i', rawOut,
     '-c:a', wavCodecFor(fmt.bits), outFile],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) throw new Error(`encode failed: ${outFile}\n${res.stderr}`);

  fs.unlinkSync(rawIn);
  fs.unlinkSync(rawOut);
  results.push({ out: path.basename(outFile), samples: written, duration: +(written / RATE).toFixed(6) });
}

const unique = [...new Set(results.map(r => r.samples))];
// 長さが揃わない = 会話がずれた成果物。報告するだけでなく落とす（黙って渡さない）。
if (unique.length !== 1) {
  console.error(JSON.stringify({ outputs: results, uniqueSampleCounts: unique }, null, 2));
  throw new Error('出力の長さが揃いませんでした。同期が壊れているため成果物として使えません。');
}

console.log(
  JSON.stringify(
    {
      format: { rate: RATE, channels: CH, bits: fmt.bits, codec: wavCodecFor(fmt.bits) },
      keepSegments: keep.length,
      cutSegments: cuts.length,
      outputs: results,
      sampleAccurateSync: true,
      samples: unique[0],
    },
    null,
    2
  )
);
