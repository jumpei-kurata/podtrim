#!/usr/bin/env node
// 試す時の偽の mlx_whisper（説明文づくり ui/describe.js の確かめ用）。本物と同じ引数を受け、決まった文字起こしを
// <--output-dir>/<--output-name>.json に書き、本物と同じ形の進み具合の行を出す。空耳（同じ文のくり返し）も混ぜる
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const segments = [
  { start: 0, end: 4.2, text: 'この番組はエンジニアの成長は楽しい学びからをモットーにお届けします' },
  { start: 4.2, end: 9.8, text: '今日はテストの回です' },
  { start: 30.5, end: 35, text: '本題に入ります' },
  { start: 40, end: 41, text: 'ご視聴ありがとうございました' },
  { start: 41, end: 42, text: 'あはは' },
  { start: 42, end: 43, text: 'あはは' },
  { start: 43, end: 44, text: 'あはは' },
  { start: 44, end: 48, text: 'おしまいです' },
];
// HIMADAN_FAKE_WHISPER_WAIT（秒）だけ待ってから書く（作る途中の「やめる」を確かめる時）
setTimeout(() => {
  for (const s of segments) console.log(`[00:${s.start.toFixed(3).padStart(6, '0')} --> 00:${s.end.toFixed(3).padStart(6, '0')}] ${s.text}`);
  fs.writeFileSync(path.join(opt('--output-dir'), `${opt('--output-name')}.json`), JSON.stringify({ text: segments.map(s => s.text).join(''), segments, language: 'ja' }));
}, Number(process.env.HIMADAN_FAKE_WHISPER_WAIT || 0) * 1000);
