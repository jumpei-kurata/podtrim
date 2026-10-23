#!/usr/bin/env node
// 編集アプリの「回」（プロジェクト）を作る。自動編集の結果（cuts.json）から、画面で使うデータを用意する。
//
//   node ui/prep.js <cuts.json> <回のID> [表示名] [--sync <sync.json>] [--bgm <BGMの音源>] [--cm <CMの音源>] [--pending <番号,…>]
//
// --sync を渡すと、生の録音の場所と頭揃えのずれを回に記録する（書き出しの時に頭揃えをやり直せるように。
// cuts.json が指す頭揃え済みの音源は一時フォルダにあることが多く、後で消えうる）。
// --pending は、頭揃えが自動で決まらなかった録音の番号（ui/import.js）。回に alignPending として残し、画面が「頭を揃える」窓を開く。
// 揃っていない間は、手拍子より前を切らず、被りも探さない（揃えた後に ui/import.js が作り直す）。
//
// 作るもの（<回のデータの置き場所>/<回のID>/。置き場所は ui/data-dir.js）:
//  - voices.wav   … 声のトラックを1つのファイルの別々のチャンネルに入れた再生用（16kHz）。
//                    1つのファイルを1回再生するので、何人いても絶対にずれない。
//                    （<audio> を人数分並べて同時に鳴らすと、ブラウザ側で少しずつずれる）
//                    画面側でチャンネルを分け、ミュート・ソロ・音量を人ごとに効かせる
//  - peaks-N.bin  … 波形表示用（1秒200点・0〜255）。拡大しても形が崩れない細かさにしてある
//  - bgm.mp3 / cm.mp3 … BGM と CM の試聴用（軽くしたもの。書き出しには元の音源を使う）
//  - project.json … 回の情報（元の音源・カット候補・被りの候補・BGM/CM の設定・話し声の大きさ・全員が黙っている所）
// 元の音源は読むだけ。編集の状態（どこを切ったか等）は画面が state.json に保存する。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const DATA = require('./data-dir');
const { analyzeProject } = require('./analyze-project');

const PEAKS_PER_SEC = 200;
const PEAK_DECODE_RATE = 8000;
const VOICE_RATE = 16000;
const PREVIEW_RATE = 22050;

const positional = [];
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
  else positional.push(a);
}
const [planPath, id, displayName] = positional;
if (!planPath || !id || !/^[\w.-]+$/.test(id)) {
  console.error('usage: node ui/prep.js <cuts.json> <回のID（英数字・-_.）> [表示名] [--sync <sync.json>] [--bgm <BGM>] [--cm <CM>] [--pending <番号,…>]');
  process.exit(1);
}
const pending = opts.pending ? opts.pending.split(',').map(Number).filter(Number.isInteger) : [];

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const outDir = path.join(DATA, id);
fs.mkdirSync(outDir, { recursive: true });

// 生の録音の場所と頭揃えのずれ（sync.json の results）。頭揃え済みのファイル名は「元の名前_sync.wav」
let sources = null, sync = null;
if (opts.sync) {
  sync = JSON.parse(fs.readFileSync(opts.sync, 'utf8'));
  const byName = new Map(sync.results.map(r => [path.basename(r.file, path.extname(r.file)), { file: sync.resolved[r.file], offset: r.offsetSeconds || 0 }]));
  sources = plan.files.map(f => byName.get(path.basename(f, path.extname(f)).replace(/_sync$/, '')) || null);
  if (sources.some(s => !s)) throw new Error('--sync の中に、cuts.json の音源に当たる録音が見つかりません');
}

// 頭揃えの手拍子より前（収録前の話・「よーおっ」・手拍子とその余韻）を切る（倉田さん「揃えた後、その拍手をパンしたとこからの
// 左側って全部消していいよ。無音区間を削除するのと一緒のタイミングで。デフォルトで」・2026-10-18）。頭を揃えた後は、全員の手拍子が
// 基準の録音の手拍子の時刻（results[0].clapAt）にそろう。はっきりした手拍子で揃えた時だけ切る（拍手らしい音が見つからなかった時の
// clapAt は「高い音が一番大きい所」で、話の途中のこともあるため）。手拍子の後 CLAP_TAIL 秒（余韻）まで切る
const CLAP_TAIL = 0.3;
let headCut = 0;
if (sync && !pending.length) {
  const ref = sync.results[0];
  const clear = sync.results.slice(1).some(r => r.clapClear);
  if (ref && ref.syncClap && clear && Number.isFinite(ref.clapAt)) headCut = Math.min(plan.total, +(ref.clapAt + CLAP_TAIL).toFixed(3));
}

function ffmpeg(args, opts = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args],
    { maxBuffer: 1024 * 1024 * 1024, encoding: opts.binary ? 'buffer' : 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

function duration(file) {
  return Number(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }).stdout.trim()
  );
}

// --- 声: 人数分のチャンネルを持つ1つの WAV にまとめる ---
// チャンネルの並び方は明示する。amerge に任せると3人の時に「2.1」（3つ目が重低音用）になり、
// 再生側で3人目が重低音として扱われるおそれがある。
// さらに join の割り当ても明示する（map）。任せると、モノラル＝「中央」の名前が一致する
// 中央チャンネルに1人目が入り、順番が入れ替わった（3人の回で実際に起きた）
const LAYOUTS = {
  2: ['stereo', ['FL', 'FR']],
  3: ['3.0', ['FL', 'FR', 'FC']],
  4: ['4.0', ['FL', 'FR', 'FC', 'BC']],
  5: ['5.0', ['FL', 'FR', 'FC', 'BL', 'BR']],
  6: ['6.0', ['FL', 'FR', 'FC', 'BC', 'SL', 'SR']],
  7: ['7.0', ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR']],
  8: ['octagonal', ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR']],
};
const N = plan.files.length;
if (!LAYOUTS[N]) throw new Error(`声のトラックは2〜8本にしてください（今は${N}本）`);
{
  const [layout, chans] = LAYOUTS[N];
  const map = chans.map((ch, i) => `${i}.0-${ch}`).join('|');
  const inputs = plan.files.flatMap(f => ['-i', f]);
  const filter =
    plan.files.map((_, i) => `[${i}:a]aformat=channel_layouts=mono[m${i}]`).join(';') + ';' +
    plan.files.map((_, i) => `[m${i}]`).join('') + `join=inputs=${N}:channel_layout=${layout}:map=${map}[out]`;
  ffmpeg(['-y', ...inputs, '-filter_complex', filter, '-map', '[out]',
    '-t', plan.total.toFixed(3), '-ar', String(VOICE_RATE), '-c:a', 'pcm_s16le',
    path.join(outDir, 'voices.wav')]);
  console.error(`  voices.wav（${N}チャンネル）を作成`);
}

// --- 波形 ---
const tracks = plan.files.map((f, i) => {
  const buf = ffmpeg(['-i', f, '-ac', '1', '-ar', String(PEAK_DECODE_RATE), '-f', 'f32le', '-'], { binary: true });
  // spawnSync の Buffer は4バイト境界に揃っているとは限らないので、揃った領域へ写してから読む
  const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
  const block = PEAK_DECODE_RATE / PEAKS_PER_SEC;
  const peaks = new Uint8Array(Math.ceil(samples.length / block));
  for (let b = 0; b < peaks.length; b++) {
    let p = 0;
    const end = Math.min((b + 1) * block, samples.length);
    for (let k = b * block; k < end; k++) {
      const v = samples[k] < 0 ? -samples[k] : samples[k];
      if (v > p) p = v;
    }
    peaks[b] = Math.min(255, Math.round(p * 255));
  }
  fs.writeFileSync(path.join(outDir, `peaks-${i}.bin`), Buffer.from(peaks.buffer));
  const name = path.basename(f, path.extname(f)).replace(/_sync$/, '');
  console.error(`  ${name} → peaks-${i}.bin（${peaks.length}点）`);
  // file は頭揃え済みの音源（一時フォルダのことが多い）。source は生の録音と頭揃えのずれ（--sync がある時）
  return { name, file: path.resolve(f), source: sources ? sources[i] : null, peaks: `peaks-${i}.bin`, channel: i };
});

// --- BGM・CM の試聴用 ---
function preview(src, out, maxSec) {
  const t = maxSec ? ['-t', String(maxSec)] : [];
  ffmpeg(['-y', '-i', src, ...t, '-ac', '1', '-ar', String(PREVIEW_RATE), '-b:a', '64k', path.join(outDir, out)]);
  return duration(path.join(outDir, out));
}

// --- 被りの候補（どちらの声を残すかは人が決める。ここでは場所を教えるだけ） ---
// src/overlap.js の結果を、トラックの番号で引けるように直して持つ
// 被りの検出に失敗しても、回は作る（印が出ないだけで編集はできる）
let overlaps = [];
if (pending.length) {
  console.error('  頭揃え待ちなので、被りはまだ探しません（揃えた後に探します）');
} else {
  // 今動いている Node で動かす（Mac のアプリから動かした時は、ターミナルの node が無いため）
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'overlap.js'), ...plan.files],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`  警告: 被りの検出に失敗しました（被りの印なしで作ります）\n${r.stderr.slice(0, 300)}`);
  } else {
    const report = JSON.parse(r.stdout);
    const index = new Map(plan.files.map((f, i) => [path.basename(f, path.extname(f)), i]));
    overlaps = report.overlaps.map(o => ({ start: o.start, end: o.end, tracks: o.tracks.map(n => index.get(n)) }));
    console.error(`  被りの候補 ${overlaps.length}か所（1秒以上 ${overlaps.filter(o => o.end - o.start >= 1).length}）`);
  }
}

let bgm = null;
if (opts.bgm) {
  // 本編より長い分は要らない（足りなければ画面側で繰り返す）
  const d = preview(opts.bgm, 'bgm.mp3', Math.ceil(plan.total) + 60);
  // 頭 2秒でフェードイン・終わり 3秒でフェードアウト（倉田さん「一番最後の音楽は…終わりの3秒前ぐらいから…フェードアウト気味に」・
  // 2026-10-18）。画面で塊の上の角を引いて変えられる
  bgm = { file: path.resolve(opts.bgm), preview: 'bgm.mp3', duration: d, volume: 0.12, fadeIn: 2, fadeOut: 3 };
  console.error(`  bgm.mp3 を作成（${d.toFixed(1)}秒）`);
}
let cm = null;
if (opts.cm) {
  const d = preview(opts.cm, 'cm.mp3');
  // 本編の終わりの 0.5秒前から重ねて、2秒でフェードイン（倉田さん「CM に関しては、少しだけ最後の音源の部分とかぶせて、フェードイン
  // していく形、まあ、2秒ぐらいで、デフォルトで勝手に設定するように」・2026-10-18。前は本編の 0.5秒後から・フェードなし。
  // 2026-10-19 に重ねるのを 2秒前 → 0.5秒前に: 倉田さん「ちょっとかぶりすぎかも。本当にちょっとだけかぶせるぐらいでいいかも…
  // 1秒もしくは 0.5 秒とかかな」。かいちさん・のりさんのつもりで作った回で、倉田さんが合わせたのが 0.52秒前だった）
  cm = { file: path.resolve(opts.cm), preview: 'cm.mp3', duration: d, gap: -0.5, fadeIn: 2 };
  console.error(`  cm.mp3 を作成（${d.toFixed(1)}秒）`);
}

const project = {
  // 2: 最初の値（BGM 終わり3秒でフェードアウト・CM は本編の終わりの2秒前から重ねて2秒でフェードイン）と、手拍子より前を切る所が
  // 入った回（2026-10-18〜）。新しい回は、version 2 以上の回からだけ前の回の設定を引き継ぐ（ui/serve.js の inheritFor）
  version: 2,
  id,
  name: displayName || id,
  createdAt: new Date().toISOString(),
  duration: plan.total,
  peaksPerSec: PEAKS_PER_SEC,
  voices: 'voices.wav',
  tracks,
  // origin: 'auto'＝無音を詰めた所（画面の「間を詰める」つまみで作り直す）・'head'＝手拍子より前（つまみでは作り直さない）
  cuts: [
    ...(headCut > 0 ? [{ start: 0, end: headCut, enabled: true, origin: 'head' }] : []),
    ...plan.cuts.map(([s, e]) => ({ start: s, end: e, enabled: true, origin: 'auto' })),
  ],
  // 自動編集の決まり（画面の「間を詰める」つまみが、同じ決まりで切る所を作り直すのに使う）
  autoParams: plan.params ? { noiseDb: parseFloat(plan.params.NOISE_DB), pad: Number(plan.params.PAD), minCut: Number(plan.params.MIN_CUT) } : null,
  overlaps,
  bgm,
  cm,
  loudness: -16,
  ...(pending.length ? { alignPending: pending } : {}),
};
// 作り直す時、前の編集の状態は消さずに退避する（カットや人数が変わると、そのままでは合わない）。
// 作り終えてから退避するので、途中で失敗しても前の回と編集の状態はそのまま残る
if (fs.existsSync(path.join(outDir, 'state.json'))) {
  fs.renameSync(path.join(outDir, 'state.json'), path.join(outDir, 'state.json.old'));
  console.error('  前の編集の状態は state.json.old に退避しました（新しい回は自動編集の結果から始まります）');
}
fs.writeFileSync(path.join(outDir, 'project.json'), JSON.stringify(project, null, 2));
// 人ごとの話し声の大きさと、全員が黙っている所（画面の「声をそろえる」と「間を詰める」が使う）。
// 測れなくても回は使える（その2つのボタンが押せないだけ）
try {
  const p = analyzeProject(outDir);
  console.error(`  話し声の大きさ ${p.tracks.map(t => `${t.speechDb}dB`).join(' / ')}・全員が黙っている所 ${p.silences.length}か所`);
} catch (e) {
  console.error(`  警告: 声の大きさと間を測れませんでした（あとで node ui/analyze-project.js ${id} で足せます）\n${String(e.message).slice(0, 300)}`);
}
if (headCut > 0) console.error(`  手拍子より前を切ります（頭から ${headCut.toFixed(2)}秒）`);
console.error(`project.json: ${N}トラック / ${project.cuts.length}カット / ${project.duration.toFixed(1)}秒 → ${outDir}`);
