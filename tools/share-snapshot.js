#!/usr/bin/env node
// 公開用（GitHub の jumpei-kurata/podtrim・公開。かいちさん・のりさんもここから clone・倉田さんのプロフィールにピン止め）の中身を、
// 指定したフォルダに書き出す（2026-10-19。初めは組織の非公開にする予定だったが、同じ日に倉田さんの公開1つにした）。
//
//   node tools/share-snapshot.js <書き出し先のフォルダ>
//
// - このリポジトリの git に入っている物（git ls-files）を写す。外す物: .claude/（作業用）・work2/（古い試しの結果。倉田さんの Mac の
//   パスが入る）・docs/intent/（倉田さんとの会話の記録）・tools/chunked-transcribe.js（倉田さんの Claude のスキルが要る）
// - README.md は docs/share-README.en.md（英語・就活のポートフォリオにも）、README.ja.md は docs/share-README.md（日本語の入れ方と
//   使い方）、このリポジトリの README.md（開発のメモ）は docs/development.md に置く
// - 書き出し先には git のフォルダ（.git）以外を置かないこと（前の中身は、書き出す前に git rm などで外しておく）。履歴は共有用の
//   リポジトリだけに残る（このリポジトリの履歴・作者のメールは出さない）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2];
if (!out) { console.error('usage: node tools/share-snapshot.js <書き出し先のフォルダ>'); process.exit(1); }
const dest = path.resolve(out);
if (dest === ROOT || dest.startsWith(ROOT + path.sep)) { console.error('このリポジトリの中には書き出せません'); process.exit(1); }
// 書き出し先は、無いか、git のフォルダ（.git）しか無い所だけ（2026-10-19。cd が効かずに別の場所〈vault〉で「.」を渡してしまい、
// vault の README と .gitignore を上書きした。中身のある所には書かない）
const already = fs.existsSync(dest) ? fs.readdirSync(dest).filter(f => f !== '.git') : [];
if (already.length) { console.error(`書き出し先が空ではありません（${dest}・${already.slice(0, 5).join('・')}${already.length > 5 ? ' ほか' : ''}）。止めました`); process.exit(1); }

const SKIP = [/^\.claude\//, /^work2\//, /^docs\/intent\//, /^tools\/chunked-transcribe\.js$/, /^docs\/share-README(\.en)?\.md$/];
const RENAME = { 'README.md': 'docs/development.md' };
// 置き場所が変わる文書のリンクを直す（開発のメモは docs/ の中に移る・README は入れ方と使い方になる）
const FIX = {
  'README.md': s => s.replace(/\]\(docs\//g, ']('),
  'docs/guide.md': s => s.replace('[README](../README.md) の「編集画面」', '[開発のメモ](development.md) の「編集画面」'),
};

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
let n = 0;
for (const f of files) {
  if (SKIP.some(r => r.test(f))) continue;
  const to = path.join(dest, RENAME[f] || f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (FIX[f]) fs.writeFileSync(to, FIX[f](fs.readFileSync(path.join(ROOT, f), 'utf8')));
  else fs.copyFileSync(path.join(ROOT, f), to);
  n++;
}
fs.copyFileSync(path.join(ROOT, 'docs', 'share-README.en.md'), path.join(dest, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'docs', 'share-README.md'), path.join(dest, 'README.ja.md'));
console.log(`${n + 2} ファイルを書き出しました: ${dest}`);
