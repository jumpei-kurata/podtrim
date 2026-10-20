#!/usr/bin/env node
// 仕上げ。カット済みの声トラックに BGM と CM を乗せて、配信用の1本にする。
// GarageBand で毎回やっている最後の工程をそのまま再現する。
//
//   node src/mixdown.js <cuts.json> <cutDir> <出力.wav> [設定.json]
//
// 毎回まったく同じ構造（声N本 + BGM + 末尾CM）なので、汎用の編集ソフトは要らない。
// 決まった型に対して数値を渡すだけにしてある。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { probe, wavCodecFor } = require('./format');

// 既定は「BGMもCMも焼き込まない」。
// 成果物を GarageBand に戻して仕上げる運用では、BGMが焼き込まれていると
// 後から動かしたくなった時に邪魔になる（倉田さんの判断・2026-08-13）。
// BGM/CM を入れるのは、このツールだけで完結させると決めた時だけにする。
const DEFAULTS = {
  bgm: null,            // BGM音源のパス。null なら入れない
  bgmVolume: 0.12,      // 声に対するBGMの音量比
  bgmFadeIn: 2,         // 冒頭のフェードイン(秒)
  bgmFadeOut: 0,        // 末尾のフェードアウト(秒)。0で無し（不要との判断）
  cm: null,             // 末尾に足すCM音源。null なら足さない
  cmGap: 0.5,           // 本編とCMの間(秒)
  loudness: -16,        // 仕上げのラウドネス(LUFS)。Apple Podcasts の公式要件
};

const planPath = process.argv[2];
const cutDir = process.argv[3];
const outFile = process.argv[4];
const cfgPath = process.argv[5];
if (!planPath || !cutDir || !outFile) {
  console.error('usage: node src/mixdown.js <cuts.json> <cutDir> <out.wav> [config.json]');
  process.exit(1);
}

const cfg = { ...DEFAULTS, ...(cfgPath ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}) };
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

// apply.js が書いたカット済みトラックを拾う
const voices = plan.files.map(f => {
  const p = path.join(cutDir, path.basename(f, path.extname(f)) + '_cut.wav');
  if (!fs.existsSync(p)) throw new Error(`カット済みトラックが見つかりません: ${p}\n先に apply.js を実行してください。`);
  return p;
});

const fmt = probe(voices[0]);
const talkDur = Number(
  spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voices[0]],
    { encoding: 'utf8' }).stdout.trim()
);

function dur(f) {
  return Number(
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }).stdout.trim()
  );
}

// --- BGM: 本編の長さに合わせる。足りなければ繰り返す ---
const bgmDur = fs.existsSync(cfg.bgm) ? dur(cfg.bgm) : 0;
if (cfg.bgm && !bgmDur) throw new Error(`BGM が読めません: ${cfg.bgm}`);
const needLoop = bgmDur > 0 && bgmDur < talkDur;

const inputs = [];
const filters = [];
let n = 0;

for (const v of voices) { inputs.push('-i', v); n++; }
const voiceIdx = voices.map((_, i) => `[${i}:a]`).join('');
filters.push(`${voiceIdx}amix=inputs=${voices.length}:duration=longest:normalize=0[talk]`);

let lastLabel = 'talk';
if (cfg.bgm && bgmDur > 0) {
  // 足りない時だけループさせる（BGMは51分あるので通常は不要）
  if (needLoop) inputs.push('-stream_loop', String(Math.ceil(talkDur / bgmDur)));
  inputs.push('-i', cfg.bgm);
  const bi = n++;
  // フェードは 0 を指定されたら filter 自体を出さない（d=0 は ffmpeg が受け付けない）
  const fades = [];
  if (cfg.bgmFadeIn > 0) fades.push(`afade=t=in:st=0:d=${cfg.bgmFadeIn}`);
  if (cfg.bgmFadeOut > 0) {
    fades.push(`afade=t=out:st=${Math.max(0, talkDur - cfg.bgmFadeOut).toFixed(3)}:d=${cfg.bgmFadeOut}`);
  }
  filters.push(
    `[${bi}:a]atrim=0:${talkDur.toFixed(3)},asetpts=N/SR/TB,` +
      `volume=${cfg.bgmVolume}` +
      (fades.length ? ',' + fades.join(',') : '') +
      `[bgm]`
  );
  filters.push(`[talk][bgm]amix=inputs=2:duration=first:normalize=0[body]`);
  lastLabel = 'body';
}

// --- CM: 本編の後ろに繋ぐ ---
if (cfg.cm) {
  if (!fs.existsSync(cfg.cm)) throw new Error(`CM が読めません: ${cfg.cm}`);
  inputs.push('-i', cfg.cm);
  const ci = n++;
  // 間を空けるため無音を挟む
  filters.push(`anullsrc=r=${fmt.rate}:cl=${fmt.channels === 1 ? 'mono' : 'stereo'}:d=${cfg.cmGap}[gap]`);
  filters.push(`[${ci}:a]aresample=${fmt.rate},aformat=channel_layouts=${fmt.channels === 1 ? 'mono' : 'stereo'}[cm]`);
  filters.push(`[${lastLabel}][gap][cm]concat=n=3:v=0:a=1[withcm]`);
  lastLabel = 'withcm';
}

// --- ラウドネス正規化（Apple Podcasts の要件 -16 LUFS / TP -1dB） ---
filters.push(`[${lastLabel}]loudnorm=I=${cfg.loudness}:TP=-1.0:LRA=11[out]`);

const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
  '-filter_complex', filters.join(';'), '-map', '[out]',
  '-c:a', wavCodecFor(fmt.bits), '-ar', String(fmt.rate), outFile];

const t0 = Date.now();
const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) throw new Error(`mixdown failed\n${r.stderr}`);

const outDur = dur(outFile);
console.log(
  JSON.stringify(
    {
      out: outFile,
      本編: `${Math.floor(talkDur / 60)}分${String(Math.round(talkDur % 60)).padStart(2, '0')}秒`,
      完成: `${Math.floor(outDur / 60)}分${String(Math.round(outDur % 60)).padStart(2, '0')}秒`,
      BGM: cfg.bgm ? `${path.basename(cfg.bgm)}（音量${cfg.bgmVolume} / 末尾${cfg.bgmFadeOut}秒フェード${needLoop ? ' / ループあり' : ''}）` : 'なし',
      CM: cfg.cm ? path.basename(cfg.cm) : 'なし',
      ラウドネス: `${cfg.loudness} LUFS`,
      形式: `${fmt.rate}Hz ${fmt.channels}ch ${fmt.bits}bit`,
      処理時間: `${((Date.now() - t0) / 1000).toFixed(1)}秒`,
    },
    null,
    2
  )
);
