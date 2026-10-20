#!/usr/bin/env node
// 書き出しと一緒に、配信用のタイトル・説明文を出す。
//
//   node src/shownotes.js <cuts.json> <chapters.json> <出力.md>
//
// 肝は「時刻の変換」。目次のタイムスタンプは文字起こし（＝カット前）を見て作るが、
// 配信するのはカット後の音声なので、そのままでは全部ずれる。
// カットリストから逆算して、カット後のタイムラインへ自動で直す。
//
// chapters.json の形:
//   { "title": "...", "intro": "...", "chapters": [ { "at": 58, "label": "..." }, ... ] }
//   at は「カット前（元音源）の秒数」

const fs = require('fs');

const FOOTER = `\n\n${require('./footer')}\n`; // 定型（src/footer.js。画面の説明文づくりと同じ物）

const planPath = process.argv[2];
const chapPath = process.argv[3];
const outPath = process.argv[4];
if (!planPath || !chapPath || !outPath) {
  console.error('usage: node src/shownotes.js <cuts.json> <chapters.json> <out.md>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const doc = JSON.parse(fs.readFileSync(chapPath, 'utf8'));

// カット前の時刻 t が、カット後のどこに来るか
function mapTime(t) {
  let removed = 0;
  for (const [s, e] of plan.cuts) {
    if (e <= t) removed += e - s;
    else if (s < t) return { at: s - removed, inCut: true }; // カットの中に落ちた
    else break;
  }
  return { at: t - removed, inCut: false };
}

const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const warnings = [];
const lines = (doc.chapters || []).map(c => {
  const m = mapTime(c.at);
  if (m.inCut) warnings.push(`${fmt(c.at)} 「${c.label}」はカットされた区間に入っています（継ぎ目の位置に寄せました）`);
  return `${fmt(m.at)} ${c.label}`;
});

const body =
  (doc.intro || '').trim() +
  (lines.length ? `\n\n▼目次\n${lines.join('\n')}` : '') +
  FOOTER;

const out =
  `# ${doc.title || '(タイトル未設定)'}\n\n` +
  `> カット後のタイムラインに変換済み（元音源から ${(plan.removedSeconds || 0).toFixed(0)} 秒削除）\n\n` +
  '## タイトル\n\n```\n' + (doc.title || '') + '\n```\n\n' +
  '## 説明文（そのままコピペ）\n\n```\n' + body + '```\n' +
  (warnings.length ? `\n## 注意\n\n${warnings.map(w => `- ${w}`).join('\n')}\n` : '');

fs.writeFileSync(outPath, out);
console.log(
  JSON.stringify(
    {
      out: outPath,
      章立て: lines.length,
      削除秒数: +(plan.removedSeconds || 0).toFixed(1),
      注意: warnings.length,
      変換例: (doc.chapters || []).slice(0, 3).map(c => `${fmt(c.at)} → ${fmt(mapTime(c.at).at)}  ${c.label}`),
    },
    null,
    2
  )
);
