#!/usr/bin/env node
// 書き出し: 編集画面の状態（切る所・消した所・人ごとの音量とミュート・BGM・CM）どおりに、ART19 に上げる1本を作る。
//
//   node ui/export.js <回のID> [--format wav|mp3] [--name <ファイルの名前>] [--out <書き出し先>] [--progress]
//   node ui/export.js <回のID> --voices-wav <声だけ.wav>   … 確かめる用: 3人の声を重ねただけ（音量合わせ・BGM・CM なし）
//   node ui/export.js <回のID> --voices-wav-edit <声だけ.wav> … 確かめる用: 編集どおり（人ごとの音量・消した所・一部分の音量・
//                                                             尻すぼみ）に3人の声を重ねただけ（音の大きさをそろえる前）
//
// 形は WAV（倉田さんの GarageBand の書き出しと同じ 44.1kHz・ステレオ・16bit）か MP3（192kbps・軽い）。
// 音の大きさは、書き出しの窓で選んだもの（編集の状態の exportLoudness）。選んでいなければ -16 LUFS（回の loudness）。
// 書き出し先は <書き出し先のフォルダ>/<ファイルの名前>.wav（.mp3・名前は窓で決める。無ければ回の名前）。フォルダは書き出しの窓の
// 「変更…」で選んだ所（この Mac で覚える・settings.json の exportDir）、決めていなければ ~/Documents/Podcast/書き出し
// （環境変数 HIMADAN_EXPORT は試す時用で、設定より先に効く）。
//
// - 声は生の録音から読み直す（画面で鳴らしている voices.wav は 16kHz で音が悪いので使わない）。
//   頭揃えは、回を作った時のずれ（tracks[].source.offset）をその場で当て直す（src/align.js と同じ ffmpeg の指定）。
// - 切り貼りは Node が行い、3人に同じサンプル番号を使う。だから声がずれることは構造的に起きない（src/apply.js と同じ考え方）。
// - 本編（声＋BGM）と CM は、別々に音の大きさを合わせてからつなぐ。CM は声より約10dB大きく作られていて
//   （守り回: CM -14.9 LUFS・3人の声 -24.8 LUFS）、まとめて合わせると CM だけがとても大きくなるため。
//   BGM を CM の下まで伸ばした時は、合わせた後の CM に、本編の終わりと同じ大きさで BGM の続きを重ねる。
// - ソロは書き出しに関係しない（全員入る）。ミュートした人・BGM・CM は入らない。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA = require('./data-dir');
const { readSettings } = require('./settings');

const RATE = 44100;
const FADE = Math.round(0.01 * RATE); // 継ぎ目と消した所の端の短いフェード（10ms・src/apply.js と同じ。無いとプツッと鳴る）
const GAIN_RAMP = 0.03; // 範囲を選んで音量を変えた時の、範囲の前後のなめらかに変える秒数（前の形を点に直す時も使う。画面の ui/index.html と同じ）
const GAIN_MIN = -24; // 音量の線の一番下＝無音（画面と同じ）
const dbGain = db => (db <= GAIN_MIN + 0.01 ? 0 : Math.pow(10, db / 20));
// 書き出し先のフォルダ（倉田さん「書き出し先のファインダーって自分で設定できるの？…カイチさんのりさんはそれぞれの自分の場所が
// あるじゃん？それ設定できた方が楽だよね」・2026-10-18）。試す時の HIMADAN_EXPORT → 画面で選んだ所 → 決まりの所
const DEFAULT_EXPORT_DIR = path.join(os.homedir(), 'Documents', 'Podcast', '書き出し');
const exportDir = () => process.env.HIMADAN_EXPORT || readSettings().exportDir || DEFAULT_EXPORT_DIR;
// 回の export.json の書き出しが、決まった書き出し先（書き出した時に選んでいたフォルダ）に書いた物か。試しに別の所へ書いた物は
// 使わない（画面の「前回の書き出し」「書き出し済み」と説明文づくり）。書き出し先を後で変えても、前の書き出しはそのまま使える
// （書き出した時のフォルダを dir に残す。dir の無い前の記録は、今の書き出し先で見る）
function isOwnExport(r) {
  if (!r || typeof r.out !== 'string') return false;
  const base = typeof r.dir === 'string' && r.dir ? r.dir : exportDir();
  return r.out.startsWith(base + path.sep);
}

// 「やめる」（サーバーからの SIGTERM）や Ctrl-C で止めた時に、動いている ffmpeg と書きかけのファイルを残さない
const running = new Set();
const leftovers = new Set();
function track(child) {
  running.add(child);
  child.on('close', () => running.delete(child));
  return child;
}
function stopAll() {
  for (const c of running) c.kill('SIGKILL');
  for (const p of leftovers) fs.rmSync(p, { recursive: true, force: true });
}

// 書き出しの形。WAV は今の GarageBand の書き出しと同じ（約400MB）。MP3 は軽い（約50MB）
const FORMATS = {
  wav: { ext: '.wav', label: 'WAV（44.1kHz・ステレオ・16bit）', args: ['-c:a', 'pcm_s16le', '-f', 'wav'] },
  mp3: { ext: '.mp3', label: 'MP3（192kbps・ステレオ）', args: ['-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'] },
};

// 書き出すファイルの名前（拡張子なし）。書き出しの窓の「ファイルの名前」で決める（回で覚える＝state の exportName。倉田さん
// 「書き出すときって一つのファイルとして書き出すんじゃないの？で、その時にさ、名前を決める感じにしたら、新しく」・2026-10-19）。
// / と : はファイル名に使えないので全角に。末尾の .wav・.mp3 は外す（形は窓で選ぶ。付けると「守り.wav.wav」になった）。頭の . は
// 隠しファイルになるので、頭の - は書き出しの命令の指定（--out など）と取り違えるので外す（名前を「--out」にすると、書き出し先が
// 「--progress」になった・2026-10-19 の監査）。100文字まで。空なら null（回の名前を使う）
function safeFileName(name) {
  const s = String(name == null ? '' : name).normalize('NFC').replace(/\//g, '／').replace(/:/g, '：')
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/(\.(wav|mp3))+$/i, '').replace(/^[.-]+/, '').slice(0, 100).trim();
  return s || null;
}
// 書き出し先（決めた名前、無ければ回の名前をファイル名にする）
function targetPath(project, format = 'wav', name = null) {
  return path.join(exportDir(), `${safeFileName(name) || safeFileName(project.name) || project.id}${FORMATS[format].ext}`);
}
// 書き出し先に同じ名前のファイルが既にある時、置き換えてよいのは、その回で前に書き出した物だけ（元の録音・BGM・CM・ほかの回の
// 書き出し・ほかのファイルを消さない。倉田さん「元のデータは保持しといた方がいいかも」・2026-10-19。前は回の名前＝1本目の録音の
// 名前で、書き出し先を録音のフォルダにすると、WAV の書き出しで録音を上書きした）。同じファイルかは中身の番号（inode と装置の番号）
// で見る: 書き出した時に export.json に残した番号と、今そこにあるファイルの番号が同じ時だけ置き換える（前に書き出した場所に、
// GarageBand の書き出しなど別のファイルが同じ名前で置き直されていたら置き換えない。前は「前に同じ場所へ書き出した」だけで
// 置き換えていた・2026-10-19 の監査）。この回が書いた書き出しは、場所と番号の一覧（export.json の own）で覚える（形を変えて同じ名前で
// 書き分けた時も、どちらも自分の書き出しと分かる。前は最後の1本だけを覚えていて、WAV → MP3 → WAV と書き出すと、自分の WAV なのに
// 止まった・同じ監査）。番号の無い前の記録は、前に書き出した場所のファイルと同じかで見る
const fileId = p => { try { const s = fs.statSync(p, { bigint: true }); return { ino: String(s.ino), dev: String(s.dev) }; } catch { return null; } };
const sameFile = (a, b) => { const x = fileId(a), y = fileId(b); return !!(x && y && x.ino === y.ino && x.dev === y.dev); };
const readRecord = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'export.json'), 'utf8')); } catch { return null; } };
const ownExports = r => (!r ? [] : Array.isArray(r.own) ? r.own.filter(o => o && typeof o.out === 'string')
  : typeof r.out === 'string' ? [{ out: r.out, ino: r.ino || null, dev: r.dev || null }] : []);
// 装置の番号（dev）は、外付けのディスクなどでは差し直しや Mac の再起動で変わることがあるので、場所も同じなら inode だけで見る
// （かいちさん・のりさんが外付けを書き出し先にした時に、自分の前の書き出しで止まらないように・2026-10-19 の監査）
const sameAsOwn = (o, now, out) => (o.ino ? o.ino === now.ino && (o.dev === now.dev || o.out === out) : sameFile(o.out, out));
function overwriteCheck(out, dir) {
  if (!fs.existsSync(out)) return { exists: false, replaceable: true };
  const now = fileId(out);
  const replaceable = !!now && ownExports(readRecord(dir)).some(o => sameAsOwn(o, now, out));
  return { exists: true, replaceable };
}

function mergeIntervals(list) {
  const s = list.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
function subtract(list, spans) {
  let out = list.map(([a, b]) => [a, b]);
  for (const [s, e] of spans) {
    const next = [];
    for (const [a, b] of out) {
      if (e <= a || s >= b) { next.push([a, b]); continue; }
      if (a < s) next.push([a, s]);
      if (e < b) next.push([e, b]);
    }
    out = next;
  }
  return out;
}
// 実際に切る所: 有効なカットから「ここは切らない」所（画面で塊の端を引いて戻した所）を抜いたもの。
// 抜いた残りが 0.02秒より短ければ切らない。画面（ui/index.html の cutSpans）と同じ決まり
const MIN_CUT = 0.02;
function cutSpans(cuts, keeps) {
  const k = mergeIntervals(keeps.filter(x => Array.isArray(x) && x.length === 2 && x[1] > x[0]));
  return subtract(mergeIntervals(cuts.filter(c => c.enabled).map(c => [c.start, c.end])), k).filter(([a, b]) => b - a >= MIN_CUT);
}

// 本編の後ろへ伸ばした「元の音の時間」→ 書き出しの時間（本編の中は切った分を引き、切る所の中は継ぎ目の所。本編の終わりより後は、
// 本編の終わりからそのままずらす。画面の ui/index.html の rawExtToOut と同じ）。BGM の終わり（途中で止めた時）と BGM の音量の線に使う
function rawToOut(merged, duration, talkSec, t) {
  if (t >= duration) return talkSec + (t - duration);
  let cut = 0;
  for (const [s, e] of merged) {
    if (s >= t) break;
    cut += Math.min(e, t) - s;
  }
  return t - cut;
}

// 音量の線の点 [{ t, db }]（t は書き出しの時間に直したもの・時刻の順）を、時刻 T（ffmpeg の式）の倍率の式にする。点と点の間は
// dB でまっすぐ・無音（線の一番下）との間は倍率でまっすぐ・最初の点より前と最後の点より後はその点の大きさ（画面の再生と同じ形）。
// 同じ時刻の点（詰めた所に重なった点）はそこで段にする。if は選んだ方だけ計算するので、点が多くても重くならない
function lineExpr(pts, T) {
  if (!pts.length) return '1';
  const f = v => (Math.abs(v) < 5e-7 ? '0' : v.toFixed(6));
  let expr = f(dbGain(pts[pts.length - 1].db));
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    if (!(b.t - a.t > 1e-6)) continue;
    const w = `(${T}-(${f(a.t)}))/${f(b.t - a.t)}`;
    const ga = dbGain(a.db), gb = dbGain(b.db);
    const seg = ga === 0 || gb === 0 ? `(${f(ga)}+(${f(gb - ga)})*${w})` : `pow(10,(${f(a.db)}+(${f(b.db - a.db)})*${w})/20)`;
    expr = `if(lt(${T},${f(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${T},${f(pts[0].t)}),${f(dbGain(pts[0].db))},${expr})`;
}
const readPts = list => (Array.isArray(list) ? list : [])
  .filter(p => p && Number.isFinite(p.t) && Number.isFinite(p.db)).map(p => ({ t: p.t, db: p.db })).sort((a, b) => a.t - b.t);

// 回の情報と編集の状態から、書き出す中身を決める。画面（ui/index.html の load）と同じ決まりで読む
function loadEdit(dir) {
  const P = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { st = null; }
  const notes = [];
  if (st && st.projectCreatedAt && st.projectCreatedAt !== P.createdAt) {
    notes.push('回を作り直したので、前の編集の状態は使いませんでした');
    st = null;
  }
  const N = P.tracks.length;
  const sameTracks = st && Array.isArray(st.mixer) && st.mixer.length === N;
  const cuts = st && Array.isArray(st.cuts) ? st.cuts : P.cuts;
  const mutes = st && Array.isArray(st.mutes) ? st.mutes.filter(m => m.track < N) : [];
  const mixer = sameTracks ? st.mixer : P.tracks.map(() => ({ mute: false, volume: 1 }));
  const bgmMix = P.bgm ? { mute: false, volume: P.bgm.volume, ...(st && st.bgm) } : null;
  const cmMix = P.cm ? { mute: false, ...(st && st.cm) } : null;
  return {
    P,
    notes,
    // 音の大きさ（LUFS）: 画面の書き出しの窓で選んだもの。選んでいなければ回の決まり（-16）
    loudness: st && Number.isFinite(st.exportLoudness) ? st.exportLoudness : Number.isFinite(P.loudness) ? P.loudness : -16,
    // 書き出すファイルの名前: 書き出しの窓で決めたもの。決めていなければ回の名前（targetPath）
    exportName: st && typeof st.exportName === 'string' ? st.exportName : null,
    names: sameTracks && Array.isArray(st.names) ? st.names : P.tracks.map(t => t.name),
    merged: cutSpans(cuts, st && Array.isArray(st.keeps) ? st.keeps : []),
    mutes: P.tracks.map((_, k) => mergeIntervals(mutes.filter(m => m.track === k).map(m => [m.start, m.end]))),
    volumes: mixer.map(m => (Number.isFinite(m.volume) ? m.volume : 1)),
    trackOn: mixer.map(m => !m.mute),
    // end: BGM の終わり。画面で右端をドラッグして決める。null＝本編の終わり（決めていない時も）・'cm'＝CM の終わり。途中で止めた時は
    // endRaw（本編の後ろへ伸ばした元の音の時間。間を詰めてもついていく）。前の形の数字（編集後のその時刻）もそのまま読む。
    // fadeIn・fadeOut: 画面で塊の上の角を引いて決めたフェードの秒数（決めていなければ回を作った時の値）。
    // vol: BGM の音量の線（本編の後ろへ伸ばした元の音の時間の点）
    bgm: P.bgm && !bgmMix.mute ? {
      ...P.bgm, volume: bgmMix.volume, end: bgmMix.end === 'cm' || Number.isFinite(bgmMix.end) ? bgmMix.end : null,
      endRaw: bgmMix.end !== 'cm' && Number.isFinite(bgmMix.endRaw) ? bgmMix.endRaw : null,
      fadeIn: Number.isFinite(bgmMix.fadeIn) ? Math.max(0, bgmMix.fadeIn) : P.bgm.fadeIn > 0 ? P.bgm.fadeIn : 0,
      fadeOut: Number.isFinite(bgmMix.fadeOut) ? Math.max(0, bgmMix.fadeOut) : P.bgm.fadeOut > 0 ? P.bgm.fadeOut : 0,
      vol: readPts(st && st.bgmVol),
    } : null,
    // gap: CM の頭の位置（本編の終わりから何秒後か。マイナスなら本編の終わりに重ねる。画面で CM の塊を引いて決める）。
    // vol: CM の音量の線（CM の頭からの時間の点）
    cm: P.cm && !cmMix.mute ? {
      ...P.cm,
      gap: Number.isFinite(cmMix.gap) ? cmMix.gap : P.cm.gap || 0,
      fadeIn: Number.isFinite(cmMix.fadeIn) ? Math.max(0, cmMix.fadeIn) : P.cm.fadeIn > 0 ? P.cm.fadeIn : 0,
      fadeOut: Number.isFinite(cmMix.fadeOut) ? Math.max(0, cmMix.fadeOut) : 0,
      vol: readPts(st && st.cmVol),
    } : null,
    // 本編の終わりのフェードアウト（尻すぼみ・3人とも）の秒数
    talkFadeOut: st && Number.isFinite(st.talkFadeOut) ? Math.max(0, st.talkFadeOut) : 0,
    // 音量の線: 人ごとの点 [{ t, db }]（元の音の時間・時刻の順）。画面で線に点を打つ・範囲を選んで「音量」で決めたもの
    vol: P.tracks.map((_, k) => volPointsOf(st, k)),
  };
}

// 音量の線の点を読む。前の形（範囲ごとに一定の大きさ gains: [{ track, start, end, db }]）は、範囲の前後 GAIN_RAMP 秒に ±0dB・
// 範囲の頭と終わりにその大きさ、の4点に直す（画面の ui/index.html と同じ決まり）
function volPointsOf(st, k) {
  if (st && Array.isArray(st.vol)) {
    const list = Array.isArray(st.vol[k]) ? st.vol[k] : [];
    return list.filter(p => p && Number.isFinite(p.t) && Number.isFinite(p.db)).map(p => ({ t: p.t, db: p.db })).sort((a, b) => a.t - b.t);
  }
  const gl = st && Array.isArray(st.gains) ? st.gains.filter(g => g && g.track === k && g.end > g.start && Number.isFinite(g.db)) : [];
  const pts = [];
  for (const g of gl) pts.push({ t: g.start - GAIN_RAMP, db: 0 }, { t: g.start, db: g.db }, { t: g.end, db: g.db }, { t: g.end + GAIN_RAMP, db: 0 });
  return pts.sort((a, b) => a.t - b.t);
}

// 残る区間（サンプル番号）: { rs, re, os }（元の音の rs〜re を、書き出しの os から並べる）
function keptSegments(merged, total) {
  const segs = [];
  let cur = 0, out = 0;
  for (const [s, e] of merged) {
    const ss = Math.round(s * RATE), ee = Math.round(e * RATE);
    if (ss > cur) { segs.push({ rs: cur, re: ss, os: out }); out += ss - cur; }
    cur = Math.max(cur, ee);
  }
  if (cur < total) { segs.push({ rs: cur, re: total, os: out }); out += total - cur; }
  return { segs, length: out };
}

// 1人ぶんの録音を、頭を揃えてモノラル・44.1kHz の float で少しずつ読み、onSamples(Float32Array, 先頭の番号) に渡す。
// onSamples が false を返したら読むのをやめる（必要な所まで読み終えた）。
// 頭揃えは src/align.js と同じ ffmpeg の指定でする（ずれが負＝遅れている→頭を落とす・正＝早い→頭に無音を足す）。
// 自分で秒をサンプルに直すと、端数の丸め方の違いで自動編集と1サンプルずれた（守り回の 0.445秒＝19624.5サンプル）
function streamDecode(file, offset, onSamples, onBytes) {
  return new Promise((resolve, reject) => {
    const head = offset < 0 ? ['-ss', String(-offset), '-i', file]
      : offset > 0 ? ['-i', file, '-af', `adelay=${Math.round(offset * 1000)}:all=1`]
        : ['-i', file];
    const child = track(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...head,
      '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }));
    let carry = null, index = 0, stopped = false, err = '';
    child.stdout.on('data', chunk => {
      if (stopped) return;
      const data = carry ? Buffer.concat([carry, chunk]) : chunk;
      const n = Math.floor(data.length / 4);
      // 受け取った塊は4バイト境界に揃っているとは限らないので、揃った領域に写してから読む
      const f32 = new Float32Array(n);
      new Uint8Array(f32.buffer).set(data.subarray(0, n * 4));
      carry = data.length > n * 4 ? Buffer.from(data.subarray(n * 4)) : null;
      if (onBytes) onBytes(n);
      if (onSamples(f32, index) === false) { stopped = true; child.kill(); }
      index += n;
    });
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => {
      if (stopped || code === 0) resolve();
      else reject(new Error(`録音を読めませんでした: ${file}\n${err}`));
    });
  });
}

// 3人の声を、切る所を抜き・消した所を無音にし・人ごとの音量を掛けて、1本（モノラル）に重ねる
async function mixVoices(edit, progress, opts = {}) {
  const { P } = edit;
  const total = Math.round(P.duration * RATE);
  const { segs, length } = keptSegments(edit.merged, total);
  const mix = new Float32Array(length);
  const on = P.tracks.map((_, k) => (opts.onlyTrack !== undefined ? k === opts.onlyTrack : edit.trackOn[k] || opts.allTracks));
  const count = on.filter(Boolean).length;
  let done = 0;
  for (let k = 0; k < P.tracks.length; k++) {
    if (!on[k]) continue;
    const t = P.tracks[k];
    // 生の録音（回を作った時に記録）を優先し、無ければ頭揃え済みの音源を使う
    let file, offset;
    if (t.source && t.source.file && fs.existsSync(t.source.file)) { file = t.source.file; offset = Number(t.source.offset) || 0; }
    else if (t.file && fs.existsSync(t.file)) { file = t.file; offset = 0; }
    else throw new Error(`${edit.names[k]} の録音が見つかりません（${(t.source && t.source.file) || t.file}）。動かしたなら元の場所に戻してください`);
    const vol = opts.unity ? 1 : edit.volumes[k];
    const mutes = opts.unity ? [] : edit.mutes[k].map(([s, e]) => ({ s: Math.round(s * RATE), e: Math.round(e * RATE) }));
    // 音量の線（点と点の間は dB でまっすぐ・無音〈線の一番下〉との間は倍率でまっすぐ＝フェードの形・最初の点より前と最後の点より後は
    // その点の大きさ。画面の再生と同じ形）
    const pts = opts.unity ? [] : edit.vol[k].map(p => ({ i: p.t * RATE, db: p.db, g: dbGain(p.db) }));
    let pi = 0, lastDb = 0, lastF = 1;
    let si = 0, mi = 0, read = 0;
    await streamDecode(file, offset, (x, j0) => {
      for (let n = 0; n < x.length; n++) {
        const i = j0 + n; // 頭を揃えた後の番号（＝編集画面の「元の音の時間」× 44100）
        while (si < segs.length && i >= segs[si].re) si++;
        if (si >= segs.length) return false; // 書き出しに使う所は読み終えた
        const seg = segs[si];
        if (i < seg.rs) continue; // 切る所
        let g = vol;
        while (mi < mutes.length && i >= mutes[mi].e) mi++;
        if (mi < mutes.length && i >= mutes[mi].s) {
          // 消した所: 端だけ短く絞って、中は無音
          const m = mutes[mi];
          const f = Math.min(FADE, Math.floor((m.e - m.s) / 2));
          const edge = Math.min(i - m.s, m.e - 1 - i);
          if (edge >= f) continue;
          g *= 1 - edge / f;
        }
        if (pts.length) {
          while (pi < pts.length && pts[pi].i <= i) pi++; // pts[pi - 1].i <= i < pts[pi].i
          const a = pts[pi - 1], b = pts[pi];
          if (!a || !b) g *= (a || b).g;
          else if (a.g === 0 || b.g === 0) g *= a.g + ((b.g - a.g) * (i - a.i)) / (b.i - a.i);
          else {
            const db = a.db + ((b.db - a.db) * (i - a.i)) / (b.i - a.i);
            if (db !== lastDb) { lastDb = db; lastF = Math.pow(10, db / 20); }
            g *= lastF;
          }
        }
        mix[seg.os + (i - seg.rs)] += g * x[n];
      }
      return true;
    }, n => { read += n; progress('voices', (done + Math.min(1, read / total)) / count); });
    done++;
    progress('voices', done / count);
  }
  // 継ぎ目のプツッという音を消す: 残る区間ごとに、頭と終わりを 10ms で絞る（src/apply.js と同じ）
  for (const seg of segs) {
    const n = seg.re - seg.rs;
    const fn = Math.min(FADE, Math.floor(n / 2));
    for (let i = 0; i < fn; i++) {
      const g = i / FADE;
      mix[seg.os + i] *= g;
      mix[seg.os + n - 1 - i] *= g;
    }
  }
  // 本編の終わりのフェードアウト（尻すぼみ）: 最後の talkFadeOut 秒を、だんだん小さく（倍率がまっすぐ下がる。画面の再生と同じ形）。
  // 確かめる用の生の声（unity）には掛けない
  if (!opts.unity && edit.talkFadeOut > 0) {
    const n = Math.min(mix.length, Math.round(edit.talkFadeOut * RATE));
    for (let i = 0; i < n; i++) mix[mix.length - 1 - i] *= i / n;
  }
  return mix;
}

// ffmpeg を動かし、進み具合（-progress の out_time_us）を返す
function runFfmpeg(args, durSec, onFrac) {
  return new Promise((resolve, reject) => {
    const child = track(spawn('ffmpeg', ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }));
    let err = '', out = '';
    child.stdout.on('data', d => {
      out = (out + d).slice(-1024);
      const all = out.match(/out_time_us=(\d+)/g);
      if (all && onFrac && durSec > 0) onFrac(Math.min(1, Number(all[all.length - 1].split('=')[1]) / 1e6 / durSec));
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg が止まりました\n${err.slice(-1500)}`))));
  });
}

// ebur128 が最後に出す大きさ（i＝LUFS）と、サンプルの間も入れた山（tp＝dBTP・peak=true の時）を拾う。測れなければ NaN
function ebur128Stats(stderr) {
  const last = re => { const m = stderr.match(re); return m ? Number(m[m.length - 1].match(/-?[\d.]+/)[0]) : NaN; };
  return { i: last(/I:\s+(-?[\d.]+) LUFS/g), tp: last(/Peak:\s+(-?[\d.]+) dBFS/g) };
}
const ebur128I = stderr => ebur128Stats(stderr).i;
// 音のファイルの大きさと山を測る
const measureFile = async (file, sec) => ebur128Stats(await runFfmpeg(['-y', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], sec));

// 大きさをそろえる: 全体に同じ倍率（gainDb）を掛けてから、山だけを tp（dBTP）に抑える。山を抑える部品（alimiter）は 192kHz で
// 掛ける（サンプルの間の山＝true peak まで抑えるため。loudnorm も中で 192kHz にしている）。後ろに 44.1kHz に戻す部品を付けて使う。
// 前は loudnorm の2回目で合わせていたが、声の山が大きい回は「短い区切りごとに上げ下げする」方式（dynamic）になり、一部分だけ
// 下げた所が持ち上がった（テストの合成音源で、−12dB に下げた所が −6.9dB に。倉田さんの「爆笑の所だけ下げる」が効かない）。
// 全体に同じ倍率なら、下げた所は下げたまま（2026-10-18）
const leveler = (gainDb, tp) => `volume=${gainDb.toFixed(3)}dB,aresample=192000,alimiter=limit=${Math.pow(10, tp / 20).toFixed(5)}:level=false:latency=true`;
// 山を抑えた分だけ少し小さくなるので、書いた後に測り直し、0.3 LU より外れていたら倍率を直してもう一度書く（1回まで）
const LOUD_TOL = 0.3;

function duration(file) {
  return Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());
}

async function exportProject(id, opts = {}) {
  const progress = opts.progress || (() => {});
  const format = opts.format || 'wav';
  if (!FORMATS[format]) throw new Error(`書き出しの形は wav か mp3 にしてください（${format}）`);
  const dir = path.join(DATA, id);
  const edit = loadEdit(dir);
  const { P } = edit;
  const loud = edit.loudness;
  // 最大の山は -1.5dB を狙う。Apple の上限は -1dB だが、16bit に直す時・MP3 にする時に少し上がる
  // （-1.0 を狙った合成音源の書き出しが -0.9dB になった）
  const TP = -1.5;
  for (const [what, x] of [['BGM', edit.bgm], ['CM', edit.cm]]) {
    if (x && !fs.existsSync(x.file)) throw new Error(`${what} の音源が見つかりません（${x.file}）。動かしたなら元の場所に戻すか、画面で ${what} をミュートしてください`);
  }
  if (!edit.trackOn.some(Boolean) && !opts.voicesWav && !opts.voicesWavEdit) throw new Error('全員ミュートになっています。書き出す声がありません');
  // 書き出し先（試しの --out のほかは、決まった書き出し先に、決めた名前で）。置き換えてはいけないファイルがあれば、書く前に止める
  const out = opts.out || targetPath(P, format, opts.name || edit.exportName);
  if (!opts.out && !opts.voicesWav && !opts.voicesWavEdit && !overwriteCheck(out, dir).replaceable) {
    throw new Error(`書き出し先に同じ名前のファイル（${path.basename(out)}）が既にあります。この回で書き出した物ではないので、置き換えずに止めました。書き出しの窓でファイルの名前を変えてください`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'himadan-export-'));
  leftovers.add(tmp);
  try {
    // 1) 3人の声を重ねる
    const mix = await mixVoices(edit, progress, opts.voicesWav ? { unity: true, allTracks: true, onlyTrack: opts.onlyTrack } : {});
    const talkSec = mix.length / RATE;
    const voicesRaw = path.join(tmp, 'voices.f32');
    fs.writeFileSync(voicesRaw, Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength));

    if (opts.voicesWav || opts.voicesWavEdit) {
      // 確かめる用: 重ねただけの声を 32bit float の WAV にして終わる
      const w = opts.voicesWav || opts.voicesWavEdit;
      await runFfmpeg(['-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', voicesRaw, '-c:a', 'pcm_f32le', w], talkSec);
      return { out: w, talkSec };
    }

    const cmSec = edit.cm ? duration(edit.cm.file) : 0;
    // CM の頭の位置。マイナスなら本編の終わりに重ねる（overlap＝重ねる秒数）。重ねない時は、本編の後に間をあけてつなぐ
    const cmGap = edit.cm ? edit.cm.gap || 0 : 0;
    const overlap = cmGap < 0;
    const gapSec = Math.max(0, cmGap);
    const allEnd = edit.cm ? Math.max(talkSec, talkSec + cmGap + cmSec) : talkSec;
    // BGM の終わり（画面で決めた所。決めていなければ本編の終わり）。CM の下まで伸ばせる。途中で止めた所は録音の時間で覚えているので、
    // 切った後の時間に直す
    const toOut = t => rawToOut(edit.merged, P.duration, talkSec, t);
    const bgmEnd = edit.bgm
      ? Math.min(Math.max(edit.bgm.end === 'cm' ? allEnd : Number.isFinite(edit.bgm.endRaw) ? toOut(edit.bgm.endRaw)
        : Number.isFinite(edit.bgm.end) ? edit.bgm.end : talkSec, 0.5), allEnd)
      : 0;
    const bgmUnderCm = !!(edit.bgm && edit.cm && bgmEnd > talkSec + 0.01);

    // BGM のフェード（頭のフェードインと終わりのフェードアウト）と音量の線。出力の時間の式で、本編の部分にも CM の下の続きにも
    // 同じ式を使う（フェードアウトが本編の終わりをまたいでも、つながる）。決めていなくても、本編の途中や CM の下で終わる時は 0.3秒で
    // 絞る（ブツッと切れないように）。式の値は 256 サンプル（約6ミリ秒）ごとに変える（段差でプツッと鳴らないように）。
    // 音量の線の点は、書き出しの時間に置いてから点と点の間をまっすぐにする（画面と同じ。詰めた所をまたいでも段にならない）
    const bfi = edit.bgm && edit.bgm.fadeIn > 0 ? edit.bgm.fadeIn : 0;
    const bfo = edit.bgm ? Math.max(edit.bgm.fadeOut || 0, bgmEnd < talkSec - 0.01 || bgmUnderCm ? 0.3 : 0) : 0;
    const bgmPts = edit.bgm ? edit.bgm.vol.map(p => ({ t: toOut(p.t), db: p.db })) : [];
    const bgmFade = shift => (bfi > 0 || bfo > 0 || bgmPts.length
      ? `,asetnsamples=n=256,volume='${bfi > 0 ? `clip((t+${shift})/${bfi},0,1)` : '1'}*${bfo > 0 ? `clip((${bgmEnd.toFixed(6)}-(t+${shift}))/${bfo},0,1)` : '1'}` +
        `*${lineExpr(bgmPts, `(t+${shift})`)}':eval=frame`
      : '');

    // 2) 本編 = 声（左右に同じ声）＋ BGM（足りなければ繰り返す・頭と終わりはフェード）
    const talkInputs = ['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', voicesRaw];
    let talkGraph = '[0:a]pan=stereo|c0=c0|c1=c0[v]';
    if (edit.bgm) {
      talkInputs.push('-stream_loop', '-1', '-i', edit.bgm.file);
      const inTalk = Math.min(bgmEnd, talkSec);
      talkGraph += `;[1:a]aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${inTalk.toFixed(6)},asetpts=N/SR/TB,volume=${edit.bgm.volume}${bgmFade(0)}[b]` +
        ';[v][b]amix=inputs=2:duration=first:normalize=0[talk]';
    } else {
      talkGraph += ';[v]anull[talk]';
    }
    // 3) 本編の音の大きさを測り（1回目）、全体に同じ倍率を掛けて合わせ、山だけを抑えて書く（2回目）。
    //    192kHz で山を抑えた後、44.1kHz に戻してから 16bit にする。書いた後に測り直して、外れていれば倍率を直して書き直す
    const talkIn = ebur128Stats(await runFfmpeg(['-y', ...talkInputs, '-filter_complex', `${talkGraph};[talk]ebur128=peak=true:framelog=quiet[o]`,
      '-map', '[o]', '-f', 'null', '-'], talkSec, f => progress('measure', f)));
    if (!(talkIn.i > -70)) throw new Error('本編の音の大きさを測れませんでした（全部が無音になっていないか確かめてください）');
    const toS16 = `aresample=${RATE}:osf=s16:dither_method=triangular`;
    const talkWav = path.join(tmp, 'talk.wav');
    const writeTalk = g => runFfmpeg(['-y', ...talkInputs, '-filter_complex', `${talkGraph};[talk]${leveler(g, TP)},${toS16}[o]`,
      '-map', '[o]', '-c:a', 'pcm_s16le', talkWav], talkSec, f => progress('write', f));
    let talkGain = loud - talkIn.i;
    await writeTalk(talkGain);
    let talkOut = await measureFile(talkWav, talkSec);
    if (Math.abs(talkOut.i - loud) > LOUD_TOL) {
      talkGain += loud - talkOut.i;
      await writeTalk(talkGain);
      talkOut = await measureFile(talkWav, talkSec);
    }

    // 4) BGM を CM の下まで伸ばした時: BGM の続きを、本編の終わりと同じ大きさで、大きさを合わせた後の CM に重ねる。
    //    CM と一緒に合わせると、CM の合わせ方（前の loudnorm の dynamic では、山が大きい CM は時間で上げ下げが変わった）で、
    //    CM の前の間の BGM だけが持ち上がった（試しの回で 4dB 大きく出た）
    let tailWav = null, want = 0, cmTp = TP;
    if (bgmUnderCm) {
      // BGM の続き: 本編の終わりの位置から（繰り返しはそのまま続く）・フェードは本編の部分と同じ式（最後は少なくとも 0.3秒で絞る）
      const len = bgmEnd - talkSec;
      tailWav = path.join(tmp, 'bgm-tail.wav');
      await runFfmpeg(['-y', '-stream_loop', '-1', '-i', edit.bgm.file, '-filter_complex',
        `[0:a]aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${talkSec.toFixed(6)}:end=${bgmEnd.toFixed(6)},` +
        `asetpts=N/SR/TB${bgmFade(talkSec.toFixed(6))}[o]`, '-map', '[o]', '-c:a', 'pcm_f32le', tailWav], len);
      // 本編の終わりで実際に掛かった上げ下げ。全体に同じ倍率だが、終わりで山を抑えていれば少し小さいので、
      // 終わりの2秒の「合わせる前」と「合わせた後」の大きさの差で測る（測れなければ全体の倍率）
      let endGain = talkGain;
      const win = Math.min(2, talkSec);
      const pre = ebur128I(await runFfmpeg(['-y', ...talkInputs, '-filter_complex',
        `${talkGraph};[talk]atrim=start=${(talkSec - win).toFixed(6)},ebur128=framelog=quiet[o]`, '-map', '[o]', '-f', 'null', '-'], talkSec));
      const post = ebur128I(await runFfmpeg(['-y', '-sseof', String(-win), '-i', talkWav, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], win));
      if (pre > -69 && post > -69) endGain = post - pre;
      want = edit.bgm.volume * Math.pow(10, endGain / 20); // 書き出した後の、本編の終わりの BGM の倍率
      // 重ねても山が -1.5dB を超えないよう、CM の山の上限を、重ねる BGM の山の分だけ下げる
      // （BGM の山は、サンプルの間で少し高くなる分として1割足して見る）
      const pk = /Peak level dB: (-?[\d.]+)/.exec(await runFfmpeg(['-y', '-i', tailWav, '-af',
        'astats=measure_perchannel=none:measure_overall=Peak_level', '-f', 'null', '-'], len));
      const bgmPeak = 1.1 * want * Math.pow(10, (pk ? Number(pk[1]) : 0) / 20);
      cmTp = Math.max(-9, 20 * Math.log10(Math.max(Math.pow(10, TP / 20) - bgmPeak, 1e-4)));
    }

    // 5) CM の部分 = 間 + CM。本編と別に大きさを測り（1回目）、全体に同じ倍率で合わせて山を抑えた CM 本体を書き（2回目・外れていれば
    //    書き直す）、そこにフェードと音量の線と BGM の続きを重ねる（3回目）
    let cmOut = null;
    const cmWav = path.join(tmp, 'cm.wav');
    if (edit.cm) {
      const cmGraph = `[0:a]aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[c0];` + (gapSec > 0
        ? `anullsrc=r=${RATE}:cl=stereo,atrim=duration=${gapSec},aformat=sample_fmts=fltp[g];[g][c0]concat=n=2:v=0:a=1[cm]`
        : '[c0]anull[cm]');
      const cmIn = ebur128Stats(await runFfmpeg(['-y', '-i', edit.cm.file, '-filter_complex', `${cmGraph};[cm]ebur128=peak=true:framelog=quiet[o]`,
        '-map', '[o]', '-f', 'null', '-'], gapSec + cmSec));
      if (!(cmIn.i > -70)) throw new Error('CM の音の大きさを測れませんでした（CM の音源が無音になっていないか確かめてください）');
      const cmBody = path.join(tmp, 'cm-body.wav');
      const writeCmBody = g => runFfmpeg(['-y', '-i', edit.cm.file, '-filter_complex', `${cmGraph};[cm]${leveler(g, cmTp)},aresample=${RATE}[o]`,
        '-map', '[o]', '-c:a', 'pcm_f32le', cmBody], gapSec + cmSec);
      let cmGain = loud - cmIn.i;
      await writeCmBody(cmGain);
      cmOut = await measureFile(cmBody, gapSec + cmSec);
      if (Math.abs(cmOut.i - loud) > LOUD_TOL) {
        cmGain += loud - cmOut.i;
        await writeCmBody(cmGain);
        cmOut = await measureFile(cmBody, gapSec + cmSec);
      }
      // CM のフェード（頭・終わり）と音量の線（CM の頭からの時間）は、大きさを合わせた後に掛ける（CM 本体の大きさは、フェードの前の
      // 音で合わせる）
      const cfi = edit.cm.fadeIn > 0 ? edit.cm.fadeIn : 0, cfo = edit.cm.fadeOut > 0 ? edit.cm.fadeOut : 0;
      const cmFade = (cfi > 0 ? `,afade=t=in:st=${gapSec.toFixed(6)}:d=${cfi}` : '') +
        (cfo > 0 ? `,afade=t=out:st=${Math.max(gapSec, gapSec + cmSec - cfo).toFixed(6)}:d=${cfo}` : '') +
        (edit.cm.vol.length ? `,asetnsamples=n=256,volume='${lineExpr(edit.cm.vol, `(t-${gapSec.toFixed(6)})`)}':eval=frame` : '');
      // BGM の続きは、間をあけてつなぐ時はここで CM に重ねる（本編に重ねる時は、6 で本編・CM と一緒に重ねる）
      const write = tailWav && !overlap
        ? `[0:a]anull${cmFade}[cn];` +
          `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${want.toFixed(6)}[bt];[cn][bt]amix=inputs=2:duration=first:normalize=0,${toS16}[o]`
        : `[0:a]anull${cmFade},${toS16}[o]`;
      await runFfmpeg(['-y', '-i', cmBody, ...(tailWav && !overlap ? ['-i', tailWav] : []), '-filter_complex', write,
        '-map', '[o]', '-c:a', 'pcm_s16le', cmWav], gapSec + cmSec);
    }

    // 6) 本編 →（間＋CM）をつないで、選んだ形で書き出し先へ（書きかけを残さないよう、別名に書いてから置き換える）。
    //    CM を本編の終わりに重ねる時は、つながずに重ねる: CM を頭の位置まで遅らせ、BGM の続きも本編の終わりから重ねる。
    //    重なった所で山が上がるので、最後に山を -1.5dB に抑える（自動の音量調整はしない・抑える部品の遅れは補正する）
    //    書き出し先（out）は始めに決めて、置き換えてよいかも確かめてある
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // 書きかけの名前に回の ID を入れる（同じ名前の2つの回を同時に書き出すと、同じ書きかけに2つの ffmpeg が書き合った・2026-10-19 の監査）
    const part = `${out}.${id}.part`;
    leftovers.add(part);
    const joinInputs = ['-i', talkWav, ...(edit.cm ? ['-i', cmWav] : []), ...(edit.cm && overlap && tailWav ? ['-i', tailWav] : [])];
    const ms = v => (v * 1000).toFixed(3);
    const joinGraph = !edit.cm ? '[0:a]anull[o]'
      : !overlap ? '[0:a][1:a]concat=n=2:v=0:a=1[o]'
      : `[1:a]adelay=delays=${ms(talkSec + cmGap)}:all=1[c]` +
        (tailWav
          ? `;[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${want.toFixed(6)},adelay=delays=${ms(talkSec)}:all=1[t];[0:a][c][t]amix=inputs=3`
          : ';[0:a][c]amix=inputs=2') +
        `:duration=longest:normalize=0,alimiter=limit=${Math.pow(10, -1.5 / 20).toFixed(4)}:level=false:latency=true[o]`;
    await runFfmpeg(['-y', ...joinInputs, '-filter_complex', joinGraph,
      '-map', '[o]', ...FORMATS[format].args, part], allEnd, f => progress('join', f));
    // 長さが合わなければ、何かがおかしい（黙って渡さない）。前の書き出しを壊さないよう、置き換える前に書きかけの方で確かめる
    // （前は置き換えた後に確かめていて、合わない時は前の良い書き出しが消え、記録だけが前のまま残った・2026-10-19 の監査）
    const outSec = duration(part);
    const expectSec = allEnd;
    if (Math.abs(outSec - expectSec) > 0.1) throw new Error(`書き出した長さ（${outSec.toFixed(2)}秒）が編集後の長さ（${expectSec.toFixed(2)}秒）と合いません`);
    // 書いている間に、書き出し先に置き換えてはいけないファイルができていないか、置き換える直前にもう一度確かめる（同じ名前の別の回を
    // 同時に書き出した時など。始めに確かめただけだと、後から終わった方が黙って置き換えた・2026-10-19 の監査）
    if (!opts.out && !overwriteCheck(out, dir).replaceable) {
      throw new Error(`書き出している間に、書き出し先に同じ名前のファイル（${path.basename(out)}）ができました。置き換えずに止めました。書き出しの窓でファイルの名前を変えて、もう一度書き出してください`);
    }
    fs.renameSync(part, out);
    leftovers.delete(part);
    progress('join', 1);

    const written = fileId(out);
    // この回が書いた書き出しの一覧（新しい物を後ろに・10本まで。同じ場所の古い記録は入れ替える）
    const own = [...ownExports(opts.out ? null : readRecord(dir)).filter(o => o.out !== out),
      { out, ino: written && written.ino, dev: written && written.dev }].slice(-10);
    const result = {
      out,
      name: path.basename(out, FORMATS[format].ext), // 書き出したファイルの名前（拡張子なし）
      dir: path.dirname(out), // 書き出した時の書き出し先（後で書き出し先を変えても、この書き出しを「書き出し済み」と分かるように）
      // 書いたファイルの中身の番号（次に同じ名前で書き出す時、そこにある物がこの回の書き出しかを確かめる＝overwriteCheck）
      ino: written && written.ino,
      dev: written && written.dev,
      own,
      format,
      formatLabel: FORMATS[format].label,
      bytes: fs.statSync(out).size,
      duration: +outSec.toFixed(3),
      expected: +expectSec.toFixed(3),
      talk: +talkSec.toFixed(3),
      // mode: そろえ方（全体に同じ倍率＝linear）。gain: 本編に掛けた倍率（dB）
      loudness: { target: loud, talk: +talkOut.i.toFixed(2), talkPeak: +talkOut.tp.toFixed(2), cm: cmOut ? +cmOut.i.toFixed(2) : null, mode: 'linear', gain: +talkGain.toFixed(2) },
      voices: P.tracks.map((_, k) => ({ name: edit.names[k], on: edit.trackOn[k], volume: edit.volumes[k], mutes: edit.mutes[k].length })),
      bgm: edit.bgm ? { file: path.basename(edit.bgm.file), volume: edit.bgm.volume, end: +bgmEnd.toFixed(3), fadeIn: bfi, fadeOut: bfo, points: bgmPts.length } : null,
      cm: edit.cm ? { file: path.basename(edit.cm.file), gap: cmGap, fadeIn: edit.cm.fadeIn, fadeOut: edit.cm.fadeOut, points: edit.cm.vol.length } : null,
      talkFadeOut: edit.talkFadeOut,
      cuts: edit.merged.length,
      notes: edit.notes,
      exportedAt: new Date().toISOString(),
    };
    // 画面が「前回の書き出し」を出せるように残す（書き出し先を指定した試しの書き出しは残さない）
    if (!opts.out) fs.writeFileSync(path.join(dir, 'export.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    leftovers.delete(tmp);
    // 途中で止まった時は、書き出し先の書きかけ（.part）も残さない（置き換えた後は leftovers から外してあるので消さない）
    const part = `${out}.${id}.part`;
    if (leftovers.has(part)) { fs.rmSync(part, { force: true }); leftovers.delete(part); }
  }
}

module.exports = { exportProject, targetPath, safeFileName, overwriteCheck, exportDir, isOwnExport, DEFAULT_EXPORT_DIR, loadEdit, keptSegments, rawToOut, lineExpr, FORMATS, RATE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const id = args[0];
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!id || !/^[\w.-]+$/.test(id)) {
    console.error('usage: node ui/export.js <回のID> [--format wav|mp3] [--name <ファイルの名前>] [--out <書き出し先>] [--progress] [--voices-wav <声だけ.wav>]');
    process.exit(1);
  }
  // サーバーの「やめる」（SIGTERM）・Ctrl-C で止める（サーバーが require した時は、サーバー自身の止め方に任せる）
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopAll(); process.exit(130); });
  const json = args.includes('--progress');
  // 進み具合: 声を重ねる 0〜25%・音の大きさを測る 25〜55%・書く 55〜95%・つなぐ 95〜100%
  const SPAN = { voices: [0, 0.25, '声を重ねています'], measure: [0.25, 0.55, '音の大きさを測っています'], write: [0.55, 0.95, '書いています'], join: [0.95, 1, 'CM をつないでいます'] };
  let last = 0;
  const progress = (step, f) => {
    const [a, b, label] = SPAN[step];
    const pct = a + (b - a) * Math.max(0, Math.min(1, f));
    if (json && (pct - last >= 0.005 || f >= 1)) { last = pct; console.log(JSON.stringify({ type: 'progress', step: label, pct: +pct.toFixed(3) })); }
  };
  const t0 = Date.now();
  const only = opt('--track');
  exportProject(id, { out: opt('--out'), name: opt('--name'), format: opt('--format'), voicesWav: opt('--voices-wav'), voicesWavEdit: opt('--voices-wav-edit'),
    onlyTrack: only === undefined ? undefined : Number(only), progress })
    .then(r => {
      r.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      if (json) console.log(JSON.stringify({ type: 'done', ...r }));
      else console.log(JSON.stringify(r, null, 2));
    })
    .catch(e => {
      stopAll(); // 動いている ffmpeg と、書きかけのファイルを残さない
      if (json) console.log(JSON.stringify({ type: 'error', message: e.message.split('\n')[0] }));
      console.error(e.message);
      process.exit(1);
    });
}
