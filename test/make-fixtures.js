#!/usr/bin/env node
// 検証用の合成音源を作る。実音源が手元に無くても回帰テストを回せるようにするため。
//
//   node test/make-fixtures.js sameroom  → 3人が同室で録音した想定
//   node test/make-fixtures.js remote    → 3人が別々の場所で録音した想定
//   node test/make-fixtures.js decoy     → リモート＋拍手と紛らわしい音が入った想定
//   node test/make-fixtures.js remote5   → 5人が別々の場所で録音した想定（ゲストを呼んだ回・既定10分。倉田さん「ゲストをさ、一人呼んで
//                                          さ、録音が4つになったとしても使えるの？」「行っても4本か5本」・2026-10-19）
//
// この2つは同期の効く原理が違うので、両方で通ることを必ず確認する:
//   同室   … 共通の「1回の拍手」が3本に入る。波形照合と部屋の音の相関が効く
//   リモート … 各自が自分の手を叩く＝波形は別物。他人の声も入らない。
//             使えるのは「拍手が鳴った時刻」と「会話が譲り合っていること」だけ
// decoy は実音源（2026-10-17・守りのトークン抑え回）で起きたことの再現:
//   M1 … 拍手の前に、机やマイクに触れたような音（拍手に近い大きさ・余韻が長い）
//   M3 … 話の途中に、拍手より大きい短い音（直前に息や笑いのような高域の音がある）
//
// ffmpeg の volume 式ではなく Node で直接 PCM を書く（式パーサに数百ターンの会話は載らない）。

const fs = require('fs');
const path = require('path');

const MODE = process.argv[2];
if (!['sameroom', 'remote', 'decoy', 'remote5'].includes(MODE)) {
  console.error('usage: node test/make-fixtures.js <sameroom|remote|decoy|remote5>');
  process.exit(1);
}
const REMOTE = MODE !== 'sameroom';

const RATE = 44100;
const DUR = Number(process.env.FIXTURE_DUR || (MODE === 'remote5' ? 600 : 1800)); // 既定30分（5人は10分）
const N = DUR * RATE;
const OUT = path.join(__dirname, 'fixtures', MODE);
fs.mkdirSync(OUT, { recursive: true });

// 決定論的な擬似乱数（Math.random は使わない＝毎回同じ素材が出る）
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function reseed(s) { seed = s; }

function writeWav(file, data) {
  const b = Buffer.alloc(44 + data.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data.length * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data.length * 2, 40);
  let clipped = 0;
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (v > 1 || v < -1) { clipped++; v = Math.max(-1, Math.min(1, v)); }
    b.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
  }
  // クリップすると広帯域の歪みが乗り、拍手より鋭い偽の物音が大量に生まれて
  // 手拍子検出が壊れる。素材の不備でテストが落ちるのを防ぐため必ず知らせる。
  if (clipped > 0) console.warn(`  警告: ${path.basename(file)} で ${clipped} サンプルがクリップしました（振幅を下げてください）`);
  fs.writeFileSync(file, b);
}

// 声らしい音（低域寄りのノイズ + 音節変調）を書き込む
function addSpeech(buf, startSec, lenSec, freq, amp) {
  const s = Math.round(startSec * RATE);
  const n = Math.round(lenSec * RATE);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    if (s + i >= buf.length || s + i < 0) continue;
    lp = lp * 0.92 + (rnd() * 2 - 1) * 0.08;
    const syll = 0.3 + 0.7 * Math.abs(Math.sin(2 * Math.PI * freq * (i / RATE)));
    const env = Math.pow(Math.sin(Math.PI * Math.min(i / n, 1)), 0.3);
    buf[s + i] += lp * 1.6 * syll * env * amp;
  }
}

// 拍手（広帯域の短いバースト）。skip を変えると別の波形になる＝別の手・別の部屋
function addClap(buf, atSec, amp, skip) {
  const save = seed;
  reseed(999 + skip);
  const s = Math.round(atSec * RATE);
  const n = Math.round(0.02 * RATE);
  for (let i = 0; i < n; i++) {
    if (s + i >= buf.length || s + i < 0) continue;
    buf[s + i] += (rnd() * 2 - 1) * amp * Math.exp(-i / (RATE * 0.004));
  }
  reseed(save);
}

// 机やマイクに触れた音（広帯域・余韻が長い）。拍手は4msで消えるが、これは80msかけて消える
function addThump(buf, atSec, amp) {
  const save = seed;
  reseed(31337);
  const s = Math.round(atSec * RATE);
  const n = Math.round(0.4 * RATE);
  for (let i = 0; i < n; i++) {
    if (s + i >= buf.length || s + i < 0) continue;
    buf[s + i] += (rnd() * 2 - 1) * amp * Math.exp(-i / (RATE * 0.08));
  }
  reseed(save);
}

// 息や笑いのような高域の多い音（白色雑音）
function addHiss(buf, atSec, lenSec, amp) {
  const s = Math.round(atSec * RATE);
  const n = Math.round(lenSec * RATE);
  for (let i = 0; i < n; i++) {
    if (s + i >= buf.length || s + i < 0) continue;
    buf[s + i] += (rnd() * 2 - 1) * amp;
  }
}

const CLAP_AT = 3.0;
const people =
  REMOTE
    ? [
        // リモート: 拍手のタイミングに人間＋回線の誤差(jitter)が乗る。拍手の波形も各自別
        { name: 'M1', offsetMs: 0, jitterMs: 0, freq: 4.7, clapSkip: 0 },
        { name: 'M2', offsetMs: 1234, jitterMs: 35, freq: 5.3, clapSkip: 7919 },
        { name: 'M3', offsetMs: 2567, jitterMs: -50, freq: 4.1, clapSkip: 15731 },
        // 5人の回（ゲスト2人）だけ。3人の回の素材は変えない
        ...(MODE === 'remote5' ? [
          { name: 'M4', offsetMs: 3891, jitterMs: 20, freq: 5.9, clapSkip: 23459 },
          { name: 'M5', offsetMs: 812, jitterMs: -30, freq: 3.7, clapSkip: 27191 },
        ] : []),
      ]
    : [
        // 同室: 拍手は「1回の同じ音」なので jitter も波形違いも無い
        { name: 'T1', offsetMs: 0, jitterMs: 0, freq: 4.7, clapSkip: 0 },
        { name: 'T2', offsetMs: 1234, jitterMs: 0, freq: 5.3, clapSkip: 0 },
        { name: 'T3', offsetMs: 2567, jitterMs: 0, freq: 4.1, clapSkip: 0 },
      ];

// --- 会話の台本: 基本は1人ずつ喋り、たまに短く被る（＝譲り合い構造）。3人の時は前と同じ乱数の使い方（素材を変えない） ---
const NP = people.length;
reseed(12345);
const turns = [];
{
  let t = 4.0;
  let prev = -1;
  while (t < DUR - 10) {
    let who = Math.floor(rnd() * NP);
    if (who === prev) who = (who + 1) % NP;
    const len = 3 + rnd() * 9;
    turns.push({ who, start: t, len });
    if (rnd() < 0.25) {
      const other = (who + 1 + Math.floor(rnd() * (NP - 1))) % NP;
      turns.push({ who: other, start: t + len * (0.3 + rnd() * 0.4), len: 0.4 + rnd() * 0.6 });
    }
    t += len + 0.3 + rnd() * 2.5;
    prev = who;
  }
}
console.log(`[${MODE}] 会話ターン数: ${turns.length}`);

people.forEach((p, idx) => {
  reseed(4242 + idx * 1000);
  const buf = new Float64Array(N);
  const shift = p.offsetMs / 1000;

  for (const tn of turns) {
    if (tn.who === idx) {
      addSpeech(buf, tn.start + shift, tn.len, p.freq, 0.55);
    } else if (MODE === 'sameroom') {
      // 同室なら他人の声も自分のマイクに小さく入る（これが相関の手がかりになる）
      addSpeech(buf, tn.start + shift, tn.len, people[tn.who].freq, 0.12);
    }
  }
  addSpeech(buf, CLAP_AT - 1.0 + p.jitterMs / 1000 + shift, 0.6, 3.0, 0.6); // 「よーおっ」
  addClap(buf, CLAP_AT + p.jitterMs / 1000 + shift, 0.85, p.clapSkip);
  if (MODE === 'decoy' && idx === 0) {
    addThump(buf, CLAP_AT - 2.0 + shift, 0.75); // 拍手の2秒前・拍手に近い大きさ
  }
  if (MODE === 'decoy' && idx === 2) {
    // 30秒より後でこの人が話し終わった直後に「息＋拍手より大きい短い音」（話の途中の笑い・物音）
    const tn = turns.find(t => t.who === 2 && t.start > 30);
    const at = tn.start + tn.len + shift + 0.2;
    addHiss(buf, at, 0.3, 0.15);
    addClap(buf, at + 0.3, 0.95, 4242);
  }

  writeWav(path.join(OUT, `${p.name}.wav`), buf);
  const truth = -(p.offsetMs / 1000 + p.jitterMs / 1000);
  console.log(`  ${p.name}.wav  揃うべきオフセット = ${truth.toFixed(4)}s`);
});

// 期待値をファイルに残す（回帰テストが読む）
const expected = {};
people.forEach(p => { expected[`${p.name}.wav`] = -(p.offsetMs / 1000 + p.jitterMs / 1000); });
fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify({ mode: MODE, expected }, null, 2));
console.log(`  → ${OUT}`);
