#!/usr/bin/env node
// Podtrim の Mac のアプリ（Podtrim.app）を組み立てて、~/Applications に置く。
// 前の名前（ひま談編集.app）が残っていて、開いていなければゴミ箱に入れる（消しはしない）
//
//   node app/build.js                 … 組み立てて ~/Applications に置く（前のものは置き換える）
//   node app/build.js --no-install    … dist/ に組み立てるだけ
//   node app/build.js --download-only … Electron の zip を用意するだけ（場所を出す）
//
// - Electron（ブラウザの部品ごと Mac のアプリにする仕組み）は、この Mac の取っておき（~/Library/Caches/electron の zip。
//   前に他の道具が入れたもの）のいちばん新しい版を使う。ただし決まった版（ELECTRON_VERSION）より古い取っておきは使わない
//   （2026-10-22。更新の止まった古い版で組み立てないように）。ELECTRON_ZIP=<electron-vX.Y.Z-darwin-arm64.zip> で場所を渡してもよい。
//   使える取っておきが無い Mac（かいちさん・のりさんの Mac など）では、Electron の公式の置き場（GitHub の Releases）から決まった版
//   （ELECTRON_VERSION）を1回だけ落として取っておき、公式の SHASUMS256.txt と指紋（SHA-256）が
//   合うかを確かめてから使う（2026-10-19。前は取っておきが無いと止まった）。ブラウザでなく curl で落とすので、Mac の「インターネット
//   から落とした物」の印が付かず、組み立てたアプリが Mac に止められない。ELECTRON_MIRROR で置き場を変えられる（試す時は file://）
// - アプリは画面とサーバーを持たず、このリポジトリの ui/ をそのまま動かす（直したら作り直さなくてよい）。
//   作り直すのは、リポジトリを動かした時・app/ を直した時だけ
// - アイコンは app/icon.svg から作る（Quick Look → sips → iconutil。どれも Mac に入っている道具）
// - 中身を変えるので、この Mac だけで使う簡易の署名（ad-hoc）をし直す。人に配る時は Apple の開発者の証明書で署名し直す
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = 'Podtrim'; // 2026-10-18 に倉田さんが決めた名前
const BUNDLE_ID = 'jp.himapro.podtrim';
const OLD_NAMES = ['ひま談編集']; // 前の名前
const install = !process.argv.includes('--no-install');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

// Mac 本体の形（Apple のチップか Intel か）。node の形では決めない（この Mac の node は Intel 版を Rosetta で動かしていて、
// node から見ると x64 になる）
function machineArch() {
  try { return run('sysctl', ['-n', 'hw.optional.arm64']).toString().trim() === '1' ? 'arm64' : 'x64'; } catch { return process.arch === 'arm64' ? 'arm64' : 'x64'; }
}
const ARCH = process.env.ELECTRON_ARCH || machineArch();

// 2026-10-22 に 41.10.4 から上げた（41 系は更新が止まった）。中の Node は 24.22.0 で、2026-10-21 の Node のセキュリティの直し
// （24.22.1）はまだ入っていない＝44 系の次の版待ち
const ELECTRON_VERSION = process.env.ELECTRON_VERSION || '44.9.3';
const MIRROR = (process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/').replace(/\/?$/, '/');

// 取っておきが無い時: 公式の置き場から落として、公式の指紋と合うかを確かめてから、取っておきの場所に置く
function downloadZip(cacheDir) {
  const name = `electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip`;
  const base = `${MIRROR}v${ELECTRON_VERSION}/`;
  const dir = path.join(cacheDir, 'podtrim');
  const file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  // 公式の指紋の一覧（例: 「b42de7… *electron-v41.10.4-darwin-arm64.zip」）
  const sums = execFileSync('curl', ['-fsSL', `${base}SHASUMS256.txt`]).toString();
  const line = sums.split('\n').map(l => l.trim().split(/\s+/)).find(([, f]) => f && f.replace(/^\*/, '') === name);
  if (!line) throw new Error(`公式の指紋の一覧に ${name} がありません（版 ${ELECTRON_VERSION} を確かめてください）`);
  console.log(`Electron ${ELECTRON_VERSION}（${ARCH}・約120MB）を落としています（初めの1回だけ。取っておくので、次からは落としません）…`);
  const part = `${file}.part`;
  try {
    execFileSync('curl', ['-fL', '--retry', '2', '-o', part, `${base}${name}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    const got = crypto.createHash('sha256').update(fs.readFileSync(part)).digest('hex');
    if (got !== line[0]) throw new Error(`落とした Electron の指紋が公式と合いません（${name}）。もう一度試してください`);
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(part, { force: true });
  }
  return file;
}

// いちばん新しい Electron の zip（この Mac の形〈arm64 / x64〉のもの）。決まった版より古いものしか無ければ公式から落とす
function findZip() {
  if (process.env.ELECTRON_ZIP) return process.env.ELECTRON_ZIP;
  const dir = process.env.ELECTRON_CACHE_DIR || path.join(os.homedir(), 'Library', 'Caches', 'electron');
  const zips = [];
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const sub = path.join(dir, d);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      const m = /^electron-v(\d+)\.(\d+)\.(\d+)-darwin-(arm64|x64)\.zip$/.exec(f);
      if (m && m[4] === ARCH) zips.push({ file: path.join(sub, f), v: m.slice(1, 4).map(Number) });
    }
  }
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  zips.sort((a, b) => cmp(b.v, a.v));
  return zips.length && cmp(zips[0].v, ELECTRON_VERSION.split('.').map(Number)) >= 0 ? zips[0].file : downloadZip(dir);
}

function build() {
  const zip = findZip();
  if (process.argv.includes('--download-only')) { console.log(`Electron の zip: ${zip}`); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'himadan-app-'));
  try {
    // 1) Electron を広げて、名前を付けて dist/ に置く
    run('ditto', ['-x', '-k', zip, work]);
    const dist = path.join(ROOT, 'dist');
    const appDir = path.join(dist, `${NAME}.app`);
    fs.mkdirSync(dist, { recursive: true });
    fs.rmSync(appDir, { recursive: true, force: true });
    run('ditto', [path.join(work, 'Electron.app'), appDir]);
    const res = path.join(appDir, 'Contents', 'Resources');

    // 2) 中に入れる物: 起動の仕組み（main.js）と、リポジトリの場所
    fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
    const inner = path.join(res, 'app');
    fs.mkdirSync(inner, { recursive: true });
    for (const f of ['main.js', 'package.json']) fs.copyFileSync(path.join(__dirname, f), path.join(inner, f));
    fs.writeFileSync(path.join(inner, 'config.json'), `${JSON.stringify({ repo: ROOT }, null, 2)}\n`);

    // 3) アイコン: icon.svg → 1024 ドットの画像 → いろいろな大きさ → icns
    run('qlmanage', ['-t', '-s', '1024', '-o', work, path.join(__dirname, 'icon.svg')]);
    const png = path.join(work, 'icon.svg.png');
    const iconset = path.join(work, 'icon.iconset');
    fs.mkdirSync(iconset);
    for (const s of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(s), String(s), png, '--out', path.join(iconset, `icon_${s}x${s}.png`)]);
      run('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(iconset, `icon_${s}x${s}@2x.png`)]);
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', path.join(res, 'electron.icns')]);

    // 4) Dock とメニューに出る名前・アプリの ID
    const plist = path.join(appDir, 'Contents', 'Info.plist');
    for (const [k, v] of [['CFBundleName', NAME], ['CFBundleDisplayName', NAME], ['CFBundleIdentifier', BUNDLE_ID]]) {
      run('plutil', ['-replace', k, '-string', v, plist]);
    }

    // 5) 中身を変えたので、署名し直す（この Mac だけで使う簡易の署名）
    run('codesign', ['--force', '--deep', '--sign', '-', appDir]);
    run('codesign', ['--verify', '--deep', appDir]);

    // 6) ~/Applications に置く
    let placed = appDir;
    const notes = [];
    if (install) {
      const apps = path.join(os.homedir(), 'Applications');
      fs.mkdirSync(apps, { recursive: true });
      placed = path.join(apps, `${NAME}.app`);
      fs.rmSync(placed, { recursive: true, force: true });
      run('ditto', [appDir, placed]);
      // 前の名前のアプリ: 開いていなければゴミ箱へ入れる（消しはしない）。開いている時・入れられない時は知らせるだけ
      for (const old of OLD_NAMES) {
        const p = path.join(apps, `${old}.app`);
        if (!fs.existsSync(p)) continue;
        let running = true;
        try { run('pgrep', ['-f', `${p}/Contents/MacOS/`]); } catch { running = false; }
        if (!running) {
          try {
            const trash = path.join(os.homedir(), '.Trash');
            const dest = fs.existsSync(path.join(trash, `${old}.app`)) ? path.join(trash, `${old} ${Date.now()}.app`) : path.join(trash, `${old}.app`);
            fs.renameSync(p, dest);
            notes.push(`前の名前のアプリ（${old}）はゴミ箱に入れました`);
            continue;
          } catch { /* ゴミ箱に入れられない時は、知らせるだけ */ }
        }
        notes.push(`前の名前のアプリ（${old}）が残っています。${running ? '閉じてから、' : ''}Finder でゴミ箱に入れてください: ${p}`);
      }
    }
    const ver = /electron-v([\d.]+)-/.exec(path.basename(zip))[1];
    console.log(`できました: ${placed}\n  Electron ${ver}（${ARCH}）・リポジトリ ${ROOT}\n  開く: open "${placed}"\n  Dock に置く: Finder でこのアプリを Dock へドラッグ${notes.map(n => `\n  ${n}`).join('')}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  build();
} catch (e) {
  console.error(`アプリを作れませんでした: ${e.message}${e.stderr ? `\n${String(e.stderr).slice(-800)}` : ''}`);
  process.exit(1);
}
