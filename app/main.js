// Podtrim（ポッドキャストの3人の録音を、別々のまま編集して1本にするアプリ。前の名前は「ひま談 編集」）を、
// Mac のアプリとして開く（Dock から開ける）。中身は今の画面とサーバー（ui/serve.js）そのもの。
// アプリの作り方: node app/build.js（この Mac の Electron の取っておきから「Podtrim.app」を組み立てて ~/Applications に置く）
//
// - アプリは画面とサーバーを持たず、リポジトリの ui/ をそのまま動かす（直したら、アプリを作り直さなくても次に開いた時から効く）
// - サーバーは Electron の中の Node で動かす（ターミナルの node は要らない）。使っていない番号の窓口で、この Mac の中だけで待ち受ける
// - 窓を閉じたら終わる。終わる時は、画面の最後の保存を受け取ってからサーバーを止める（書き出し中なら書き出しも止まる）
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// リポジトリの場所（build.js が組み立てる時に書き込む）
const conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SERVE = path.join(conf.repo, 'ui', 'serve.js');
const APP = 'Podtrim'; // アプリの名前（2026-10-18 に倉田さんが決めた）
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'podtrim.log');
// 確かめる用: このファイルの場所を渡すと、画面が開いた所の画像を保存して終わる
const SELFTEST = process.env.HIMADAN_APP_SELFTEST;

// Dock から開いたアプリは、ターミナルの PATH を持たない（ffmpeg が見つからない）
process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');

let server = null, win = null, port = 0, quitting = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function ping() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/projects', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (!fs.existsSync(SERVE)) {
    throw new Error(`編集の画面のプログラムが見つかりません（${SERVE}）。\nリポジトリを動かした時は、node app/build.js でアプリを作り直してください。`);
  }
  port = await freePort();
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const log = fs.openSync(LOG, 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} 起動（窓口 ${port}・${SERVE}）\n`);
  server = spawn(process.execPath, [SERVE, String(port)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log, log] });
  server.on('exit', code => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox(APP, `サーバーが止まりました（${code}）。アプリを開き直してください。\n記録: ${LOG}`);
      app.quit();
    }
  });
  for (let i = 0; i < 100; i++) {
    if (await ping()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`サーバーが10秒たっても応えません。\n記録: ${LOG}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    title: APP, backgroundColor: '#1d1e21', show: !SELFTEST,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const home = `http://127.0.0.1:${port}/`;
  win.loadURL(home);
  // この画面の外へは移らない（ファイルを落とす所を外した時に、ファイルを開いて画面が消えないように）
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(home)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(home)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  if (SELFTEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 3000));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SELFTEST, img.toPNG());
      app.quit();
    });
  }
}

// メニュー。⌘Z・⌘T・⌘＋・⌘−・⌘0 は画面の操作（元に戻す・分割・拡大）に使うので、メニューには入れない（入れると画面に届かない）
function setMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about', label: `${APP} について` }, { type: 'separator' },
      { role: 'hide', label: `${APP} を隠す` }, { role: 'hideOthers', label: 'ほかを隠す' }, { role: 'unhide', label: 'すべてを表示' },
      { type: 'separator' }, { role: 'quit', label: `${APP} を終了` },
    ] },
    { label: '編集', submenu: [{ role: 'cut', label: '切り取り' }, { role: 'copy', label: 'コピー' }, { role: 'paste', label: '貼り付け' }, { role: 'selectAll', label: 'すべてを選択' }] },
    { label: '表示', submenu: [{ role: 'reload', label: '読み込み直す' }, { role: 'togglefullscreen', label: 'フルスクリーン' }, { type: 'separator' }, { role: 'toggleDevTools', label: '開発者ツール' }] },
    { label: 'ウインドウ', submenu: [{ role: 'minimize', label: 'しまう' }, { role: 'zoom', label: '拡大／縮小' }, { role: 'close', label: '閉じる' }] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // もう開いている時は、そちらを前に出す（second-instance）
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    setMenu();
    try {
      await startServer();
    } catch (e) {
      dialog.showErrorBox(APP, e.message);
      quitting = true;
      app.quit();
      return;
    }
    createWindow();
  });
  // Dock のアイコンを押した時、窓が無ければ開き直す
  app.on('activate', () => { if (!win && server) createWindow(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; });
  // 画面が閉じる直前に送る最後の保存を受け取ってから、サーバーを止める
  app.on('will-quit', e => {
    if (!server) return;
    e.preventDefault();
    const s = server;
    server = null;
    setTimeout(() => { s.kill('SIGTERM'); app.quit(); }, 500);
  });
}
