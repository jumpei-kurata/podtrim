// 回をまたいで使う設定（この Mac で覚える）。回の置き場の隣の settings.json（~/Library/Application Support/himadan-edit/）と、
// 説明文を書く AI の鍵（Mac のキーチェーン＝パスワードを入れておく所）。鍵は settings.json にも画面にも置かない。
//
// settings.json: { cmDir, exportDir, ai: { provider, model }, art19Url?, rssUrl?, showName?, descFooter? }
//   cmDir      … CM のフォルダ（画面の CM の欄の「フォルダを選ぶ…」）
//   exportDir  … 書き出し先のフォルダ（書き出しの窓の「変更…」・ui/export.js）
//   ai         … 説明文を書く AI（'gemini' | 'claude' | 'openai' | 'none'）と、モデルの名前（空なら下の既定）
//   art19Url・rssUrl・showName・descFooter … 番組を変える時だけ（無ければひまじんプログラマーの物。ui/serve.js・ui/describe.js）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const DATA = require('./data-dir');

const SETTINGS = path.join(path.dirname(DATA), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${SETTINGS}.tmp`, SETTINGS);
}

// 説明文を書く AI（人それぞれ選ぶ。倉田さん「お金をかけるのか、お金をかけないのか、人それぞれだし、それがオープン AI なのか、
// クロードなのか、ジェミニなのか、人それぞれ」・2026-10-18）。Gemini は無料枠があるので、おすすめとして先頭に。
// モデルは画面の設定で変えられる。Gemini は無料枠で使えるいちばん新しい Flash（gemini-3.8-flash・2026-09-02 一般公開）。
// 前は「最新の Flash」を指す名前 gemini-flash-latest だったが、5月の Gemini 3.5 Flash のまま動いておらず、10/8 に 3.5 が引退して
// 3.6 Flash に回されていた（倉田さん「ジェミニからめっちゃ古い情報飛んできた気がする…ジェミニ4がつい最近出てきたと思うんだけど」・
// 2026-10-19・https://ai.google.dev/gemini-api/docs/changelog）。Gemini 4（gemini-4-argon・10/13 一般公開）は無料枠に無い（課金が要る）。
// light は、混んでいて（5xx）やり直してもだめな時に試す軽いモデル（ui/describe.js）。Gemini は無料枠の Flash-Lite でいちばん新しい
// gemini-3.5-flash-lite（2026-10-23・https://ai.google.dev/gemini-api/docs/models と pricing で確かめた）
const AI = {
  gemini: { label: 'Gemini（Google・無料枠あり）', model: 'gemini-3.8-flash', light: 'gemini-3.5-flash-lite', keyUrl: 'https://aistudio.google.com/apikey' },
  claude: { label: 'Claude（Anthropic・有料）', model: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI（有料）', model: 'gpt-5-mini', keyUrl: 'https://platform.openai.com/api-keys' },
};
// 上の一覧にある名前か（「constructor」など、どの物にもある名前を AI と取り違えないように）
const isAI = p => typeof p === 'string' && Object.prototype.hasOwnProperty.call(AI, p);
const aiChoice = () => {
  const a = readSettings().ai || {};
  const provider = isAI(a.provider) ? a.provider : 'none';
  return { provider, model: (provider !== 'none' && a.model) || (AI[provider] ? AI[provider].model : null) };
};

// 鍵はキーチェーンに「podtrim-ai-<AI の名前>」で置く（security コマンド）。試す時は環境変数 HIMADAN_AI_KEY が先に効き、
// 入れる・消すもキーチェーンを触らない（試しで本物の鍵を書き換えないように）
const SERVICE = p => `podtrim-ai-${p}`;
const TESTING = () => process.env.HIMADAN_AI_KEY !== undefined;
function getKey(provider) {
  if (TESTING()) return process.env.HIMADAN_AI_KEY || null;
  const r = spawnSync('security', ['find-generic-password', '-a', 'podtrim', '-s', SERVICE(provider), '-w'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
// 入っているかだけ（中身は読まない。画面の「鍵: 入っています」用）
function hasKey(provider) {
  if (TESTING()) return !!process.env.HIMADAN_AI_KEY;
  return spawnSync('security', ['find-generic-password', '-a', 'podtrim', '-s', SERVICE(provider)], { encoding: 'utf8' }).status === 0;
}
function setKey(provider, key) {
  if (TESTING()) return;
  const r = spawnSync('security', ['add-generic-password', '-U', '-a', 'podtrim', '-s', SERVICE(provider), '-l', `Podtrim ${provider}`, '-w', key], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`鍵をキーチェーンに置けませんでした（${(r.stderr || '').trim().slice(0, 200)}）`);
}
function deleteKey(provider) {
  if (TESTING()) return;
  spawnSync('security', ['delete-generic-password', '-a', 'podtrim', '-s', SERVICE(provider)], { encoding: 'utf8' });
}

module.exports = { SETTINGS, readSettings, writeSettings, AI, isAI, aiChoice, getKey, hasKey, setKey, deleteKey };
