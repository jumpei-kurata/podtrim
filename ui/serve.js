#!/usr/bin/env node
// 編集画面のサーバー（依存なし）。画面のファイルと「回」のデータを配り、編集の状態を保存する。
//   node ui/serve.js [port]
//
// API:
//   GET  /api/projects                     … 回の一覧（触った新しい順。名前・長さ・作った日時）。?detail=1 で、大きさ・書き出し済みか・
//                                            今動いている仕事も添える（「整理する…」の窓）
//   GET  /api/projects/<id>                … 回の情報（project.json）＋保存済みの編集状態（state.json）。編集状態が無い（新しい）回は、
//                                            前の回の設定（inherit）も添える
//   PUT  /api/projects/<id>/state          … 編集状態を保存する（画面が変更のたびに送る）
//   POST /api/projects/<id>/trash          … 回を Mac のゴミ箱に入れる（回のフォルダだけ。元の録音・書き出したファイルは消えない）
//   GET  /api/projects/<id>/export         … 書き出しの進み具合・書き出し先（?name= でファイルの名前。同じ名前のファイルが既にあるか・
//                                            置き換えてよいか）・前回の書き出し
//   POST /api/projects/<id>/export         … 書き出しを始める（{ format: 'wav' | 'mp3', name? }。ui/export.js を別の動きで走らせる）
//   POST /api/projects/<id>/export/cancel  … 書き出しをやめる
//   POST /api/projects/<id>/export/reveal  … 書き出したファイルを Finder で見せる
//   POST /api/projects/<id>/asset          … BGM か CM を入れ替える（{ kind: 'bgm' | 'cm', path }。path が空なら外す）
//   GET  /api/projects/<id>/peaks/<bgm|cm> … BGM・CM の波形（1秒200点。初めて頼まれた時に作って取っておく）
//   GET  /api/cm                           … CM のフォルダ（決めていなければ ~/Documents/Podcast/CM音声）の中身（新しい順）
//   POST /api/cm/folder                    … CM のフォルダを選ぶ窓を出し、選んだフォルダを覚える（やめたら変えない）
//   POST /api/export/folder                … 書き出し先のフォルダを選ぶ窓を出し、選んだフォルダを覚える（やめたら変えない）
//   GET  /api/ai                           … 説明文を書く AI の設定（どれを使うか・鍵が入っているか。鍵そのものは返さない）
//   POST /api/ai                           … AI を選ぶ・鍵を入れる（{ provider, key?, model? }。鍵はキーチェーンへ）
//   POST /api/ai/forget                    … 鍵を消す（{ provider }）
//   GET  /api/projects/<id>/describe       … 説明文づくりの進み具合と、前に作った物（description.json）・今の書き出しの日時
//   POST /api/projects/<id>/describe       … 説明文づくりを始める（{ again } で文字起こしからやり直す。ui/describe.js）
//   POST /api/projects/<id>/describe/cancel … 説明文づくりをやめる
//   GET  /api/projects/<id>/align          … 頭を揃える窓（頭揃えが自動で決まらなかった回）: 録音ごとの冒頭の波形・手拍子の候補・
//                                            今の手拍子の時刻
//   GET  /api/projects/<id>/align/preview?claps=<秒,…> … 選んだ手拍子の前後を全員分重ねた音（WAV）。揃っていればパンが1回に聞こえる
//   POST /api/projects/<id>/align          … 選んだ手拍子で揃え直し、切る所と被りを探し直す（{ claps: [秒,…] }。ui/import.js を
//                                            もう一度走らせる。進み具合は /api/imports/<id>）
//   GET  /api/import/options               … 新しい回を作る時の BGM と CM の選択肢（前の回で使ったもの・CM のフォルダ）と、
//                                            間の詰め方の初めの値（いちばん最近触った回の値）
//   POST /api/files/resolve                … 画面に落とされたファイルの元の場所を探す（{ files: [{ name, size, lastModified }] }）
//   PUT  /api/uploads?name=<名前>           … 元の場所が分からなかったファイルを受け取って置く（中身をそのまま送る）
//   POST /api/imports                      … 新しい回を作り始める（{ name, files: [場所], bgm, cm, tight?, gap? }。ui/import.js を走らせる）
//   GET  /api/imports/<id>                 … 新しい回づくりの進み具合
//   POST /api/imports/<id>/cancel          … 新しい回づくりをやめる
// 回のデータ（音声・波形）は /data/<id>/... で配る。置き場所は ui/data-dir.js。
//
// この Mac の中からしか繋がらないようにする（127.0.0.1 で待ち受け、Host も確かめる）。録音は公開前の音声なので外に出さない。
// Host を確かめるのは、外部のサイトが自分の名前をこの Mac（127.0.0.1）に向ける手口で、ブラウザ経由で読まれるのを防ぐため。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const DATA = require('./data-dir');
const clap = require('../src/clap');
const { targetPath, FORMATS, exportDir, isOwnExport, overwriteCheck, safeFileName } = require('./export');
const { isAudio, findOriginals, isAllowedPath, safeName, UPLOADS } = require('./files');
const { readSettings, writeSettings, AI, isAI, aiChoice, hasKey, setKey, deleteKey } = require('./settings');
const ART19_URL = 'https://art19.com/admin/series/07ef6b45-d4fc-4d94-b211-e02a27b7e2a6/content'; // 説明文の欄の「ART19 と Finder を開く」（settings.json の art19Url で変えられる）

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8899);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.bin': 'application/octet-stream',
};
const ID = /^[\w.-]+$/;
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024; // 録音1本は大きくても 1GB 前後

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  // 書きかけのファイルを残さないよう、別名に書いてから置き換える
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function listProjects() {
  if (!fs.existsSync(DATA)) return [];
  return fs.readdirSync(DATA)
    .filter(d => ID.test(d) && fs.existsSync(path.join(DATA, d, 'project.json')))
    .map(d => {
      // 読んでいる間にゴミ箱へ動いた回などは飛ばす（投げるとサーバーごと止まり、アプリも閉じる・2026-10-19 の監査）
      try {
        const p = readJson(path.join(DATA, d, 'project.json'));
        const st = fs.statSync(path.join(DATA, d, fs.existsSync(path.join(DATA, d, 'state.json')) ? 'state.json' : 'project.json'));
        return { id: d, name: p ? p.name : d, duration: p ? p.duration : null, createdAt: (p && p.createdAt) || null, updated: st.mtime.toISOString() };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > limit) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}
// JSON の依頼を読む（読めなければ 400 を返して終わる）
function readJsonBody(req, res, cb) {
  readBody(req, 1024 * 1024, text => {
    let body;
    try { body = JSON.parse(text || '{}'); } catch { return sendJson(res, 400, { error: 'JSON として読めません' }); }
    // 本文を読んだ後の処理（保存・新しい回など）の思わぬ失敗でも、サーバーごと止まらないように（ディスクが一杯など。api の try/catch は
    // 本文を読む前までしか守らない・2026-10-19 の監査）
    try { cb(body || {}); } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: `サーバーで思わぬ失敗がありました（${e.message}）` });
    }
  });
}

// 画面に出す時は、ホームのフォルダを ~ にして短くする（長いと途中で折れて読みにくい）
const shortPath = p => (p && p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

// ---------- 時間のかかる仕事（書き出し・新しい回づくり） ----------
// 別の動き（子プロセス）で走らせ、進み具合を覚えておく。サーバーを止めると、途中のものも止める
const jobs = new Map(); // 'export:<回のID>' / 'import:<回のID>' → { state: 'running'|'done'|'error'|'cancelled', step, pct, result, error, child }
function startJob(key, script, args, extra = {}, onEnd) {
  const cur = jobs.get(key);
  if (cur && cur.state === 'running') return cur;
  const job = { state: 'running', step: '準備しています', pct: 0, startedAt: Date.now(), ...extra };
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args, '--progress'], { stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  let buf = '', errTail = '';
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'progress') { job.step = m.step; job.pct = m.pct; }
      else if (m.type === 'done') job.result = m;
      else if (m.type === 'error') job.error = m.message;
    }
  });
  child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  // 起動できなかった時の知らせ。拾わないとサーバーごと止まる
  child.on('error', e => { job.child = null; job.state = 'error'; job.error = `始められませんでした（${e.message}）`; if (onEnd) onEnd(job); });
  child.on('close', code => {
    job.child = null;
    if (job.cancelled) job.state = 'cancelled';
    else if (code === 0 && job.result) { job.state = 'done'; job.pct = 1; }
    else { job.state = 'error'; job.error = job.error || errTail.trim().split('\n').pop() || `止まりました（${code}）`; }
    if (onEnd) onEnd(job);
  });
  jobs.set(key, job);
  return job;
}
const jobView = j => (j
  ? { state: j.state, format: j.format, step: j.step, pct: j.pct, startedAt: j.startedAt, elapsed: (Date.now() - j.startedAt) / 1000,
    result: j.result ? { ...j.result, display: shortPath(j.result.out) } : null, error: j.error || null }
  : { state: 'none' });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const j of jobs.values()) if (j.child) j.child.kill(); process.exit(0); });
}

// 前回の書き出し（決まった書き出し先に書いたものだけ。試しに別の所へ書き出したものは出さない。書き出し先を後で変えても、
// 前の書き出しはそのまま。ui/export.js の isOwnExport）
function lastExport(dir) {
  const r = readJson(path.join(dir, 'export.json'));
  if (!isOwnExport(r) || !fs.existsSync(r.out)) return null;
  return r;
}

// ---------- BGM・CM ----------
// 波形（1秒200点・0〜255。prep.js の声の波形と同じ作り）。試聴用の音から作り、試聴用の音より新しければ作った物を使う
function assetPeaks(dir, project, kind) {
  return new Promise((resolve, reject) => {
    const conf = project[kind];
    if (!conf) return resolve(null);
    const src = path.join(dir, conf.preview);
    const out = path.join(dir, `${kind}-peaks.bin`);
    try {
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return resolve(fs.readFileSync(out));
    } catch { return resolve(null); }
    const RATE = 8000, PER = 200, BLOCK = RATE / PER;
    const c = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-']);
    const chunks = [];
    c.stdout.on('data', d => chunks.push(d));
    c.on('error', reject);
    c.on('close', code => {
      if (code !== 0) return reject(new Error('波形を作れませんでした'));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      const peaks = Buffer.alloc(Math.ceil(n / BLOCK));
      for (let b = 0; b < peaks.length; b++) {
        let p = 0;
        for (let i = b * BLOCK; i < Math.min((b + 1) * BLOCK, n); i++) {
          const v = Math.abs(buf.readFloatLE(i * 4));
          if (v > p) p = v;
        }
        peaks[b] = Math.min(255, Math.round(p * 255));
      }
      fs.writeFileSync(out, peaks);
      resolve(peaks);
    });
  });
}
// 試聴用の軽い音（prep.js と同じ形）を作り、回の情報を書き換える
function probeDuration(file) {
  return new Promise(resolve => {
    const c = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => resolve(0));
    c.on('close', () => resolve(Number(out.trim()) || 0));
  });
}
function makePreview(src, out, maxSec) {
  return new Promise((resolve, reject) => {
    const t = maxSec ? ['-t', String(maxSec)] : [];
    const c = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...t, '-ac', '1', '-ar', '22050', '-b:a', '64k', out]);
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve() : reject(new Error(`音源を読めませんでした（${path.basename(src)}）${err.slice(-200)}`))));
  });
}
async function replaceAsset(dir, project, kind, file) {
  if (!file) {
    // 外す（「なし」を選んだ）。試聴用のファイルは残しても害がないので消さない
    project[kind] = null;
    writeJson(path.join(dir, 'project.json'), project);
    return project;
  }
  const preview = `${kind}.mp3`;
  await makePreview(file, path.join(dir, preview), kind === 'bgm' ? Math.ceil(project.duration) + 60 : 0);
  const duration = await probeDuration(path.join(dir, preview));
  // 回を作った時の値（フェード・CM の頭の位置）は、入れ替えても前の値のまま。初めて入れる時は ui/prep.js と同じ値
  // （BGM: 頭 2秒・終わり 3秒のフェード。CM: 本編の終わりの 0.5秒前から重ねて 2秒でフェードイン・2026-10-19 に 2秒前から変えた）
  if (kind === 'bgm') {
    project.bgm = { file, preview, duration, volume: (project.bgm && project.bgm.volume) || 0.12,
      fadeIn: project.bgm ? project.bgm.fadeIn : 2, fadeOut: project.bgm ? project.bgm.fadeOut : 3 };
  } else project.cm = { file, preview, duration, gap: project.cm ? project.cm.gap : -0.5, fadeIn: project.cm ? project.cm.fadeIn : 2 };
  writeJson(path.join(dir, 'project.json'), project);
  return project;
}

// 回をまたいで使う設定（CM のフォルダ・説明文を書く AI）。回の置き場の隣の settings.json と、AI の鍵（キーチェーン）。ui/settings.js

// CM のフォルダの中身。新しく作った CM から並べる（「今日はこれ」を選びやすく）。フォルダは、画面の CM の欄の「フォルダを選ぶ…」で
// 選んだ所（かいちさん・のりさんの Mac でも使えるように。倉田さん「フォルダを指定することで、そのフォルダ内にある CM を選択できる
// ようになるみたいな感じ？」・2026-10-18）。決めていなければ ~/Documents/Podcast/CM音声。環境変数 HIMADAN_CM_DIR で変えられる（試す時用）
const DEFAULT_CM_DIR = path.join(os.homedir(), 'Documents', 'Podcast', 'CM音声');
const cmDir = () => process.env.HIMADAN_CM_DIR || readSettings().cmDir || DEFAULT_CM_DIR;
function cmFolderList() {
  const dir = cmDir();
  let files = [], missing = false;
  try {
    files = fs.readdirSync(dir).filter(f => isAudio(f) && !f.startsWith('.')).map(f => {
      const p = path.join(dir, f);
      // 名前は濁点の持ち方をそろえて出す（Finder で作った名前は「ぽ」を「ほ＋゜」で持っている）。場所は Mac にある形のまま
      return { path: p, name: f.replace(/\.[^.]+$/, '').normalize('NFC'), mtime: fs.statSync(p).mtimeMs };
    });
  } catch { files = []; missing = !fs.existsSync(dir); }
  files.sort((a, b) => b.mtime - a.mtime);
  return { folder: shortPath(dir), files, missing };
}
// CM のファイルか（今の CM のフォルダの中の音声か、前の回で使った CM。「最近の回で使った CM」の欄から、前に選んでいたフォルダの
// CM を選んでも使えるように）
const inCmDir = p => typeof p === 'string' && path.isAbsolute(p) && isAudio(p) && fs.existsSync(p) &&
  (path.resolve(p).startsWith(path.resolve(cmDir()) + path.sep) || listProjects().some(x => {
    const Q = readJson(path.join(DATA, x.id, 'project.json'));
    return Q && Q.cm && path.resolve(Q.cm.file) === path.resolve(p);
  }));

// Mac の「フォルダを選ぶ」窓を出して、選んだフォルダの場所を返す（やめたら null）。osascript の choose folder。
// activate で、窓をほかの窓より前に出す（アプリの後ろに隠れないように）
const appleStr = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
let choosing = null; // 窓を出している間は、もう1つ出さない
function chooseFolder(prompt, defaultDir) {
  // 試す時用: 環境変数 HIMADAN_CHOOSE_FOLDER の場所を、窓を出さずに選んだことにする（空なら「やめた」）
  if (process.env.HIMADAN_CHOOSE_FOLDER !== undefined) return Promise.resolve(process.env.HIMADAN_CHOOSE_FOLDER || null);
  if (choosing) return choosing;
  const where = defaultDir && fs.existsSync(defaultDir) ? ` default location (POSIX file ${appleStr(defaultDir)})` : '';
  choosing = new Promise(resolve => {
    const c = spawn('osascript', ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt ${appleStr(prompt)}${where})`]);
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('error', () => resolve(null));
    c.on('close', code => resolve(code === 0 && out.trim() ? out.trim().replace(/\/+$/, '') : null)); // やめた時は 1 で終わる
  }).finally(() => { choosing = null; });
  return choosing;
}

// 書き出し先のフォルダ（書き出しの窓の「変更…」で選ぶ・この Mac で覚える。ui/export.js の exportDir）。fixed は試す時の
// 環境変数 HIMADAN_EXPORT で決まっている時（画面からは変えられない）
const exportFolderView = () => ({ path: exportDir(), display: shortPath(exportDir()), chosen: !!readSettings().exportDir, fixed: !!process.env.HIMADAN_EXPORT });

// 間の詰め方（「この秒数以上の間を、この秒数に詰める」）。画面の「調整」のつまみと同じ幅・0.1秒きざみ。既定は「1.2秒以上の間を
// 0.4秒に」（倉田さん「デフォルトこれもう1秒以上も、0.4が妥当？0.5もしくは0.3どっちがいいかな」→「Bで。それでデフォルトを決めて」・
// 2026-10-19）。ピープルウェアー回（3人）の倉田さんの手編集（477秒を削った）と10通り比べた（README の「間を詰める」）:
//   1.4秒・0.4秒＝手編集の65%・削りすぎ3区間 / 1.2秒・0.4秒＝76%・3区間 / 1.0秒・0.4秒＝90%・5区間 / 1.0秒・0.3秒＝97%・9区間
// 1.2秒は、1.4秒（前の既定）と同じ削りすぎの数のまま、削る量が1割ほど増える。残す間は同じ詰める間なら 0.3 で削りすぎが増え
// （1.2秒で 3→4区間）、0.5 では削りすぎが減らずに削る量だけ減る（76%→71%）ので 0.4。2人の回（8月・#485）は 1.2秒だと手編集の
// 105%・削りすぎ10区間なので、2人の回は 1.4秒がよい。新しい回の窓の初めの値は前の回の値なので、この既定は回が1つも無い時
// （初めての Mac）に効く。コマンドで使う src/analyze.js の既定（1.4秒以上を 0.4秒に）は前のまま
const TIGHT = { min: 0.6, max: 3, def: 1.2 }, GAP = { min: 0.1, max: 1, def: 0.4 };
const step01 = (v, { min, max, def }) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 10) / 10)) : def);
// 新しい回の間の詰め方の初めの値（倉田さん「このタイミングでさ、何秒以上空白のところを何秒にするっていうあの設定…入れといた方が
// いいんじゃないの、ここで」・2026-10-19）: いちばん最近触った回で選んだ値（編集の状態の tight・tightGap）。ただし引き継ぐのは、
// その回で選んだ値（新しい回の窓で、前の回から引き継いだか既定から動かした＝import.json の tightChosen、か、「調整」で最初の
// 設定から変えた）だけ。前の既定のまま
// 作って触っていない回からは引き継がず、既定から始める（倉田さん「デフォルト 1.4 秒だけど合ってる？これ」・同じ日。既定を 1.2秒に
// 決めた後も、前の既定の 1.4秒で作った #508 から 1.4秒を引き継いでいた）。回が無ければ既定
function lastTight() {
  const def = { tight: TIGHT.def, gap: GAP.def, from: null };
  for (const x of listProjects()) {
    const Q = readJson(path.join(DATA, x.id, 'project.json'));
    if (!Q) continue;
    const S = readJson(path.join(DATA, x.id, 'state.json'));
    const st = S && !(S.projectCreatedAt && S.projectCreatedAt !== Q.createdAt) ? S : null;
    const ap = Q.autoParams;
    const made = ap && Number.isFinite(ap.pad) && Number.isFinite(ap.minCut) ? { tight: ap.minCut + 2 * ap.pad, gap: 2 * ap.pad } : null;
    const imp = readJson(path.join(DATA, x.id, 'import.json'));
    // 窓で既定のまま作った回（tightChosen: false）は「選んだ」に数えない（印の無い前の記録は、窓で決めた物として数える）
    const chosenAtCreate = !!(imp && Number.isFinite(imp.tight) && imp.tightChosen !== false);
    const differs = (v, w) => Number.isFinite(v) && Number.isFinite(w) && Math.abs(v - w) > 1e-6;
    const changedLater = !!(st && made && (differs(st.tight, made.tight) || differs(st.tightGap, made.gap)));
    if (!chosenAtCreate && !changedLater) return def;
    const base = made || (chosenAtCreate ? { tight: imp.tight, gap: imp.gap } : {});
    return {
      tight: step01(st && Number.isFinite(st.tight) ? st.tight : base.tight, TIGHT),
      gap: step01(st && Number.isFinite(st.tightGap) ? st.tightGap : base.gap, GAP),
      from: Q.name,
    };
  }
  return def;
}

// 新しい回の BGM と CM の選択肢: 前の回で使ったもの（新しい回から）と、CM のフォルダの中身（新しい順）。間の詰め方の初めの値も添える
function importOptions() {
  const bgm = [], cm = [];
  for (const p of listProjects()) {
    const P = readJson(path.join(DATA, p.id, 'project.json'));
    if (P && P.bgm && fs.existsSync(P.bgm.file) && !bgm.includes(P.bgm.file)) bgm.push(P.bgm.file);
    if (P && P.cm && fs.existsSync(P.cm.file) && !cm.includes(P.cm.file)) cm.push(P.cm.file);
  }
  const folder = cmFolderList().files.map(f => f.path);
  const list = arr => arr.map(p => ({ path: p, name: path.basename(p) }));
  return {
    bgm: list(bgm),
    cm: list([...cm, ...folder.filter(f => !cm.includes(f))]),
    defaultBgm: bgm[0] || null,
    defaultCm: cm[0] || null,
    tight: lastTight(),
  };
}

// 新しい回の ID（日時から。名前は日本語のことが多いので ID には使わない）
function newProjectId() {
  const d = new Date();
  const two = n => String(n).padStart(2, '0');
  const base = `ep-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  let id = base, n = 1;
  while (fs.existsSync(path.join(DATA, id))) id = `${base}-${++n}`;
  return id;
}

function startImport(res, body) {
  const files = Array.isArray(body.files) ? body.files : [];
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) return sendJson(res, 400, { error: '回の名前を入れてください' });
  if (files.length < 2 || files.length > 8) return sendJson(res, 400, { error: '録音は2〜8本にしてください' });
  if (!files.every(isAllowedPath)) return sendJson(res, 400, { error: '使えない場所のファイルがあります' });
  const bases = files.map(f => path.basename(f, path.extname(f)));
  if (new Set(bases).size !== bases.length) return sendJson(res, 400, { error: '同じ名前の録音が2つあります。名前を変えてから入れてください' });
  for (const [what, p] of [['BGM', body.bgm], ['CM', body.cm]]) {
    if (p && !isAllowedPath(p) && !(what === 'CM' && inCmDir(p))) return sendJson(res, 400, { error: `${what} の音源が見つかりません` });
  }
  // 間の詰め方（新しい回の窓のつまみ。無ければ既定）。ui/import.js が自動編集の決まりに直して、切る所を探す。
  // tightChosen: 選んだ値か（前の回から引き継いだ値、か、既定から動かした値）。窓を開いて既定のまま作った回は false にして、
  // 次の回の窓に引き継がない（これが無いと、窓を通した回はいつも「選んだ」に数えられ、次に既定を変えた時に、今日の #508 と
  // 同じく前の既定が引き継がれ続ける・2026-10-19 の監査）
  const tight = step01(body.tight, TIGHT), gap = step01(body.gap, GAP);
  const shown = lastTight(); // 窓が初めに出していた値（前の回で選んだ値か既定）
  const tightChosen = !!shown.from || tight !== TIGHT.def || gap !== GAP.def;
  const id = newProjectId();
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'import.json'), { name, files, bgm: body.bgm || null, cm: body.cm || null,
    tight, gap, tightChosen, createdAt: new Date().toISOString() });
  // うまくいかなかった時は、作りかけの回のフォルダを消す（録音は元の場所のままなので消えない）
  const job = startJob(`import:${id}`, 'import.js', [id], {}, j => {
    if (j.state !== 'done' && !fs.existsSync(path.join(dir, 'project.json'))) fs.rmSync(dir, { recursive: true, force: true });
  });
  sendJson(res, 202, { id, ...jobView(job) });
}

// 元の場所が分からなかったファイルを受け取って置く（途中で切れたら消す）
function receiveUpload(req, res, query) {
  const name = safeName(query.get('name') || 'audio');
  if (!isAudio(name)) return sendJson(res, 400, { error: '音声のファイル（WAV・MP3 など）だけ入れられます' });
  fs.mkdirSync(UPLOADS, { recursive: true });
  const dest = path.join(UPLOADS, `${Date.now()}-${name}`);
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let size = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rmSync(part, { force: true });
    if (!res.headersSent) sendJson(res, code, { error: msg });
  };
  req.on('data', c => { size += c.length; if (size > MAX_UPLOAD) { fail(413, 'ファイルが大きすぎます'); req.destroy(); } });
  req.on('close', () => { if (!req.complete) fail(400, '送るのが途中で止まりました'); });
  out.on('error', () => fail(500, '置けませんでした'));
  out.on('finish', () => {
    if (failed) return;
    fs.renameSync(part, dest);
    sendJson(res, 200, { path: dest });
  });
  req.pipe(out);
}

// 画面に出す AI の設定（鍵そのものは出さない。入っているかだけ）と、「ART19 と Finder を開く」の行き先
function aiView() {
  const { provider, model } = aiChoice();
  return {
    provider,
    model,
    providers: Object.entries(AI).map(([id, a]) => ({ id, label: a.label, model: a.model, keyUrl: a.keyUrl, hasKey: hasKey(id) })),
    art19Url: readSettings().art19Url || ART19_URL,
  };
}

// 前の回の設定（新しい回を初めて開いた時に、画面が引き継ぐ・2026-10-18）。最初の値（BGM 終わり3秒・CM 2秒前から）を入れた後に
// 作った回（project.json の version が 2 以上）のうち、いちばん最近触った回の編集の状態から、回をまたいで同じにしたい物だけ渡す。
// その前に作った回からは引き継がない（古い値で、新しい最初の値を上書きしないように）
const INHERIT_KEYS = ['talkFadeOut', 'exportFormat', 'exportLoudness', 'jumpLead', 'follow', 'rvRepeat', 'showKeys', 'volShow'];
function inheritFor(id) {
  const pick = (o, keys) => (o ? Object.fromEntries(keys.filter(k => o[k] !== undefined && o[k] !== null).map(k => [k, o[k]])) : {});
  for (const x of listProjects()) {
    if (x.id === id) continue;
    const Q = readJson(path.join(DATA, x.id, 'project.json'));
    const S = readJson(path.join(DATA, x.id, 'state.json'));
    if (!Q || !S || !(Q.version >= 2) || (S.projectCreatedAt && S.projectCreatedAt !== Q.createdAt)) continue;
    return { from: Q.name, bgm: pick(S.bgm, ['volume', 'fadeIn', 'fadeOut']), cm: pick(S.cm, ['gap', 'fadeIn', 'fadeOut']), ...pick(S, INHERIT_KEYS) };
  }
  return null;
}

// ---------- 回を消す（ゴミ箱へ） ----------
// 倉田さん「このポッドトリムで作ってるこのファイルたち…どこで消せるの？なんか一生溜まっちゃうじゃん…どうしたらこれって整理できる
// 仕様なの？」（2026-10-19。1回で約260MB）。初めは1回ずつ消す形（「この回を消す…」）にしたが、「一個ずつしか消せないんでしょ？
// 複数で一気にバーッと消せたりもできないしさ」→「Bでお願い、作って→整理する、とかだけでもいいかもしれないけどね」（同じ日）で、
// 回の名前の一覧の「整理する…」の窓（全部の回を並べ、印を付けた回をまとめて消す。回を開かなくてよい）に変えた。
// 消すのは回のフォルダ（回のデータ＝切った所・再生用の声・波形・試聴用の音など）だけ。元の録音・書き出したファイル・BGM・CM は
// 回のフォルダの外にあるので消えない。ゴミ箱を空にするまでは、Finder の「戻す」で元の所に戻せる
// フォルダの大きさ（数えている間に消えた物は数えない。投げるとサーバーごと止まる）
function folderSize(dir) {
  let sum = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      try { sum += e.isDirectory() ? folderSize(p) : e.isFile() ? fs.statSync(p).size : 0; } catch { /* 消えた */ }
    }
  } catch { /* 消えた */ }
  return sum;
}
// ---------- 頭を揃える窓（頭揃えが自動で決まらなかった回・2026-10-23） ----------
// 録音ごとに、冒頭 clap.WINDOW 秒の波形（1ms ごとの山・0〜255 を base64）と手拍子の候補（src/clap.js。大きい音の上位と拍手らしい
// 形の音）、今の手拍子の時刻を返す。今の手拍子は、手で選んだ物 → 自動で揃った録音は基準の手拍子からずれを引いた時刻 → 揃わなかった
// 録音は拍手らしい音の1位（無ければ一番大きい音。guess: true＝確かめてほしい）。生の録音を読むので数秒かかるため、取っておく
const ALIGN_PPS = 1000;
function alignView(dir, project) {
  const cache = path.join(dir, 'work', 'align-view.json');
  const sync = readJson(path.join(dir, 'work', 'sync.json'));
  const hit = readJson(cache);
  if (hit && sync && hit.syncAt === fs.statSync(path.join(dir, 'work', 'sync.json')).mtimeMs) return hit;
  if (!sync) throw new Error('この回には頭揃えの記録がありません（新しい回を作り直してください）');
  const ref = sync.results[0];
  const tracks = project.tracks.map((t, i) => {
    const file = t.source && t.source.file;
    if (!file || !fs.existsSync(file)) throw new Error(`録音が見つかりません: ${file || t.name}`);
    const x = clap.pcm(file, clap.WINDOW, clap.CLAP_RATE);
    const per = clap.CLAP_RATE / ALIGN_PPS;
    const wave = Buffer.alloc(Math.floor(x.length / per));
    let max = 1e-9;
    for (const v of x) if (Math.abs(v) > max) max = Math.abs(v);
    for (let b = 0; b < wave.length; b++) {
      let p = 0;
      for (let k = b * per; k < (b + 1) * per; k++) { const v = Math.abs(x[k]); if (v > p) p = v; }
      wave[b] = Math.round((p / max) * 255);
    }
    const c = clap.clapCandidates(clap.clapPcm(file));
    const top = c.top[0] ? c.top[0].peak : 1;
    const candidates = [];
    for (const s of [...c.clapLike, ...c.top]) {
      if (candidates.some(o => Math.abs(o.t - s.t) < 0.3)) continue;
      candidates.push({ t: +s.t.toFixed(3), size: +(s.peak / top).toFixed(2), clapLike: !!s.clapLike });
    }
    candidates.sort((a, b) => a.t - b.t);
    const r = sync.results[i] || {};
    const pending = (project.alignPending || []).includes(i);
    const sure = clap.syncClap(c);
    let clapAt = Number.isFinite(r.manualClapAt) ? r.manualClapAt
      : i === 0 ? ref.clapAt
        : !pending && Number.isFinite(r.offsetSeconds) && Number.isFinite(ref.clapAt) ? +(ref.clapAt - r.offsetSeconds).toFixed(3) : null;
    const guess = !Number.isFinite(clapAt) || (i === 0 && !ref.syncClap);
    if (!Number.isFinite(clapAt)) clapAt = sure ? sure.t : c.clapLike[0] ? c.clapLike[0].t : c.top[0] ? c.top[0].t : 0;
    return { name: t.name, pending, clapAt: +clapAt.toFixed(3), guess: guess && !sure, candidates, wave: wave.toString('base64') };
  });
  const view = { pps: ALIGN_PPS, window: clap.WINDOW, syncAt: fs.statSync(path.join(dir, 'work', 'sync.json')).mtimeMs, tracks };
  try { writeJson(cache, view); } catch { /* 取っておけなくても、次にまた作るだけ */ }
  return view;
}
// 手拍子の時刻の並び（録音の数だけ・冒頭 clap.WINDOW 秒の中）か
const validClaps = (claps, n) => Array.isArray(claps) && claps.length === n && claps.every(v => Number.isFinite(v) && v >= 0 && v <= clap.WINDOW);

// その回で今動いている仕事（動いている間は消さない）
function busyWith(id) {
  for (const [kind, label] of [['export', '書き出し'], ['describe', '説明文づくり'], ['import', '回づくり']]) {
    const j = jobs.get(`${kind}:${id}`);
    if (j && j.state === 'running') return label;
  }
  return null;
}
function moveToTrash(dir) {
  // 試す時用: 環境変数 HIMADAN_TRASH のフォルダへ移す（Mac のゴミ箱は使わない）
  if (process.env.HIMADAN_TRASH) {
    return new Promise(resolve => {
      fs.mkdirSync(process.env.HIMADAN_TRASH, { recursive: true });
      let to = path.join(process.env.HIMADAN_TRASH, path.basename(dir)), n = 1;
      while (fs.existsSync(to)) to = path.join(process.env.HIMADAN_TRASH, `${path.basename(dir)} ${++n}`);
      fs.renameSync(dir, to);
      resolve();
    });
  }
  // macOS 15 からある trash の命令（入れた物は Finder の「戻す」で戻る。2026-10-19 に試しのフォルダで、入れる→戻すまで確かめた）。
  // 無い Mac（14 まで）は Finder に頼む（初めての時、Podtrim が Finder を動かしてよいかを Mac が聞いてくる）
  const [cmd, args] = fs.existsSync('/usr/bin/trash')
    ? ['/usr/bin/trash', ['-s', dir]]
    : ['osascript', ['-e', `set f to POSIX file ${appleStr(dir)} as alias`, '-e', 'tell application "Finder" to delete f']];
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => (code === 0 && !fs.existsSync(dir) ? resolve()
      : reject(new Error(`ゴミ箱に入れられませんでした（${err.trim().split('\n').pop() || code}）`))));
  });
}

function projectsApi(req, res, parts, query) {
  // parts: ['api', 'projects', id?, 'state' | 'export' | 'asset' | 'trash'?, ...]
  if (parts.length === 2 && req.method === 'GET') {
    // ?detail=1 は「整理する…」の窓用: 大きさ・書き出し済みか・今動いている仕事（動いている回は消せない）も添える
    if (query && query.get('detail') === '1') {
      return sendJson(res, 200, listProjects().map(p => {
        const dir = path.join(DATA, p.id);
        return { ...p, size: folderSize(dir), exported: !!lastExport(dir), busy: busyWith(p.id) };
      }));
    }
    return sendJson(res, 200, listProjects());
  }
  const id = parts[2];
  if (!id || !ID.test(id)) return sendJson(res, 400, { error: '回のIDが不正です' });
  const dir = path.join(DATA, id);
  const project = readJson(path.join(dir, 'project.json'));
  if (!project) return sendJson(res, 404, { error: `回が見つかりません: ${id}` });

  if (parts.length === 3 && req.method === 'GET') {
    const state = readJson(path.join(dir, 'state.json'));
    return sendJson(res, 200, { project, state, inherit: state ? null : inheritFor(id) });
  }
  // 回を消す（ゴミ箱へ。「整理する…」の窓が、印を付けた回ごとに送る）
  if (parts.length === 4 && parts[3] === 'trash' && req.method === 'POST') {
    const busy = busyWith(id);
    if (busy) return sendJson(res, 409, { error: `今、この回の${busy}をしています。終わってから（または「やめる」を押してから）消してください` });
    // 念のため、回の置き場のすぐ下の回のフォルダだけ
    if (path.dirname(path.resolve(dir)) !== path.resolve(DATA)) return sendJson(res, 400, { error: '回のIDが不正です' });
    return moveToTrash(dir).then(() => {
      for (const kind of ['export', 'describe', 'import']) jobs.delete(`${kind}:${id}`);
      sendJson(res, 200, { ok: true, name: project.name, folder: id });
    }).catch(e => sendJson(res, 500, { error: e.message }));
  }
  if (parts.length === 4 && parts[3] === 'state' && req.method === 'PUT') {
    return readBody(req, 5 * 1024 * 1024, text => {
      let state;
      try { state = JSON.parse(text); } catch { return sendJson(res, 400, { error: 'JSON として読めません' }); }
      if (!state || !Array.isArray(state.cuts) || !Array.isArray(state.mutes)) return sendJson(res, 400, { error: 'cuts と mutes が必要です' });
      state.savedAt = new Date().toISOString();
      // 書けなかった時（ディスクが一杯など）は、サーバーごと止まらずに失敗を返す（画面は「保存できませんでした」と出す・2026-10-19 の監査）
      try { writeJson(path.join(dir, 'state.json'), state); } catch (e) { return sendJson(res, 500, { error: `保存できませんでした（${e.message}）` }); }
      sendJson(res, 200, { savedAt: state.savedAt });
    });
  }
  if (parts.length === 5 && parts[3] === 'peaks' && (parts[4] === 'bgm' || parts[4] === 'cm') && req.method === 'GET') {
    assetPeaks(dir, project, parts[4]).then(buf => {
      if (!buf) return sendJson(res, 404, { error: 'ありません' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
    }).catch(e => sendJson(res, 500, { error: e.message }));
    return;
  }
  if (parts.length === 4 && parts[3] === 'asset' && req.method === 'POST') {
    return readJsonBody(req, res, async body => {
      if (body.kind !== 'bgm' && body.kind !== 'cm') return sendJson(res, 400, { error: 'BGM か CM を選んでください' });
      // path が空なら外す。あれば、探す所・CM のフォルダ・送られたファイルの置き場所の中の音声だけ
      const allowed = p => isAllowedPath(p) || inCmDir(p);
      if (body.path && !allowed(body.path)) return sendJson(res, 400, { error: 'その場所のファイルは使えません' });
      try { sendJson(res, 200, { project: await replaceAsset(dir, project, body.kind, body.path ? path.resolve(body.path) : null) }); }
      catch (e) { sendJson(res, 400, { error: e.message }); }
    });
  }
  if (parts[3] === 'export') {
    const key = `export:${id}`;
    const job = jobs.get(key);
    if (parts.length === 4 && req.method === 'GET') {
      // ファイルの名前: 書き出しの窓の欄（?name=）、無ければ回で覚えた名前（state の exportName）、無ければ回の名前。
      // 形ごとの書き出し先と、同じ名前のファイルが既にあるか・置き換えてよいか（その回で前に書き出した物だけ置き換える）を返す
      const st = readJson(path.join(dir, 'state.json'));
      const asked = query && query.get('name');
      const name = asked !== null && asked !== undefined ? asked : st && st.exportName;
      const targets = Object.fromEntries(Object.keys(FORMATS).map(f => {
        const p = targetPath(project, f, name);
        return [f, { path: p, display: shortPath(p), label: FORMATS[f].label, ...overwriteCheck(p, dir) }];
      }));
      const last = lastExport(dir);
      return sendJson(res, 200, { ...jobView(job), targets, name: safeFileName(name) || safeFileName(project.name) || id,
        folder: exportFolderView(), last: last && { ...last, display: shortPath(last.out) } });
    }
    if (parts.length === 4 && req.method === 'POST') {
      // 頭揃え待ちの回は、ずれたまま書き出さない
      if (project.alignPending) return sendJson(res, 409, { error: '頭揃え待ちの回です。上の「頭を揃える」で揃えてから書き出してください' });
      return readJsonBody(req, res, body => {
        const format = FORMATS[body.format] ? body.format : 'wav';
        const name = typeof body.name === 'string' ? safeFileName(body.name) : null;
        sendJson(res, 202, jobView(startJob(key, 'export.js', [id, '--format', format, ...(name ? ['--name', name] : [])], { format })));
      });
    }
    if (parts.length === 5 && parts[4] === 'cancel' && req.method === 'POST') {
      if (job && job.child) { job.cancelled = true; job.child.kill(); }
      return sendJson(res, 200, jobView(job));
    }
    if (parts.length === 5 && parts[4] === 'reveal' && req.method === 'POST') {
      // （説明文の欄の「ART19 と Finder を開く」から）
      // 見せるのは、この回を書き出したファイルだけ（画面から好きな場所を開けないようにする）
      const out = (job && job.result && job.result.out) || (lastExport(dir) || {}).out;
      if (!out || !fs.existsSync(out)) return sendJson(res, 404, { error: '書き出したファイルが見つかりません' });
      spawn('open', ['-R', out], { stdio: 'ignore' }).on('error', () => {});
      return sendJson(res, 200, { ok: true });
    }
  }
  // 頭を揃える窓（頭揃えが自動で決まらなかった回）
  if (parts[3] === 'align') {
    if (parts.length === 4 && req.method === 'GET') {
      try { return sendJson(res, 200, alignView(dir, project)); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    // 選んだ手拍子の 2.5秒前から 4秒を、全員分重ねる（割らずに重ねる。揃っていれば「よーおっ、パン」が1回に聞こえる）
    if (parts.length === 5 && parts[4] === 'preview' && req.method === 'GET') {
      const claps = String((query && query.get('claps')) || '').split(',').map(Number);
      if (!validClaps(claps, project.tracks.length)) return sendJson(res, 400, { error: '手拍子の時刻が正しくありません' });
      if (project.tracks.some(t => !t.source || !t.source.file)) return sendJson(res, 400, { error: 'この回には録音の場所の記録がありません' });
      const inputs = project.tracks.flatMap((t, i) => ['-ss', String(Math.max(0, claps[i] - 2.5)), '-t', '4', '-i', t.source.file]);
      // 手拍子が 2.5秒より前にある録音は、足りない分だけ頭に無音を足して、全員の手拍子を同じ時刻にそろえる
      const pads = claps.map((c, i) => `[${i}:a]aformat=channel_layouts=mono,adelay=${Math.round(Math.max(0, 2.5 - c) * 1000)}:all=1[p${i}]`);
      const mix = `${pads.join(';')};${claps.map((_, i) => `[p${i}]`).join('')}amix=inputs=${claps.length}:normalize=0,alimiter=limit=0.9[out]`;
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', mix, '-map', '[out]', '-ar', '44100', '-f', 'wav', '-'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
      const out = [];
      ff.stdout.on('data', d => out.push(d));
      ff.on('error', () => sendJson(res, 500, { error: '重ねた音を作れませんでした' }));
      ff.on('close', code => {
        if (code !== 0) return sendJson(res, 500, { error: '重ねた音を作れませんでした' });
        const buf = Buffer.concat(out);
        res.writeHead(200, { 'Content-Type': TYPES['.wav'], 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    // 選んだ手拍子を import.json に残し、回づくり（ui/import.js）をもう一度走らせる
    if (parts.length === 4 && req.method === 'POST') {
      return readJsonBody(req, res, body => {
        const busy = busyWith(id);
        if (busy) return sendJson(res, 409, { error: `今、この回の${busy}をしています。終わってから揃えてください` });
        if (!validClaps(body.claps, project.tracks.length)) return sendJson(res, 400, { error: '手拍子の時刻が正しくありません' });
        const imp = readJson(path.join(dir, 'import.json'));
        if (!imp) return sendJson(res, 400, { error: 'この回は画面で作った回ではないので、ここでは揃え直せません' });
        writeJson(path.join(dir, 'import.json'), { ...imp, claps: body.claps.map(v => +v.toFixed(4)), alignedAt: new Date().toISOString() });
        sendJson(res, 202, { id, ...jobView(startJob(`import:${id}`, 'import.js', [id])) });
      });
    }
  }
  // 説明文と目次の下書き（ui/describe.js を別の動きで走らせる）。last は前に作った物（開き直しても出せるように）。
  // exportedAt は今の書き出しの日時（下書きがそれより前なら、前の書き出しから作った物＝画面が「作り直す」を案内する・2026-10-19）
  if (parts[3] === 'describe') {
    const key = `describe:${id}`;
    const job = jobs.get(key);
    if (parts.length === 4 && req.method === 'GET') {
      const ex = lastExport(dir);
      return sendJson(res, 200, { ...jobView(job), last: readJson(path.join(dir, 'description.json')), exported: !!ex, exportedAt: (ex && ex.exportedAt) || null });
    }
    if (parts.length === 4 && req.method === 'POST') {
      return readJsonBody(req, res, body => sendJson(res, 202, jobView(startJob(key, 'describe.js', [id, ...(body.again ? ['--again'] : [])]))));
    }
    if (parts.length === 5 && parts[4] === 'cancel' && req.method === 'POST') {
      if (job && job.child) { job.cancelled = true; job.child.kill(); }
      return sendJson(res, 200, jobView(job));
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

function api(req, res, parts, query) {
  const kind = parts[1];
  if (kind === 'projects') return projectsApi(req, res, parts, query);
  if (kind === 'import' && parts[2] === 'options' && req.method === 'GET') return sendJson(res, 200, importOptions());
  if (kind === 'cm' && parts.length === 2 && req.method === 'GET') {
    // 最近の回で使った CM（新しい回から）も添える。いつもの CM を上に出すため
    const recent = [];
    for (const p of listProjects()) {
      const P = readJson(path.join(DATA, p.id, 'project.json'));
      if (P && P.cm && fs.existsSync(P.cm.file) && !recent.some(r => r.path.normalize('NFC') === P.cm.file.normalize('NFC'))) {
        // 落として入れた CM は「置いた時刻-名前」で置いてあるので、名前だけを出す
        recent.push({ path: P.cm.file, name: path.basename(P.cm.file).replace(/\.[^.]+$/, '').replace(/^\d{10,}-/, '').normalize('NFC'), episode: P.name });
      }
    }
    return sendJson(res, 200, { ...cmFolderList(), recent: recent.slice(0, 5) });
  }
  if (kind === 'cm' && parts[2] === 'folder' && parts.length === 3 && req.method === 'POST') {
    // CM のフォルダを選ぶ窓を出し、選んだ所を覚えて、中身を返す（やめた時は chosen: false で今の中身）
    return chooseFolder('CM の入っているフォルダを選んでください', cmDir()).then(dir => {
      if (dir) writeSettings({ ...readSettings(), cmDir: dir });
      sendJson(res, 200, { chosen: !!dir, ...cmFolderList() });
    }).catch(e => sendJson(res, 500, { error: e.message }));
  }
  if (kind === 'export' && parts[2] === 'folder' && parts.length === 3 && req.method === 'POST') {
    // 書き出し先のフォルダを選ぶ窓を出し、選んだ所を覚える（やめた時は chosen: false で今のまま）。CM のフォルダと同じ形
    if (process.env.HIMADAN_EXPORT) return sendJson(res, 400, { error: '試しの書き出し先が決まっているので、変えられません' });
    return chooseFolder('書き出し先のフォルダを選んでください', exportDir()).then(dir => {
      if (dir) writeSettings({ ...readSettings(), exportDir: dir });
      sendJson(res, 200, { chosen: !!dir, folder: exportFolderView() });
    }).catch(e => sendJson(res, 500, { error: e.message }));
  }
  // 説明文を書く AI（この Mac で選ぶ）。鍵は返さない（入っているかだけ）
  if (kind === 'ai' && parts.length === 2 && req.method === 'GET') return sendJson(res, 200, aiView());
  if (kind === 'ai' && parts.length === 2 && req.method === 'POST') {
    return readJsonBody(req, res, body => {
      const provider = body.provider === 'none' || isAI(body.provider) ? body.provider : null;
      if (!provider) return sendJson(res, 400, { error: 'AI を選んでください' });
      try {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (key) {
          // 鍵は英数字と記号だけの1行（貼り付けで改行や空白が混ざったら断る）
          if (provider === 'none' || key.length > 400 || /\s/.test(key)) return sendJson(res, 400, { error: '鍵の形が違います（コピーし直して貼ってください）' });
          setKey(provider, key);
        }
        const model = typeof body.model === 'string' ? body.model.trim().slice(0, 100) : '';
        writeSettings({ ...readSettings(), ai: { provider, ...(model ? { model } : {}) } });
        sendJson(res, 200, aiView());
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }
  if (kind === 'ai' && parts[2] === 'forget' && parts.length === 3 && req.method === 'POST') {
    return readJsonBody(req, res, body => {
      if (!isAI(body.provider)) return sendJson(res, 400, { error: 'AI を選んでください' });
      deleteKey(body.provider);
      sendJson(res, 200, aiView());
    });
  }
  if (kind === 'files' && parts[2] === 'resolve' && req.method === 'POST') {
    return readJsonBody(req, res, body => {
      const files = (Array.isArray(body.files) ? body.files : []).slice(0, 16)
        .map(f => ({ name: String(f.name || ''), size: Number(f.size) || 0, lastModified: Number(f.lastModified) || 0 }));
      const found = findOriginals(files);
      sendJson(res, 200, { paths: found, display: found.map(shortPath) });
    });
  }
  if (kind === 'uploads' && parts.length === 2 && req.method === 'PUT') return receiveUpload(req, res, query);
  if (kind === 'imports') {
    if (parts.length === 2 && req.method === 'POST') return readJsonBody(req, res, body => startImport(res, body));
    const id = parts[2];
    if (!id || !ID.test(id)) return sendJson(res, 400, { error: '回のIDが不正です' });
    const job = jobs.get(`import:${id}`);
    if (parts.length === 3 && req.method === 'GET') return sendJson(res, 200, { id, ...jobView(job) });
    if (parts.length === 4 && parts[3] === 'cancel' && req.method === 'POST') {
      if (job && job.child) { job.cancelled = true; job.child.kill(); }
      return sendJson(res, 200, { id, ...jobView(job) });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

function serveFile(req, res, url) {
  // /data/... は回のデータ（リポジトリの外）、それ以外は画面のファイル
  const isData = url.startsWith('/data/');
  const base = isData ? DATA : ROOT;
  const rel = isData ? url.slice('/data/'.length) : url === '/' ? 'index.html' : url.slice(1);
  const file = path.join(base, rel);
  // 置き場所の外へ出さない
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    let start = 0, end = st.size - 1, code = 200;
    // 音声はシーク（Rangeリクエスト）に応える必要がある
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const [a, b] = range.replace('bytes=', '').split('-');
      if (a === '' && b) {
        // 末尾から N バイト（bytes=-N）
        start = Math.max(0, st.size - Number(b));
      } else {
        start = Number(a) || 0;
        end = b ? Math.min(Number(b), st.size - 1) : st.size - 1;
      }
      if (!(start <= end) || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      code = 206;
    }
    const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(code, headers);
    // 読んでいる途中でファイルが作り直されると読み込みのエラーになる。拾わないとサーバーごと止まる
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

http
  .createServer((req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403).end(); return; }
    // 書き換える依頼（保存・書き出し・取り込み・Finder で見せる）は、この画面からのものだけ受ける。
    // 別のサイトのページが、見ている人のブラウザを通して書き出しを始めたりファイルを置いたりできないようにする。
    // この画面は依頼に「x-himadan」という印を付ける。よそのページは、このサーバーの許可なしには印を付けて送れない（許可は出さない）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) { res.writeHead(403).end(); return; }
      if (req.headers['x-himadan'] !== '1') { res.writeHead(403).end(); return; }
    }
    // 壊れた形のアドレス（%E0%A4%A など）は decodeURIComponent が例外を投げる。
    // 拾わないとサーバーごと止まった（2026-10-17 の監査で、1回送るだけで止まるのを確認）
    let url, query;
    try {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      url = decodeURIComponent(u.pathname);
      query = u.searchParams;
    } catch { res.writeHead(400).end('bad request'); return; }
    const parts = url.split('/').filter(Boolean);
    if (parts[0] === 'api') {
      // 思わぬ例外で、サーバーごと止まらないように（止まるとアプリも閉じる・2026-10-19 の監査）。その依頼だけ失敗を返す
      try { return api(req, res, parts, query); } catch (e) {
        console.error(e);
        if (!res.headersSent) sendJson(res, 500, { error: `サーバーで思わぬ失敗がありました（${e.message}）` });
        return;
      }
    }
    serveFile(req, res, url);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
