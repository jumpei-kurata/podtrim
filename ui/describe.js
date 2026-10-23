#!/usr/bin/env node
// 説明文と目次の下書き: 書き出したファイルを文字にし（この Mac の mlx_whisper・Whisper large-v3-turbo）、選んだ AI（Gemini・Claude・
// OpenAI）に、番組の決まった形でタイトル案・説明文・目次を書かせる。AI を使わない時（または鍵が無い時）は、文字起こしと
// 「AI に頼む文」（そのまま Claude などに貼れる）まで作る。
//
//   node ui/describe.js <回のID> [--progress] [--audio <音のファイル>] [--again]
//
// - 音は、決まった書き出し先に書き出したファイル（回の export.json の out）。目次の時刻を、ART19 に上げる音に合わせるため
// - 文字起こしは回のフォルダの transcript.json に残し、音が変わっていなければ使い回す（--again で作り直す）
// - 次の番号（#508 など）は、番組の RSS のタイトルの「#番号」の一番大きい数＋1（読めなければ #???）
// - 結果は回のフォルダの description.json（画面が開き直しても出せるように）
// 倉田さん「説明文と目次の下書きを自動で作る…2番ってなんなら今やれない？」「無料でできる、API 提供してる AI あるっしょ？…人それぞれ」
// （2026-10-18）。形の正本は vault wiki/himapro/himapro-episode-template.md（ここの決まりと定型はその写し）
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA = require('./data-dir');
const { AI, aiChoice, getKey, readSettings } = require('./settings');
const { isOwnExport } = require('./export');

// 番組の RSS（次の番号を数える）と ART19 の管理画面（画面の「ART19 と Finder を開く」）。ひまじんプログラマーの物。settings.json で変えられる
const DEFAULT_RSS = 'https://rss.art19.com/07ef6b45-d4fc-4d94-b211-e02a27b7e2a6';
// 説明文の定型（区切り線から下・毎回同じ）。src/footer.js（vault の himapro-episode-template.md の写し）。settings.json の descFooter で変えられる
const DEFAULT_FOOTER = require('../src/footer');

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const mmss = t => { const s = Math.max(0, Math.floor(t)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// mlx_whisper の場所（環境変数 HIMADAN_WHISPER が先。Dock から開いたアプリは ~/.local/bin を PATH に持たないので、よくある所を直接見る）
function findWhisper() {
  const cands = [process.env.HIMADAN_WHISPER, path.join(os.homedir(), '.local', 'bin', 'mlx_whisper'), '/opt/homebrew/bin/mlx_whisper', '/usr/local/bin/mlx_whisper'];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  for (const d of (process.env.PATH || '').split(':')) if (d && fs.existsSync(path.join(d, 'mlx_whisper'))) return path.join(d, 'mlx_whisper');
  return null;
}
const WHISPER_MODEL = process.env.HIMADAN_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo';

// 「やめる」（サーバーからの SIGTERM）や Ctrl-C で止めた時に、動いている文字起こしと一時フォルダを残さない（書き出しと同じ）
const running = new Map(); // 子プロセス → 一時フォルダ
function stopAll() {
  for (const [child, tmp] of running) { child.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); }
  running.clear();
}

// 文字起こし: [{ start, end, text }]。進み具合は mlx_whisper が1行ずつ出す「[00:12.000 --> 00:15.000] …」の終わりの時刻で測る
function transcribe(audio, durSec, onFrac) {
  const whisper = findWhisper();
  if (!whisper) {
    // 入れ方は、倉田さんの Mac と同じ uv の形（~/.local/bin にできる。Homebrew の Python の pip は断ることがある・2026-10-19）
    throw new Error('文字起こしの道具（mlx_whisper）が見つかりません。ターミナルで brew install uv の後に uv tool install mlx-whisper で入れてください（Apple の M チップの Mac だけ。初めての文字起こしの時に、文字起こしのモデル〈約1.5GB〉を落とすので数分かかります）');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'podtrim-whisper-'));
  const args = [audio, '--model', WHISPER_MODEL, '--language', 'ja', '--output-format', 'json', '--output-dir', tmp, '--output-name', 'transcript', '--verbose', 'True'];
  return new Promise((resolve, reject) => {
    // 試す時の偽物（.js）は、今動いている Node で動かす（実行の許しを付けなくてよいように）
    const child = whisper.endsWith('.js')
      ? spawn(process.execPath, [whisper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(whisper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    running.set(child, tmp);
    let err = '', buf = '';
    const onOut = d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = /-->\s*(\d+):(\d+(?:\.\d+)?)\]/.exec(line) || /-->\s*(\d+):(\d+):(\d+(?:\.\d+)?)\]/.exec(line);
        if (m && durSec > 0) {
          const t = m.length === 4 ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
          onFrac(Math.min(1, t / durSec));
        }
      }
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', e => reject(new Error(`文字起こしを始められませんでした（${e.message}）`)));
    child.on('close', code => {
      running.delete(child);
      try {
        const j = code === 0 ? readJson(path.join(tmp, 'transcript.json')) : null;
        if (!j || !Array.isArray(j.segments)) throw new Error(`文字起こしが止まりました（${code}）\n${err.slice(-400)}`);
        resolve(j.segments.map(s => ({ start: +Number(s.start).toFixed(2), end: +Number(s.end).toFixed(2), text: String(s.text || '').trim() }))
          .filter(s => s.text));
      } catch (e) { reject(e); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });
}

// Whisper の空耳（音楽や無音の所で、言っていない決まり文句が出る。守りの回の終わりの BGM で「ご視聴ありがとうございました」が
// 数十回続いた）を除く: 決まった空耳の文と、同じ文が3回以上続く所（1回だけ残す）
const PHANTOMS = /^(ご視聴ありがとうございました|ご覧いただきありがとうございます|チャンネル登録(を)?よろしくお願いします|おやすみなさい)[。.!！]*$/;
function cleanSegments(segs) {
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (PHANTOMS.test(s.text)) continue;
    let run = 1;
    while (i + run < segs.length && segs[i + run].text === s.text) run++;
    out.push(s);
    if (run >= 3) i += run - 1; // 3回以上続いたら1回だけ
  }
  return out;
}

// 次の番号: RSS のタイトルの「#番号」の一番大きい数＋1。読めなければ null
async function nextNumber(rss) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(rss, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const xml = await res.text();
    let max = 0;
    for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?\s*#(\d{1,5})/g)) max = Math.max(max, Number(m[1]));
    return max > 0 ? max + 1 : null;
  } catch { return null; }
}

// 今日の日付（この Mac の時計・「2026-10-19」の形）
const todayText = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// AI に頼む文（そのまま Claude などのチャットに貼っても使える）。今日の日付と、知らない製品名・版を古い知識で直さない決まりも入れる
// （倉田さん「ジェミニからめっちゃ古い情報飛んできた気がする」・2026-10-19。話に出た新しいモデル名を、AI が自分の知っている
// 古い版の名前と違うと「確かめてほしい所」に挙げていた）
function buildPrompt({ show, episode, number, cmStart, segments, today = todayText() }) {
  const num = number ? `#${number}` : '#???';
  const lines = segments.filter(s => cmStart === null || s.start < cmStart).map(s => `[${mmss(s.start)}] ${s.text}`);
  return [
    `あなたはポッドキャスト「${show}」の編集担当です。下の文字起こし（[分:秒] 付き）から、ART19 に載せるタイトル案・説明文・目次を作ってください。`,
    `今日は ${today} です。`,
    `回の作業用の名前: ${episode}`,
    '',
    '# 決まり',
    `- タイトルは「${num} {タイトル}」の形。技術用語＋身近な比喩・言い切り・疑問形で、硬い説明にしない。4つ出し、1つ目をいちばんのおすすめにする。`,
    '- 説明文の本文は、何の回か・話の流れ・面白かった所を、聞きたくなるように数段落で書く。太字・斜体などの書式は使わない（ART19 では効かない）。リンクはそのまま書く。',
    '- 目次は、話題が変わる所ごとに「分:秒 見出し」。時刻は文字起こしの時刻をそのまま使い、作らない。00:00 から始める。',
    cmStart !== null ? `- ${mmss(cmStart)} より後は CM なので、目次にも説明文にも入れない（文字起こしもそこまで）。` : '',
    '- 本やサービスなど、紹介した物があれば mentions に入れる（無ければ空）。',
    '- 最後に、聞いている人へのお便りの呼びかけを1〜2行（closing）。',
    '- 聞き取りが怪しい言葉・名前の取り違えなど、人が確かめてほしい所は notes に入れる。',
    '- 話に出てくる製品名・サービス名・AI のモデル名や版は、あなたの知識より新しいことがある（今日の日付を見る）。知らない名前・版でも、古い知識に合わせて書き換えたり、知らないことだけを理由に notes に挙げたりしない。文字起こしの聞き違い（例: 「俳句4.5」→「Haiku 4.5」）は正しい表記に直す。',
    '- 出演者の個人的な事情や、誤解されやすい話は説明文に入れない。',
    '',
    '# 出力',
    '次の形の JSON だけを返す（ほかの文は書かない）:',
    `{"titles": ["${num} …", "${num} …", "${num} …", "${num} …"], "body": "本文", "toc": [{"t": "00:00", "label": "見出し"}], "mentions": ["…"], "closing": "…", "notes": ["…"]}`,
    '',
    '# 文字起こし',
    ...lines,
  ].filter(l => l !== '').join('\n');
}

// 試す時は環境変数 HIMADAN_AI_BASE（例 http://127.0.0.1:18990）で、各社の窓口の代わりに手元の偽物へ送る
const base = def => process.env.HIMADAN_AI_BASE || def;
async function callAI(provider, model, key, prompt) {
  const name = AI[provider].label.split('（')[0]; // 知らせでは短く（Gemini・Claude・OpenAI）
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5 * 60 * 1000);
  const post = async (url, headers, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      // 断られた時は、何をすればよいかを日本語で（各社の英語の理由は括弧に残す）
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type)) || msg; } catch {}
      const what = res.status === 401 || res.status === 403 || /api.?key/i.test(msg) ? '鍵が違うか、使えなくなっています。「AI の設定」で入れ直してください'
        : res.status === 429 ? '使える回数の上限に届きました。少し待ってから（無料枠なら次の日に）もう一度作ってください'
        : res.status >= 500 ? '混んでいるようです。少し待ってからもう一度作ってください'
        : '断られました';
      throw Object.assign(new Error(`${name}: ${what}（${res.status}: ${msg}）`), { status: res.status });
    }
    try { return JSON.parse(text); } catch { throw new Error(`${name}の返事が読めませんでした。もう一度作ってください`); }
  };
  try {
    if (provider === 'gemini') {
      const j = await post(`${base('https://generativelanguage.googleapis.com')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': key },
        { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } });
      return ((j.candidates || [])[0] || {}).content?.parts?.map(p => p.text || '').join('') || '';
    }
    if (provider === 'claude') {
      const j = await post(`${base('https://api.anthropic.com')}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] });
      return (j.content || []).map(c => c.text || '').join('');
    }
    if (provider === 'openai') {
      const j = await post(`${base('https://api.openai.com')}/v1/chat/completions`, { Authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } });
      return ((j.choices || [])[0] || {}).message?.content || '';
    }
    throw new Error(`知らない AI です（${provider}）`);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${name}から5分たっても返事がありません。もう一度作ってください`);
    if (e instanceof TypeError) throw new Error(`${name}につながりませんでした。ネットにつながっているか確かめてください`); // fetch failed
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 混んでいる（5xx）時は、間を空けてやり直す。それでもだめなら、同じ会社の軽いモデル（settings.js の light・Gemini は 3.5 Flash-Lite）で
// 試す（倉田さんが押し直さなくて済むように・2026-10-23。その日 Gemini が 503「high demand」を返して止まった）。回数の上限（429）・鍵の
// 誤り・つながらない・返事が来ない時はやり直さない。軽いモデルも混んでいる（または無い）時だけ、初めの「混んでいる」の知らせを出す。
// 待つ秒数は、試す時に HIMADAN_AI_WAIT（カンマ区切り）で変えられる。返すのは返事と、実際に書いたモデル
const BUSY_WAITS = (process.env.HIMADAN_AI_WAIT || '5,15').split(',').map(Number);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function callAIBusy(provider, model, key, prompt, note) {
  const tries = BUSY_WAITS.length + 1;
  let busy;
  for (let i = 1; i <= tries; i++) {
    try { return { text: await callAI(provider, model, key, prompt), model }; } catch (e) {
      if (!(e.status >= 500)) throw e;
      busy = e;
      if (i < tries) {
        note(`混んでいるので、やり直しています（${i + 1}/${tries}）`);
        await sleep(BUSY_WAITS[i - 1] * 1000);
      }
    }
  }
  const light = AI[provider].light;
  if (light && light !== model) {
    note(`混んでいるので、軽いモデル（${light}）で試しています`);
    try { return { text: await callAI(provider, light, key, prompt), model: light }; } catch (e) {
      if (!(e.status >= 500) && e.status !== 404) throw e;
    }
  }
  throw busy;
}

// AI の返事から JSON を取り出す（前後に文が付いても、最初の { から最後の } まで）。目次は「分:秒」の形（秒は 59 まで）で、
// limit 秒（CM の頭か、文字起こしの終わり）より後でない物だけ残す（AI が時刻を作ってしまった時に、聞けない所へ飛ばないように）
const secOf = t => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
function parseReply(text, limit = Infinity) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  const bad = () => new Error('AI の返事が決まった形（JSON）ではありませんでした。もう一度作ってください');
  if (a < 0 || b <= a) throw bad();
  let j;
  try { j = JSON.parse(text.slice(a, b + 1)); } catch { throw bad(); }
  const arr = v => (Array.isArray(v) ? v : []);
  return {
    titles: arr(j.titles).map(String).filter(Boolean).slice(0, 6),
    body: String(j.body || '').trim(),
    toc: arr(j.toc).map(x => ({ t: String(x.t || '').trim(), label: String(x.label || '').trim() }))
      .filter(x => /^\d{1,3}:[0-5]\d$/.test(x.t) && x.label && secOf(x.t) <= limit),
    mentions: arr(j.mentions).map(String).filter(Boolean),
    closing: String(j.closing || '').trim(),
    notes: arr(j.notes).map(String).filter(Boolean),
  };
}

// ART19 に貼る説明文の全文: 本文 → ▼目次 → ▼本日紹介したもの → 呼びかけ → 定型（vault の型と同じ並び）
function assemble(d, footer) {
  const parts = [d.body];
  if (d.toc.length) parts.push(['▼目次', ...d.toc.map(x => `${x.t} ${x.label}`)].join('\n'));
  if (d.mentions.length) parts.push(['▼本日紹介したもの', ...d.mentions.map(m => `・${m}`)].join('\n'));
  if (d.closing) parts.push(d.closing);
  return `${parts.filter(Boolean).join('\n\n')}\n\n\n${footer}`;
}

async function describe(id, opts = {}) {
  const progress = opts.progress || (() => {});
  const dir = path.join(DATA, id);
  const P = readJson(path.join(dir, 'project.json'));
  if (!P) throw new Error(`回が見つかりません: ${id}`);
  // 書き出した音: 決まった書き出し先に書き出した物（画面の「書き出し済み」と同じ決まり。試しに別の所へ書き出した物は使わない）。
  // --audio で渡した時はその音（書き出しの記録とは別の音かもしれないので、CM の頭は分からない＝最後まで目次にしてよい）
  const exRaw = readJson(path.join(dir, 'export.json'));
  const ex = !opts.audio && isOwnExport(exRaw) ? exRaw : null;
  const audio = opts.audio || (ex && ex.out);
  if (!audio || !fs.existsSync(audio)) throw new Error('先に書き出してください（書き出したファイルから文字にして、目次の時刻を ART19 に上げる音に合わせます）');
  const durSec = ex && ex.duration ? ex.duration
    : Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], { encoding: 'utf8' }).stdout) || 0;
  // 本編の後ろの CM の頭（ここより後は目次に入れない）。書き出した時の本編の長さと CM の位置から
  const cmStart = ex && ex.cm && Number.isFinite(ex.talk) ? Math.min(ex.talk, ex.talk + (Number(ex.cm.gap) || 0)) : null;
  const settings = readSettings();

  // 1) 文字起こし（音が前と同じなら使い回す）
  const tPath = path.join(dir, 'transcript.json');
  const st = fs.statSync(audio);
  const cache = readJson(tPath);
  let segments;
  if (!opts.again && cache && cache.audio === audio && cache.mtimeMs === st.mtimeMs && Array.isArray(cache.segments)) {
    segments = cache.segments;
    progress('transcribe', 1);
  } else {
    const t0 = Date.now();
    segments = await transcribe(audio, durSec, f => progress('transcribe', f));
    fs.writeFileSync(tPath, JSON.stringify({ audio, mtimeMs: st.mtimeMs, model: WHISPER_MODEL, seconds: +((Date.now() - t0) / 1000).toFixed(1), segments }, null, 2));
    progress('transcribe', 1);
  }

  // 2) 次の番号
  progress('number', 0);
  const number = await nextNumber(process.env.HIMADAN_RSS || settings.rssUrl || DEFAULT_RSS);
  progress('number', 1);

  // 3) AI（使わない・鍵が無い時は、頼む文まで）。空耳を除いた文字起こしを渡す
  const { provider, model } = aiChoice();
  const clean = cleanSegments(segments);
  const prompt = buildPrompt({ show: settings.showName || 'ひまじんプログラマー', episode: P.name, number, cmStart, segments: clean });
  const footer = settings.descFooter || DEFAULT_FOOTER;
  const transcriptText = clean.map(s => `[${mmss(s.start)}] ${s.text}`).join('\n');
  const common = { id, audio, number, cmStart, provider, model, footer, prompt, transcriptText, createdAt: new Date().toISOString() };
  let result;
  if (provider === 'none') {
    result = { ...common, ai: false, reason: 'AI を使わない設定です（「AI に頼む文」をコピーして、Claude などに貼ってください）' };
  } else {
    const key = getKey(provider);
    if (!key) {
      result = { ...common, ai: false, reason: `${AI[provider].label.split('（')[0]}の鍵が入っていません（「AI の設定」で入れてください）` };
    } else {
      progress('ai', 0);
      const reply = await callAIBusy(provider, model, key, prompt, note => progress('ai', 0, note));
      const d = parseReply(reply.text, cmStart !== null ? cmStart : clean.length ? clean[clean.length - 1].end : Infinity);
      if (!d.body || !d.titles.length) throw new Error('AI の返事に、タイトルか本文がありませんでした。もう一度作ってください');
      // 軽いモデルで書いた時は、そのモデルの名前を残す（画面の見出しに出て、今の設定と違えば「作り直す」を案内する）
      result = { ...common, model: reply.model, ai: true, ...d, description: assemble(d, footer) };
      progress('ai', 1);
    }
  }
  fs.writeFileSync(path.join(dir, 'description.json'), JSON.stringify(result, null, 2));
  return result;
}

module.exports = { describe, buildPrompt, parseReply, assemble, cleanSegments, DEFAULT_FOOTER, DEFAULT_RSS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const id = args[0];
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!id || !/^[\w.-]+$/.test(id)) {
    console.error('usage: node ui/describe.js <回のID> [--progress] [--audio <音のファイル>] [--again]');
    process.exit(1);
  }
  const json = args.includes('--progress');
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopAll(); process.exit(130); });
  // 進み具合: 文字にする 0〜80%・番号 80〜82%・AI が書く 82〜100%
  const SPAN = { transcribe: [0, 0.8, '文字にしています（40分の回で2分ほど）'], number: [0.8, 0.82, '次の番号を調べています'], ai: [0.82, 1, 'AI が書いています'] };
  let last = -1;
  // note は、その段の今の様子（「混んでいるので、やり直しています（2/3）」など）。あれば段の名前の代わりに出す
  const progress = (step, f, note) => {
    const [a, b, label] = SPAN[step];
    const pct = a + (b - a) * Math.max(0, Math.min(1, f));
    if (json && (pct - last >= 0.005 || f >= 1 || f === 0)) { last = pct; console.log(JSON.stringify({ type: 'progress', step: note || label, pct: +pct.toFixed(3) })); }
  };
  const t0 = Date.now();
  describe(id, { audio: opt('--audio'), again: args.includes('--again'), progress })
    .then(r => {
      const out = { ...r, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
      if (json) console.log(JSON.stringify({ type: 'done', ...out }));
      else console.log(JSON.stringify(out, null, 2));
    })
    .catch(e => {
      if (json) console.log(JSON.stringify({ type: 'error', message: e.message.split('\n')[0] }));
      console.error(e.message);
      process.exit(1);
    });
}
