#!/usr/bin/env node
// 新しい回を作る（取り込み）: 3人の録音から、頭揃え → 全員が黙っている所を探す → 画面の用意 までを続けて行う。
//
//   node ui/import.js <回のID> [--progress]
//
// 回のフォルダ（<回のデータの置き場所>/<回のID>/）の import.json に、名前・録音の場所・BGM・CM・間の詰め方が書いてある
// （画面に録音を落とすと、サーバーが書いてからこれを走らせる）。
// 中でやることは、これまで手で打っていたコマンドと同じ（src/sync.js → src/align.js → src/analyze.js → ui/prep.js）。
// 頭揃え済みの音源（1本 400〜650MB）は、終わったら消す。書き出しは生の録音から頭を揃え直すので要らない。
// 頭揃えが自動で決まらなかった時は、止めずに「頭揃え待ち」の回として読み込む（決まらなかった録音はずらさずに置き、黙っている所と
// 被りはまだ探さない）。画面の「頭を揃える」窓で人が手拍子の位置を選ぶと、import.json に claps（録音ごとの手拍子の時刻）が入って
// もう一度これが走り、その揃え方で頭揃え → 黙っている所 → 画面の用意（被りの印）をやり直す（倉田さんの考えた流れ・2026-10-23。
// 前は止まって知らせるだけで、収録したその日に編集を始められなかった）。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const DATA = require('./data-dir');

const ROOT = path.join(__dirname, '..');
const children = new Set();

// node の道具を走らせ、出力をまとめて返す。each(line) には標準エラーの行を1行ずつ渡す（進み具合に使う）。env は足す環境変数
function runNode(script, args, each, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    children.add(child);
    const out = [];
    let err = '', partial = '';
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => {
      err = (err + d).slice(-4000);
      partial += d;
      let nl;
      while ((nl = partial.indexOf('\n')) >= 0) {
        if (each) each(partial.slice(0, nl));
        partial = partial.slice(nl + 1);
      }
    });
    child.on('error', reject);
    child.on('close', code => {
      children.delete(child);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(Object.assign(new Error(`${path.basename(script)} が止まりました（${code}）\n${err.slice(-1500)}`), { code }));
    });
  });
}

// 録音の長さ（秒）
function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isFinite(d)) throw new Error(`録音の長さを測れませんでした: ${file}`);
  return d;
}

// 手で選んだ手拍子の時刻（録音ごとの元の時刻。1つ目が基準）で、頭揃えの結果を書き換える。基準の手拍子が clapAt になるので、
// 自動で揃った時と同じく、回を作る時に手拍子より前を切る（ui/prep.js）
function applyClaps(sync, claps) {
  sync.results.forEach((r, i) => {
    r.manualClapAt = claps[i];
    if (i === 0) { Object.assign(r, { clapAt: claps[0], syncClap: true, manual: true }); return; }
    Object.assign(r, {
      offsetSeconds: +(claps[0] - claps[i]).toFixed(4), accepted: true, clapClear: true, manual: true,
      recordingType: null, basis: '手で選んだ手拍子', note: '手で選んだ手拍子で揃えました。',
    });
  });
}

async function importProject(id, progress = () => {}) {
  const dir = path.join(DATA, id);
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'import.json'), 'utf8'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const files = job.files;
  const syncPath = path.join(work, 'sync.json');

  // 1) 頭揃えのずれを探す（冒頭の手拍子と会話の譲り合い）。手で揃えた後は、選んだ手拍子の時刻から決める
  progress('sync', 0);
  let sync;
  if (Array.isArray(job.claps)) {
    sync = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
    applyClaps(sync, job.claps);
    fs.writeFileSync(syncPath, JSON.stringify(sync, null, 2));
  } else {
    const syncOut = await runNode('src/sync.js', files);
    fs.writeFileSync(syncPath, syncOut);
    sync = JSON.parse(syncOut);
  }
  // 自動で揃わなかった録音（番号）。いったんずらさずに読み込み、画面で手で揃えてもらう
  const pending = sync.results.map((r, i) => (r.role !== '基準' && (r.offsetSeconds === null || r.offsetSeconds === undefined) ? i : -1)).filter(i => i >= 0);
  let alignPlan = syncPath;
  if (pending.length) {
    alignPlan = path.join(work, 'sync-pending.json');
    fs.writeFileSync(alignPlan, JSON.stringify({ ...sync, results: sync.results.map((r, i) => (pending.includes(i) ? { ...r, offsetSeconds: 0 } : r)) }, null, 2));
  }

  // 2) 頭を揃える（一時的に、揃えた音源を作る）
  progress('align', 0);
  await runNode('src/align.js', [alignPlan, path.join(work, 'aligned')]);
  const aligned = files.map(f => path.join(work, 'aligned', `${path.basename(f, path.extname(f))}_sync.wav`));

  // 3) 全員が黙っている所（自動で切る所）を探す。間の詰め方（新しい回の窓のつまみ＝X 秒以上の間を g 秒に）を、自動編集の決まりに
  //    直して渡す: 切る所の前後に g の半分ずつ残し（PAD）、切る長さが X − g 以上の所だけ切る（MIN_CUT）。残す間は、画面の「調整」と
  //    同じく詰める間の半分まで。決めていない時（前の import.json）は自動編集の既定のまま。
  //    頭揃え待ちの時は探さない（揃っていないと「全員が黙っている所」がずれる）。長さだけ測って、切る所の無い回にする
  progress('analyze', 0);
  let rule = {};
  if (Number.isFinite(job.tight) && Number.isFinite(job.gap)) {
    const g = Math.min(job.gap, job.tight / 2);
    rule = { PAD: String(+(g / 2).toFixed(3)), MIN_CUT: String(+(job.tight - g).toFixed(3)) };
  }
  fs.writeFileSync(path.join(work, 'cuts.json'), pending.length
    ? JSON.stringify({ files: aligned, total: Math.min(...aligned.map(duration)), cuts: [] }, null, 2)
    : await runNode('src/analyze.js', aligned, null, rule));

  // 4) 画面の用意（再生用の音・波形・被り・声の大きさ・BGM と CM の試聴用）
  progress('prep', 0);
  const args = [path.join(work, 'cuts.json'), id, job.name, '--sync', syncPath];
  if (job.bgm) args.push('--bgm', job.bgm);
  if (job.cm) args.push('--cm', job.cm);
  if (pending.length) args.push('--pending', pending.join(','));
  let lines = 0;
  const expect = files.length + 4; // prep.js が知らせる行の数の目安（声・波形×人数・被り・BGM・CM・声の大きさ）
  await runNode('ui/prep.js', args, () => progress('prep', Math.min(0.95, ++lines / expect)));

  fs.rmSync(path.join(work, 'aligned'), { recursive: true, force: true });
  const P = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  progress('prep', 1);
  return { id, name: P.name, duration: P.duration, tracks: P.tracks.length, cuts: P.cuts.length, alignPending: pending.length ? pending : null };
}

module.exports = { importProject };

if (require.main === module) {
  const [id] = process.argv.slice(2);
  if (!id || !/^[\w.-]+$/.test(id)) {
    console.error('usage: node ui/import.js <回のID> [--progress]');
    process.exit(1);
  }
  const json = process.argv.includes('--progress');
  // 止められた時（画面の「やめる」・Ctrl-C）は、走っている道具も止める
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { for (const c of children) c.kill('SIGKILL'); process.exit(130); });
  }
  const SPAN = {
    sync: [0, 0.35, '頭を揃える所を探しています（冒頭の手拍子）'],
    align: [0.35, 0.45, '頭を揃えています'],
    analyze: [0.45, 0.55, '全員が黙っている所を探しています'],
    prep: [0.55, 1, '画面の用意をしています（波形・被り・声の大きさ）'],
  };
  const progress = (step, f) => {
    const [a, b, label] = SPAN[step];
    if (json) console.log(JSON.stringify({ type: 'progress', step: label, pct: +(a + (b - a) * f).toFixed(3) }));
  };
  const t0 = Date.now();
  importProject(id, progress)
    .then(r => {
      r.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      console.log(json ? JSON.stringify({ type: 'done', ...r }) : JSON.stringify(r, null, 2));
    })
    .catch(e => {
      if (json) console.log(JSON.stringify({ type: 'error', message: e.message.split('\n')[0] }));
      console.error(e.message);
      process.exit(1);
    });
}
