// 画面に落とされたファイルの「元の場所」を探す。
//
// ブラウザは、落とされたファイルの場所（パス）をページに教えない（名前・大きさ・更新日時だけ）。
// 録音は1本 400MB 以上あるので、毎回コピーすると回ごとに 1.5GB 近く増える。そこで、録音を置きそうな
// フォルダから「名前・大きさ・更新日時」が同じファイルを探し、見つかればその場所をそのまま使う（読むだけ）。
// 見つからない時だけ、画面からサーバーへ送って回のデータの置き場所にコピーする。
// （Mac のアプリにしたら、落とされたファイルの場所が分かるので探さなくてよくなる）

const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA = require('./data-dir');

const AUDIO_EXT = new Set(['.wav', '.aif', '.aiff', '.mp3', '.m4a', '.aac', '.flac', '.caf']);
const isAudio = name => AUDIO_EXT.has(path.extname(String(name)).toLowerCase());

// 探す所（フォルダと、潜る深さ）。環境変数 HIMADAN_SEARCH（: 区切り）で変えられる（試す時用）。
// 書類フォルダだけにする。ダウンロードやデスクトップを読むと、Mac が「アクセスを許可しますか」と急に聞いてくることがあるため
// （録音はいつも ~/Documents/Podcast に置いてある。見つからなければコピーで足りる）
function searchRoots() {
  if (process.env.HIMADAN_SEARCH) return process.env.HIMADAN_SEARCH.split(':').filter(Boolean).map(dir => ({ dir, depth: 3 }));
  const home = os.homedir();
  return [
    { dir: path.join(home, 'Documents', 'Podcast'), depth: 3 },
    { dir: path.join(home, 'Documents'), depth: 1 },
  ];
}

function walk(dir, depth, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1, onFile); }
    else if (e.isFile() && isAudio(e.name)) onFile(p);
  }
}

// 名前・大きさ・更新日時（2秒の幅）が同じファイルを探す。files: [{ name, size, lastModified }] → [場所 | null]。
// 名前は濁点の持ち方をそろえてから比べる（Mac のファイル名は「テ」を1文字でも「テ＋濁点」でも持つため）
function findOriginals(files) {
  const want = files.map(f => ({ ...f, name: String(f.name).normalize('NFC'), found: null }));
  for (const { dir, depth } of searchRoots()) {
    if (want.every(w => w.found)) break;
    walk(dir, depth, p => {
      const base = path.basename(p).normalize('NFC');
      for (const w of want) {
        if (w.found || w.name !== base) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.size === w.size && (!w.lastModified || Math.abs(st.mtimeMs - w.lastModified) < 2000)) w.found = p;
      }
    });
  }
  return want.map(w => w.found);
}

// 画面から送られたファイルの置き場所（回のデータの置き場所の中）
const UPLOADS = path.join(DATA, '_uploads');

// 画面から渡された場所を使ってよいか（探す所の中か、送られたファイルの置き場所の中にある音声ファイルだけ）。
// 好きな場所のファイルをサーバーに読ませないため
function isAllowedPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !isAudio(p)) return false;
  const real = path.resolve(p);
  const roots = [...searchRoots().map(r => r.dir), UPLOADS];
  return roots.some(r => real.startsWith(path.resolve(r) + path.sep)) && fs.existsSync(real) && fs.statSync(real).isFile();
}

// 送られたファイルの名前を、置いても安全な名前にする（フォルダの区切りや先頭の点を取る）
function safeName(name) {
  const base = path.basename(String(name)).replace(/[\\/:\0]/g, '_').replace(/^\.+/, '');
  return base.slice(-150) || 'audio';
}

module.exports = { AUDIO_EXT, isAudio, searchRoots, findOriginals, isAllowedPath, safeName, UPLOADS };
