#!/usr/bin/env node
// 試す時の偽の AI と RSS（説明文づくり ui/describe.js の確かめ用）。Gemini・Claude・OpenAI の窓口の形で、決まった下書きを返す。
// 受け取った頼みの中身は、最後の1つを <記録のファイル> に書く（文字起こしが渡っているかを確かめるため）
//   node test/fake-ai.js <port> [記録のファイル]
const http = require('http');
const fs = require('fs');
const [port, logFile] = process.argv.slice(2);

const draft = {
  titles: ['#508 偽のタイトル（おすすめ）', '#508 偽のタイトル2', '#508 偽のタイトル3', '#508 偽のタイトル4'],
  body: '偽の本文です。\n\n2段落目です。',
  toc: [{ t: '00:00', label: 'オープニング' }, { t: '00:30', label: '本題' }, { t: '12:99', label: '形が違う時刻（捨てる）' },
    { t: '99:00', label: '音より後の時刻（捨てる）' }],
  mentions: ['偽の本'],
  closing: 'お便りお待ちしています。',
  notes: ['00:10 の言葉は聞き取りが怪しい'],
};
const rss = '<?xml version="1.0"?><rss><channel><title>番組</title>' +
  '<item><title><![CDATA[#507 いちばん新しい回]]></title></item><item><title>#506 その前の回</title></item></channel></rss>';

// 鍵ごとに、届いた頼み（モデルの名前）を覚える。GET /calls/<鍵> で返す（混んでいる時に何回・どのモデルで頼んだかを確かめる）
const calls = {};
const reply = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith('/rss')) { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(rss); return; }
    if (req.method === 'GET' && req.url.startsWith('/calls/')) { reply(res, 200, calls[decodeURIComponent(req.url.slice(7))] || []); return; }
    if (logFile) fs.writeFileSync(logFile, JSON.stringify({ url: req.url, headers: req.headers, body }));
    // 鍵が bad-key の時は、本物の Gemini と同じく 400 と「API key not valid」で断る（日本語の案内に変わるかを確かめる）
    const k = req.headers['x-goog-api-key'] || req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (k === 'bad-key') { reply(res, 400, { error: { message: 'API key not valid. Please pass a valid API key.' } }); return; }
    // 混んでいる・回数の上限の場面（2026-10-23）: busy-2＝初めの2回だけ 503・busy-lite＝軽いモデル（flash-lite）以外は 503・
    // busy-all＝いつも 503・limit＝いつも 429（本物の Gemini の文と同じ）
    const m = /models\/([^:]+):/.exec(req.url);
    const list = (calls[k] = calls[k] || []);
    list.push(m ? decodeURIComponent(m[1]) : req.url);
    const busy = { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' };
    if ((k === 'busy-2' && list.length <= 2) || (k === 'busy-lite' && !/flash-lite/.test(list[list.length - 1])) || k === 'busy-all') { reply(res, 503, { error: busy }); return; }
    if (k === 'limit') { reply(res, 429, { error: { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED' } }); return; }
    const text = JSON.stringify(draft);
    let out = null;
    if (/:generateContent$/.test(req.url)) out = { candidates: [{ content: { parts: [{ text }] } }] };
    else if (req.url === '/v1/messages') out = { content: [{ type: 'text', text: `下書きです。\n${text}` }] }; // 前に文が付いても読めるか
    else if (req.url === '/v1/chat/completions') out = { choices: [{ message: { content: text } }] };
    if (!out) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(Number(port), '127.0.0.1');
