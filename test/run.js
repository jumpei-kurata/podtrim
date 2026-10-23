#!/usr/bin/env node
// 回帰テスト。合成音源で「同室」「リモート」の両方が通ることを確認する。
// decoy（拍手と紛らわしい音入り）は同期だけを確かめる。
//
//   node test/make-fixtures.js sameroom && node test/make-fixtures.js remote && node test/make-fixtures.js decoy
//   node test/run.js
//
// 通ることだけでなく、壊れた入力をちゃんと落とすことも確認する
// （合格しか出さない検証は意味がないため）。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOL = 0.05; // 許容誤差(秒)。拍手のjitterがあるので0にはならない

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  OK  ' : '  NG  '} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

// 音を float のモノラルで読む（start 秒から dur 秒）
function decodeMono(file, start, dur) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 });
  const a = new Float32Array(Math.floor(r.stdout.length / 4));
  new Uint8Array(a.buffer).set(r.stdout.subarray(0, a.length * 4));
  return a;
}
// a と、files を足したものの差（dB）。8か所を5秒ずつ比べ、いちばん大きい差を返す
function compareSum(a, files) {
  const total = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a], { encoding: 'utf8' }).stdout);
  let worst = -Infinity;
  for (let w = 0; w < 8; w++) {
    const t = ((w + 0.5) / 8) * (total - 5);
    const x = decodeMono(a, t, 5);
    const ys = files.map(f => decodeMono(f, t, 5));
    const n = Math.min(x.length, ...ys.map(y => y.length));
    let e = 0, p = 0;
    for (let i = 0; i < n; i++) {
      let y = 0;
      for (const yy of ys) y += yy[i];
      e += (x[i] - y) ** 2;
      p += y * y;
    }
    worst = Math.max(worst, 10 * Math.log10(e / (p || 1) + 1e-20));
  }
  return worst;
}
// start 秒から dur 秒の音の大きさ（RMS・dB）
function rmsDb(file, start, dur) {
  const x = decodeMono(file, start, dur);
  let s = 0;
  for (const v of x) s += v * v;
  return 10 * Math.log10(s / (x.length || 1) + 1e-20);
}
// 音の大きさ（LUFS）と最大の山（dBTP）。lastSec を渡すと終わりのその秒数だけ
function loudness(file, lastSec) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...(lastSec ? ['-sseof', String(-lastSec)] : []), '-i', file,
    '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const i = r.stderr.match(/I:\s+(-?[\d.]+) LUFS/g);
  const tp = r.stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g);
  return { i: i ? Number(i[i.length - 1].match(/-?[\d.]+/)[0]) : NaN, tp: tp ? Number(tp[tp.length - 1].match(/-?[\d.]+/)[0]) : NaN };
}

function run(script, args, opts = {}) {
  const r = spawnSync('node', [path.join(ROOT, 'src', script), ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  });
  return r;
}

for (const mode of ['sameroom', 'remote', 'decoy', 'remote5']) {
  const dir = path.join(__dirname, 'fixtures', mode);
  if (!fs.existsSync(path.join(dir, 'expected.json'))) {
    console.log(`\n[${mode}] fixtures がありません。先に node test/make-fixtures.js ${mode} を実行してください`);
    failed++;
    continue;
  }
  const { expected } = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const files = Object.keys(expected).map(f => path.join(dir, f));
  console.log(`\n[${mode}]`);

  // 1) 同期
  const sync = run('sync.js', files);
  if (sync.status !== 0) { check('sync 実行', false, sync.stderr.slice(0, 200)); continue; }
  const syncOut = JSON.parse(sync.stdout);
  fs.writeFileSync(path.join(dir, 'sync.json'), sync.stdout);

  for (const r of syncOut.results) {
    const want = expected[r.file];
    if (r.role === '基準') continue;
    const got = r.offsetSeconds;
    const ok = got !== null && Math.abs(got - want) <= TOL;
    check(`同期 ${r.file}`, ok, `期待 ${want} / 実際 ${got} / 判定 ${r.recordingType || '不採用'}`);
    if (mode === 'decoy') {
      // 手拍子の判定に乗らず別の判定（会話の譲り合い等）に回った場合、合成音源では正解に
      // 届いてしまうことがある。手拍子の形での見分けが効いていることは、根拠でも確かめる
      check(`  おとりの音に釣られず手拍子で決まった ${r.file}`, Boolean(r.basis && r.basis.includes('はっきりした手拍子')), r.basis || '');
    }
  }
  if (mode === 'decoy') continue; // 以降の工程は sameroom / remote で確認済み

  // 2) 頭出し
  const alignedDir = path.join(dir, 'aligned');
  const align = run('align.js', [path.join(dir, 'sync.json'), alignedDir]);
  check('頭出し', align.status === 0, align.status !== 0 ? align.stderr.slice(0, 150) : '');
  if (align.status !== 0) continue;

  // 3) 無音検出
  const alignedFiles = fs.readdirSync(alignedDir).filter(f => f.endsWith('.wav')).map(f => path.join(alignedDir, f));
  const analyze = run('analyze.js', alignedFiles);
  check('無音検出', analyze.status === 0);
  if (analyze.status !== 0) continue;
  fs.writeFileSync(path.join(dir, 'cuts.json'), analyze.stdout);
  const cuts = JSON.parse(analyze.stdout);
  check('カット箇所が検出された', cuts.cuts.length > 0, `${cuts.cuts.length}箇所 / ${cuts.removedSeconds}秒`);

  // 4) カット適用
  const finalDir = path.join(dir, 'final');
  const apply = run('apply.js', [path.join(dir, 'cuts.json'), finalDir]);
  check('カット適用', apply.status === 0, apply.status !== 0 ? apply.stderr.slice(0, 150) : '');
  if (apply.status !== 0) continue;
  const applied = JSON.parse(apply.stdout);
  check(`${files.length}本のサンプル数が完全一致`, applied.sampleAccurateSync === true, `${applied.samples} サンプル`);

  // 5) 同期検証
  const verify = run('verify-sync.js', [path.join(dir, 'cuts.json'), finalDir]);
  check('同期検証が合格を返す', verify.status === 0);

  // 6) 検証が壊れた成果物を落とすか（合格しか出さない検証は無意味）
  const brokenDir = path.join(dir, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  const outs = fs.readdirSync(finalDir).filter(f => f.endsWith('.wav'));
  outs.forEach((f, i) => {
    if (i === 1) {
      // 1本だけ0.5秒ずらして同期を壊す
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.5',
        '-i', path.join(finalDir, f), path.join(brokenDir, f)], { encoding: 'utf8' });
    } else {
      fs.copyFileSync(path.join(finalDir, f), path.join(brokenDir, f));
    }
  });
  const verifyBroken = run('verify-sync.js', [path.join(dir, 'cuts.json'), brokenDir]);
  check('検証が壊れた成果物を落とす', verifyBroken.status !== 0);

  // 7) 被り検出
  const overlap = run('overlap.js', alignedFiles);
  check('被り検出', overlap.status === 0);

  // 8) 検品用出力
  const report = run('report.js', [path.join(dir, 'cuts.json'), path.join(dir, 'review')]);
  check('検品用出力', report.status === 0);

  // 9) 編集画面の回を作る（声の大きさと、全員が黙っている所も測る）。時間がかかるので remote だけで確かめる。
  //    生の録音と頭揃えのずれ（--sync）・BGM（短い音を繰り返す）・CM（声より大きい音）も付けて、書き出しまで通す
  if (mode === 'remote') {
    const dataDir = path.join(dir, 'ui-data');
    const env = { ...process.env, HIMADAN_DATA: dataDir };
    const bgm = path.join(dir, '_bgm.wav'), cm = path.join(dir, '_cm.wav');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=0.3*sin(2*PI*330*t)|0.3*sin(2*PI*440*t):d=60:s=44100', bgm]);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=0.8*sin(2*PI*660*t)*lt(mod(t\\,1)\\,0.5)|0.8*sin(2*PI*660*t)*lt(mod(t\\,1)\\,0.5):d=10:s=44100', cm]);
    const prep = spawnSync('node', [path.join(ROOT, 'ui', 'prep.js'), path.join(dir, 'cuts.json'), 'fixture', '合成音源',
      '--sync', path.join(dir, 'sync.json'), '--bgm', bgm, '--cm', cm],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    check('編集画面の回を作る', prep.status === 0, prep.status !== 0 ? prep.stderr.slice(-200) : '');
    if (prep.status === 0) {
      const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture', 'project.json'), 'utf8'));
      check('話し声の大きさを測った', p.tracks.every(t => Number.isFinite(t.speechDb)), p.tracks.map(t => `${t.speechDb}dB`).join(' / '));
      // 回を作った時の BGM・CM の値（2026-10-18）: BGM は頭 2秒・終わり 3秒のフェード、CM は本編の終わりの 0.5秒前から重ねて 2秒で
      // フェードイン（重ねるのは 2026-10-19 に 2秒前 → 0.5秒前）
      check('新しい回の BGM・CM の最初の値（BGM 終わり3秒でフェードアウト・CM は0.5秒前から重ねて2秒でフェードイン）',
        p.bgm.fadeIn === 2 && p.bgm.fadeOut === 3 && p.cm.gap === -0.5 && p.cm.fadeIn === 2,
        `BGM ${p.bgm.fadeIn}秒・${p.bgm.fadeOut}秒／CM ${p.cm.gap}秒・${p.cm.fadeIn}秒`);
      // 手拍子より前を切る（2026-10-18）: はっきりした手拍子で頭を揃えた回は、頭から「手拍子の時刻＋0.3秒」までを切る所が1つ入る
      // （origin: 'head'。「間を詰める」つまみでは作り直さない）
      const syncRes = JSON.parse(fs.readFileSync(path.join(dir, 'sync.json'), 'utf8')).results;
      const head = p.cuts.find(c => c.origin === 'head');
      check('手拍子より前を切る所が入る（頭から手拍子の 0.3秒後まで）',
        head && head.start === 0 && head.enabled && Math.abs(head.end - (syncRes[0].clapAt + 0.3)) < 0.01 && p.cuts.filter(c => c.origin === 'head').length === 1,
        head ? `0〜${head.end}秒（手拍子 ${syncRes[0].clapAt}秒）` : '入っていない');
      const autoCuts = p.cuts.filter(c => c.origin === 'auto');
      // 「間を詰める」つまみの作り直しが、既定の位置で回を作った時の自動のカットとほぼ同じ所を切れるか
      const { pad, minCut } = p.autoParams;
      const re = (p.silences || []).filter(([s, e]) => e - s >= minCut + 2 * pad - 1e-6).map(([s, e]) => [s + pad, e - pad]);
      const near = autoCuts.filter(c => re.some(([a, b]) => Math.abs(a - c.start) < 0.15 && Math.abs(b - c.end) < 0.15)).length;
      check('全員が黙っている所から自動のカットを作り直せる',
        near === autoCuts.length && re.length - autoCuts.length <= Math.ceil(autoCuts.length * 0.05),
        `${near}/${autoCuts.length} が一致・作り直しは ${re.length}本`);

      // 10) 書き出し。まず声だけ: 生の録音から頭を揃えて切り貼りした3人の声が、自動編集の3本（final/）を足したものと同じか。
      //     自動編集の3本は手拍子より前を切っていないので、無音を詰めた所（auto）だけで比べる
      const exp = args => spawnSync('node', [path.join(ROOT, 'ui', 'export.js'), 'fixture', ...args],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
      const autoState = extra => JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: autoCuts, mutes: [], splits: [], keeps: [],
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name), ...extra,
      });
      const stV = path.join(dataDir, 'fixture', 'state.json');
      const voicesWav = path.join(dataDir, 'voices-check.wav');
      fs.writeFileSync(stV, autoState({}));
      const ev = exp(['--voices-wav', voicesWav]);
      fs.rmSync(stV, { force: true });
      check('書き出し（声だけ）', ev.status === 0, ev.status !== 0 ? ev.stderr.slice(-200) : '');
      if (ev.status === 0) {
        const finals = fs.readdirSync(finalDir).filter(f => f.endsWith('.wav')).map(f => path.join(finalDir, f));
        const diff = compareSum(voicesWav, finals);
        check('書き出しの声が自動編集の3本と同じ（ずれなし）', diff < -60, `いちばん大きい差 ${diff.toFixed(1)}dB`);
        // 回の決まりのまま（手拍子より前も切る）だと、ちょうど「手拍子より前のうち、無音を詰めた所に入っていない分」だけ短い
        const eh = exp(['--voices-wav', path.join(dataDir, 'voices-head.wav')]);
        const extra = head ? head.end - autoCuts.reduce((sum, c) => sum + Math.max(0, Math.min(c.end, head.end) - c.start), 0) : NaN;
        const shorter = eh.status === 0 ? JSON.parse(ev.stdout).talkSec - JSON.parse(eh.stdout).talkSec : NaN;
        check('書き出しでも手拍子より前が切られる', Math.abs(shorter - extra) <= 0.01,
          eh.status === 0 ? `${shorter.toFixed(3)}秒短い（見込み ${extra.toFixed(3)}秒）` : eh.stderr.slice(-200));
      }
      // 塊の端を引いて戻した所（keeps＝ここは切らない）は、書き出しでも切らない。
      // 長いカットの頭 1秒を戻すと、声だけの書き出しがちょうど 1秒長くなる
      const c0 = autoCuts.find(c => c.enabled && c.end - c.start > 2);
      if (ev.status === 0 && c0) {
        const stK = path.join(dataDir, 'fixture', 'state.json');
        fs.writeFileSync(stK, autoState({ keeps: [[c0.start, c0.start + 1]] }));
        const ek = exp(['--voices-wav', path.join(dataDir, 'keep-voices.wav')]);
        fs.rmSync(stK, { force: true });
        const longer = ek.status === 0 ? JSON.parse(ek.stdout).talkSec - JSON.parse(ev.stdout).talkSec : NaN;
        check('塊の端を引いて戻した所は、書き出しでも切らない（ちょうど1秒長い）', Math.abs(longer - 1) <= 2 / 44100,
          ek.status === 0 ? `${longer.toFixed(6)}秒長い` : ek.stderr.slice(-200));
      }
      // 本番どおり: BGM・CM 入りで、長さと音の大きさ（-16 LUFS・CM も別に合わせる）
      const outWav = path.join(dataDir, 'out.wav');
      const ef = exp(['--out', outWav]);
      check('書き出し（BGM・CM 入り）', ef.status === 0, ef.status !== 0 ? ef.stderr.slice(-200) : '');
      if (ef.status === 0) {
        const r = JSON.parse(ef.stdout);
        check('書き出しの長さ = 本編 + 間 + CM', Math.abs(r.duration - (r.talk + p.cm.gap + p.cm.duration)) < 0.05,
          `${r.duration}秒（本編 ${r.talk} + ${p.cm.gap} + CM ${p.cm.duration.toFixed(3)}）`);
        const all = loudness(outWav), tail = loudness(outWav, 8);
        check('書き出しの音の大きさが -16 LUFS・最大の山が -1dB 以下', Math.abs(all.i + 16) <= 0.5 && all.tp <= -1.0, `全体 ${all.i} LUFS・最大 ${all.tp}dB`);
        check('CM も別に -16 LUFS に合わせてある', Math.abs(tail.i + 16) <= 1, `CM の終わり8秒 ${tail.i} LUFS`);
      }
      // BGM を CM の下まで伸ばした時（画面で BGM の右端を CM の終わりに吸い付けた時）: 長さは変わらず、
      // 本編と CM の間にも BGM が鳴り、本編の終わりと同じ大きさで続くか。声は普段どおり入れ（本編の大きさ合わせは声で決まる）、
      // 本編の最後の30秒（元の音の時間）だけ3人とも消して、本編の終わりを BGM だけにして比べる。
      // CM は本編の後に 0.5秒あけてつなぐ（回を作った時の値は本編に重ねる形なので、ここで決める）
      const GAP = 0.5;
      const stPath = path.join(dataDir, 'fixture', 'state.json');
      const cutList = p.cuts.filter(c => c.enabled).map(c => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
      let rawEnd = p.duration; // 残る所の最後（元の音の時間）
      for (let i = cutList.length - 1; i >= 0 && cutList[i][1] >= rawEnd - 1e-6; i--) rawEnd = Math.min(rawEnd, cutList[i][0]);
      fs.writeFileSync(stPath, JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: p.cuts, splits: [],
        mutes: p.tracks.map((_, k) => ({ track: k, start: rawEnd - 30, end: rawEnd })),
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name),
        bgm: { mute: false, volume: p.bgm.volume, end: 'cm' }, cm: { mute: false, gap: GAP },
      }));
      const underWav = path.join(dataDir, 'under.wav');
      const eu = exp(['--out', underWav]);
      fs.rmSync(stPath, { force: true });
      check('書き出し（BGM を CM の下まで伸ばす）', eu.status === 0, eu.status !== 0 ? eu.stderr.slice(-200) : '');
      if (eu.status === 0) {
        const u = JSON.parse(eu.stdout);
        const want = u.talk + GAP + p.cm.duration;
        check('伸ばしても長さ = 本編 + 間 + CM・BGM は CM の終わりまで', Math.abs(u.duration - want) < 0.05 && Math.abs(u.bgm.end - want) < 0.05,
          `${u.duration}秒・BGM の終わり ${u.bgm.end}秒`);
        const talkEnd = rmsDb(underWav, u.talk - 0.45, 0.4), inGap = rmsDb(underWav, u.talk + 0.05, GAP - 0.1);
        check('CM の前の間でも BGM が本編の終わりと同じ大きさで続く', inGap > -60 && Math.abs(talkEnd - inGap) < 0.5,
          `本編の終わり ${talkEnd.toFixed(1)}dB・間 ${inGap.toFixed(1)}dB`);
        const lu = loudness(underWav);
        check('BGM を重ねても最大の山が -1dB 以下', lu.tp <= -1.0, `最大 ${lu.tp}dB`);
      }
      // フェード（2026-10-18）: BGM の終わりのフェードアウト・CM の頭と終わりのフェード。本編の最後の30秒は3人とも消して
      // BGM だけにし、BGM が終わりに向けて小さくなるか、CM の頭と終わりが中ほどより小さいかを見る
      fs.writeFileSync(stPath, JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: p.cuts, splits: [],
        mutes: p.tracks.map((_, k) => ({ track: k, start: rawEnd - 30, end: rawEnd })),
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name),
        bgm: { mute: false, volume: p.bgm.volume, fadeOut: 4 }, cm: { mute: false, gap: GAP, fadeIn: 2, fadeOut: 2 },
      }));
      const fadeWav = path.join(dataDir, 'fade.wav');
      const efd = exp(['--out', fadeWav]);
      fs.rmSync(stPath, { force: true });
      check('書き出し（BGM と CM のフェード）', efd.status === 0, efd.status !== 0 ? efd.stderr.slice(-200) : '');
      if (efd.status === 0) {
        const f = JSON.parse(efd.stdout);
        const before = rmsDb(fadeWav, f.talk - 7, 1.5), last = rmsDb(fadeWav, f.talk - 0.5, 0.4);
        check('BGM が終わりに向けて小さくなる（フェードアウト 4秒）', before > -60 && last < before - 10,
          `4秒より前 ${before.toFixed(1)}dB・終わりの直前 ${last.toFixed(1)}dB`);
        const c0 = f.talk + GAP;
        const head = rmsDb(fadeWav, c0, 0.25), mid = rmsDb(fadeWav, c0 + 3, 0.4), tail = rmsDb(fadeWav, c0 + 9, 0.3);
        check('CM の頭と終わりが中ほどより小さい（フェード 2秒）', mid > -60 && head < mid - 10 && tail < mid - 3,
          `頭 ${head.toFixed(1)}dB・中ほど ${mid.toFixed(1)}dB・終わり ${tail.toFixed(1)}dB`);
      }
      // 本編の終わりのフェードアウト（尻すぼみ）: 声だけ（BGM・CM はミュート）で、あり・なしを書き出して、最後とその前を比べる
      const talkOnly = extra => JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: p.cuts, splits: [], mutes: [],
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name),
        bgm: { mute: true }, cm: { mute: true }, ...extra,
      });
      const tfA = path.join(dataDir, 'talk-a.wav'), tfB = path.join(dataDir, 'talk-b.wav');
      fs.writeFileSync(stPath, talkOnly({}));
      const ea = exp(['--out', tfA]);
      fs.writeFileSync(stPath, talkOnly({ talkFadeOut: 8 }));
      const eb = exp(['--out', tfB]);
      fs.rmSync(stPath, { force: true });
      check('書き出し（本編の尻すぼみ）', ea.status === 0 && eb.status === 0, ea.status !== 0 ? ea.stderr.slice(-200) : eb.status !== 0 ? eb.stderr.slice(-200) : '');
      if (ea.status === 0 && eb.status === 0) {
        const T = JSON.parse(ea.stdout).talk;
        const endA = rmsDb(tfA, T - 1.5, 1), endB = rmsDb(tfB, T - 1.5, 1);
        const preA = rmsDb(tfA, T - 14, 4), preB = rmsDb(tfB, T - 14, 4);
        check('本編の最後がだんだん小さくなる（フェードアウト 8秒）', endA > -60 && endB < endA - 8 && Math.abs(preB - preA) < 1,
          `最後の1.5〜0.5秒 ${endA.toFixed(1)} → ${endB.toFixed(1)}dB・その前 ${preA.toFixed(1)} → ${preB.toFixed(1)}dB`);
      }
      // 一部分の音量（2026-10-18）: カットの無い所の 10秒を3人とも −12dB にして、音の大きさをそろえる前の声（編集どおり）を
      // 書き出して比べる。範囲の中はちょうど 12dB 小さく、範囲の後ろは変わらないか。本番の書き出し（そろえた後）でも、ちょうど
      // 12dB 小さいか（前の loudnorm の dynamic では、下げた所が持ち上がって −6.9dB しか下がらなかった。全体に同じ倍率で直した）
      // 切る所は重なりをまとめてから使う（手拍子より前を切る所と、頭の無音を詰めた所が重なる。重なったまま引くと二重に引く）
      const cutsOn = [];
      for (const [s, e] of p.cuts.filter(c => c.enabled).map(c => [c.start, c.end]).sort((a, b) => a[0] - b[0])) {
        const last = cutsOn[cutsOn.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e); else cutsOn.push([s, e]);
      }
      let gapStart = null;
      for (let i = 0, prev = 0; i <= cutsOn.length; i++) {
        const next = i < cutsOn.length ? cutsOn[i][0] : p.duration;
        if (next - prev >= 16) { gapStart = prev; break; }
        if (i < cutsOn.length) prev = Math.max(prev, cutsOn[i][1]);
      }
      const toOut = raw => raw - cutsOn.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, raw) - s), 0);
      if (ea.status === 0 && gapStart !== null) {
        const g0 = gapStart + 2, g1 = gapStart + 12, o0 = toOut(g0);
        const withGain = talkOnly({ gains: p.tracks.map((_, k) => ({ track: k, start: g0, end: g1, db: -12 })) });
        const vA = path.join(dataDir, 'voices-edit-a.wav'), vG = path.join(dataDir, 'voices-edit-g.wav');
        fs.writeFileSync(stPath, talkOnly({}));
        const va = exp(['--voices-wav-edit', vA]);
        fs.writeFileSync(stPath, withGain);
        const vg = exp(['--voices-wav-edit', vG]);
        check('書き出し（一部分の音量・そろえる前の声）', va.status === 0 && vg.status === 0, va.status !== 0 ? va.stderr.slice(-200) : vg.status !== 0 ? vg.stderr.slice(-200) : '');
        if (va.status === 0 && vg.status === 0) {
          const inA = rmsDb(vA, o0 + 3, 4), inG = rmsDb(vG, o0 + 3, 4);
          const afA = rmsDb(vA, o0 + 10.5, 1.5), afG = rmsDb(vG, o0 + 10.5, 1.5);
          check('選んだ所だけ音量が下がる（−12dB・そろえる前・前の形の範囲を点に直して）', inA > -60 && Math.abs(inG - inA + 12) <= 0.3 && Math.abs(afG - afA) < 0.05,
            `範囲の中 ${inA.toFixed(2)} → ${inG.toFixed(2)}dB・範囲の後ろ ${afA.toFixed(2)} → ${afG.toFixed(2)}dB`);
        }
        // 本番の書き出し（音の大きさをそろえた後）でも、選んだ所がちょうど 12dB 下がるか（そろえ方の方式も出す）
        const tfG = path.join(dataDir, 'talk-gain.wav');
        const eg = exp(['--out', tfG]);
        fs.rmSync(stPath, { force: true });
        if (eg.status === 0) {
          const inA = rmsDb(tfA, o0 + 3, 4), inG = rmsDb(tfG, o0 + 3, 4);
          check('本番の書き出しでも選んだ所がちょうど下がる（−12dB・全体に同じ倍率なので持ち上がらない）', Math.abs(inG - inA + 12) <= 1,
            `範囲の中 ${inA.toFixed(1)} → ${inG.toFixed(1)}dB・そろえ方 ${JSON.parse(eg.stdout).loudness.mode}`);
        } else {
          check('書き出し（一部分の音量・本番）', false, eg.stderr.slice(-200));
        }
        // 音量の線（点・2026-10-18）: 3人とも g0 の ±0dB から g1 の −12dB へまっすぐ下げる。線の前は変わらず、真ん中（g0 + 5秒）は
        // 約 −6dB、g1 より後ろは最後の点の大きさ（−12dB）のまま（GarageBand の音量の線と同じ）
        fs.writeFileSync(stPath, talkOnly({ vol: p.tracks.map(() => [{ t: g0, db: 0 }, { t: g1, db: -12 }]) }));
        const vL = path.join(dataDir, 'voices-edit-l.wav');
        const vl = exp(['--voices-wav-edit', vL]);
        fs.rmSync(stPath, { force: true });
        check('書き出し（音量の線・そろえる前の声）', vl.status === 0, vl.status !== 0 ? vl.stderr.slice(-200) : '');
        if (va.status === 0 && vl.status === 0) {
          const beA = rmsDb(vA, o0 - 1.5, 1), beL = rmsDb(vL, o0 - 1.5, 1);
          const midA = rmsDb(vA, o0 + 4.5, 1), midL = rmsDb(vL, o0 + 4.5, 1);
          const afA = rmsDb(vA, o0 + 10.5, 1.5), afL = rmsDb(vL, o0 + 10.5, 1.5);
          check('音量の線: 線の前は変わらず・真ん中は約 −6dB・線の後ろは −12dB のまま',
            Math.abs(beL - beA) < 0.05 && Math.abs(midL - midA + 6) <= 0.6 && Math.abs(afL - afA + 12) <= 0.3,
            `線の前 ${beA.toFixed(2)} → ${beL.toFixed(2)}dB・真ん中 ${midA.toFixed(2)} → ${midL.toFixed(2)}dB・後ろ ${afA.toFixed(2)} → ${afL.toFixed(2)}dB`);
        }
      } else {
        check('一部分の音量のテストに使う、カットの無い16秒の所がある', false, 'テストの音源にカットの無い所が見つからない');
      }
      // CM を本編の終わりに重ねる（2026-10-18）: CM の頭を本編の終わりの3秒前に。本編の最後の30秒は3人とも消し、BGM は
      // CM の終わりまで。CM の音源は「0.5秒鳴って0.5秒止まる」をくり返すので、鳴っている所と止まっている所を比べる
      // （CM の頭のフェードインはなしにする。回を作った時の値は 2秒）
      fs.writeFileSync(stPath, JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: p.cuts, splits: [],
        mutes: p.tracks.map((_, k) => ({ track: k, start: rawEnd - 30, end: rawEnd })),
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name),
        bgm: { mute: false, volume: p.bgm.volume, end: 'cm' }, cm: { mute: false, gap: -3, fadeIn: 0 },
      }));
      const ovWav = path.join(dataDir, 'overlap.wav');
      const eo = exp(['--out', ovWav]);
      fs.rmSync(stPath, { force: true });
      check('書き出し（CM を本編の終わりに3秒重ねる）', eo.status === 0, eo.status !== 0 ? eo.stderr.slice(-200) : '');
      if (eo.status === 0) {
        const o = JSON.parse(eo.stdout);
        const wantLen = o.talk - 3 + p.cm.duration;
        check('重ねた長さ = 本編 − 3 + CM', Math.abs(o.duration - wantLen) < 0.05, `${o.duration}秒（本編 ${o.talk} − 3 + CM ${p.cm.duration.toFixed(3)}）`);
        const c0 = o.talk - 3;
        const on = rmsDb(ovWav, c0 + 0.05, 0.35), off = rmsDb(ovWav, c0 + 0.6, 0.35);
        check('本編に重ねた所で CM が鳴る', on > off + 6, `CM が鳴る所 ${on.toFixed(1)}dB・止まっている所 ${off.toFixed(1)}dB`);
        const under = rmsDb(ovWav, o.talk + 0.6, 0.35);
        check('本編の後ろでも CM の下で BGM が続く', under > -50, `CM が止まっている所 ${under.toFixed(1)}dB`);
        const lo = loudness(ovWav);
        check('重ねても最大の山が -1dB 以下', lo.tp <= -1.0, `最大 ${lo.tp}dB`);
      }
      // BGM の終わりを途中で止めた所（2026-10-18）: 録音の時間（endRaw）で覚えるので、書き出しでは切った分を引いた所で終わる
      // （倉田さん「常にその録音の方を追尾していく形にできるかな？」）。CM の音量の線（CM の頭からの時間）も一緒に確かめる:
      // CM の 5秒から後ろを無音にすると、CM の鳴っている所でも無音になる。本編の最後の30秒は3人とも消して BGM だけにする
      const endRaw = rawEnd - 12;
      fs.writeFileSync(stPath, JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: p.cuts, splits: [],
        mutes: p.tracks.map((_, k) => ({ track: k, start: rawEnd - 30, end: rawEnd })),
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name),
        bgm: { mute: false, volume: p.bgm.volume, end: null, endRaw }, cm: { mute: false, gap: GAP, fadeIn: 0 },
        cmVol: [{ t: 5, db: 0 }, { t: 5.01, db: -24 }],
      }));
      const atWav = path.join(dataDir, 'bgm-end-raw.wav');
      const ex = exp(['--out', atWav]);
      fs.rmSync(stPath, { force: true });
      check('書き出し（BGM の終わりを録音の時間で・CM の音量の線）', ex.status === 0, ex.status !== 0 ? ex.stderr.slice(-200) : '');
      if (ex.status === 0) {
        const x = JSON.parse(ex.stdout), e = toOut(endRaw);
        const before = rmsDb(atWav, e - 5.5, 1), after = rmsDb(atWav, e + 1, 2);
        check('BGM の終わりは、止めた録音の所（切った分を引いた所）で終わる', Math.abs(x.bgm.end - e) < 0.01 && before > -60 && after < -80,
          `BGM の終わり ${x.bgm.end}秒（録音の ${endRaw.toFixed(2)}秒 → ${e.toFixed(2)}秒）・その前 ${before.toFixed(1)}dB・その後 ${after.toFixed(1)}dB`);
        const c0 = x.talk + GAP;
        const on1 = rmsDb(atWav, c0 + 1.05, 0.35), on6 = rmsDb(atWav, c0 + 6.05, 0.35);
        check('CM の音量の線: 線で無音にした所は、CM の鳴る所でも無音', on1 > -30 && on6 < -80 && x.cm.points === 2,
          `CM の 1秒 ${on1.toFixed(1)}dB・6秒 ${on6.toFixed(1)}dB`);
      }
      // BGM の音量の線（録音の時間の点）: 本編の最後の30秒（3人とも消して BGM だけ）の中で、録音の時間で 4秒かけて無音へ下げる。
      // 書き出しでは、切った分を引いた所で下がり始め、下げ終わった後は無音のまま（点を録音の時間で持つ＝詰めてもその話の所についていく）
      fs.writeFileSync(stPath, JSON.stringify({
        projectCreatedAt: p.createdAt, cuts: p.cuts, splits: [],
        mutes: p.tracks.map((_, k) => ({ track: k, start: rawEnd - 30, end: rawEnd })),
        mixer: p.tracks.map(() => ({ mute: false, volume: 1 })), names: p.tracks.map(t => t.name),
        bgm: { mute: false, volume: p.bgm.volume }, cm: { mute: true },
        bgmVol: [{ t: rawEnd - 26, db: 0 }, { t: rawEnd - 22, db: -24 }],
      }));
      const blWav = path.join(dataDir, 'bgm-line.wav');
      const eb2 = exp(['--out', blWav]);
      fs.rmSync(stPath, { force: true });
      check('書き出し（BGM の音量の線）', eb2.status === 0, eb2.status !== 0 ? eb2.stderr.slice(-200) : '');
      if (eb2.status === 0) {
        const y = JSON.parse(eb2.stdout), o1 = toOut(rawEnd - 26), o2 = toOut(rawEnd - 22);
        const pre = rmsDb(blWav, o1 - 1.3, 1), post = rmsDb(blWav, o2 + 0.3, 1);
        check('BGM の音量の線: 録音の時間の点（切った分を引いた所）で下がり、下げ終わった後は無音', pre > -60 && post < -80 && y.bgm.points === 2,
          `下げる前 ${pre.toFixed(1)}dB・下げた後 ${post.toFixed(1)}dB（書き出しの ${o1.toFixed(2)}〜${o2.toFixed(2)}秒）`);
      }

      // 書き出すファイルの名前と、置き換えの守り（2026-10-19・倉田さん「元のデータは保持しといた方がいいかも」「書き出すときに名前を決める
      // 感じにしたら、新しく」）: 決めた名前で書き出す。書き出し先に同じ名前のファイルがあって、この回の前の書き出しでなければ、書く前に止める
      {
        const { overwriteCheck, safeFileName } = require('../ui/export');
        const exDir = path.join(dataDir, 'name-check');
        fs.rmSync(exDir, { recursive: true, force: true });
        fs.mkdirSync(exDir, { recursive: true });
        const fakeRec = path.join(exDir, '録音と同じ名前.mp3');
        fs.writeFileSync(fakeRec, 'これは元の録音のつもり');
        const nenv = { ...env, HIMADAN_EXPORT: exDir };
        const blockedEx = spawnSync('node', [path.join(ROOT, 'ui', 'export.js'), 'fixture', '--format', 'mp3', '--name', '録音と同じ名前'], { encoding: 'utf8', env: nenv });
        check('書き出し先に同じ名前のファイル（この回の書き出しでない物）があれば、置き換えずに止め、そのファイルは変わらない',
          blockedEx.status !== 0 && blockedEx.stderr.includes('置き換えずに止めました') && fs.readFileSync(fakeRec, 'utf8') === 'これは元の録音のつもり',
          blockedEx.stderr.trim().slice(0, 80));
        const named = spawnSync('node', [path.join(ROOT, 'ui', 'export.js'), 'fixture', '--format', 'mp3', '--name', '#508 試し/名前'],
          { encoding: 'utf8', env: nenv, maxBuffer: 64 * 1024 * 1024 });
        const want = path.join(exDir, '#508 試し／名前.mp3');
        const rec = named.status === 0 ? JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture', 'export.json'), 'utf8')) : null;
        check('決めた名前で書き出せる（/ は全角に）・記録に名前と書き出し先が残る・その書き出しは次に置き換えてよい',
          named.status === 0 && fs.existsSync(want) && rec && rec.name === '#508 試し／名前' && rec.dir === exDir &&
          overwriteCheck(want, path.join(dataDir, 'fixture')).replaceable, named.status === 0 ? want : named.stderr.slice(-200));
        check('ファイルの名前を整える（: も全角・頭の . と - は外す・末尾の .wav .mp3 は外す・空なら回の名前を使う）',
          safeFileName('a:b') === 'a：b' && safeFileName('.hidden') === 'hidden' && safeFileName('  ') === null &&
          safeFileName('--out') === 'out' && safeFileName('守り.wav') === '守り' && safeFileName('守り.MP3') === '守り' &&
          safeFileName('守り.wav.wav') === '守り' && safeFileName(safeFileName('守り.mp3.wav')) === safeFileName('守り.mp3.wav'));
        // 同じ名前で形を変えて書き出しても（MP3 → WAV）、前の MP3 も自分の書き出しと分かる（2026-10-19 の監査。前は最後の1本だけを
        // 覚えていて、WAV → MP3 → WAV と書き出すと、自分の WAV なのに止まった）
        const namedWav = spawnSync('node', [path.join(ROOT, 'ui', 'export.js'), 'fixture', '--format', 'wav', '--name', '#508 試し/名前'],
          { encoding: 'utf8', env: nenv, maxBuffer: 64 * 1024 * 1024 });
        const wantWav = path.join(exDir, '#508 試し／名前.wav');
        check('同じ名前で WAV と MP3 を書き分けても、どちらも次に置き換えてよい（この回の書き出しの一覧で覚える）',
          namedWav.status === 0 && overwriteCheck(wantWav, path.join(dataDir, 'fixture')).replaceable && overwriteCheck(want, path.join(dataDir, 'fixture')).replaceable,
          namedWav.status === 0 ? '' : namedWav.stderr.slice(-200));
        // 前に書き出した場所に、別のファイル（GarageBand の書き出しなど）が同じ名前で置き直されていたら、置き換えない（中身の番号で見る・
        // 2026-10-19 の監査。前は「前に同じ場所へ書き出した」だけで置き換えていた）
        const other = `${want}.new`;
        fs.writeFileSync(other, '同じ名前で置き直した別のファイル');
        fs.renameSync(other, want);
        check('前に書き出した場所に、同じ名前の別のファイルが置き直されていたら置き換えない',
          rec && rec.ino && !overwriteCheck(want, path.join(dataDir, 'fixture')).replaceable, rec ? `記録の番号 ${rec.ino}` : '記録が無い');
        fs.rmSync(path.join(dataDir, 'fixture', 'export.json'), { force: true }); // 試しの書き出しの記録は残さない
        fs.rmSync(exDir, { recursive: true, force: true });
      }
    }

    // 12) 新しい回を作る（画面に録音を落とした時と同じ流れ: サーバーが import.json を置いて ui/import.js を走らせる）。
    //     間の詰め方は新しい回の窓で決めた値（2026-10-19）: 2秒以上の間を 0.6秒に
    const imId = 'import-check';
    fs.rmSync(path.join(dataDir, imId), { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir, imId), { recursive: true });
    fs.writeFileSync(path.join(dataDir, imId, 'import.json'), JSON.stringify({ name: '取り込みの確認', files, bgm: null, cm: null, tight: 2, gap: 0.6 }));
    const im = spawnSync('node', [path.join(ROOT, 'ui', 'import.js'), imId], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    check('新しい回を作る（録音を落とした時の流れ）', im.status === 0, im.status !== 0 ? im.stderr.slice(-200) : '');
    if (im.status === 0) {
      const q = JSON.parse(fs.readFileSync(path.join(dataDir, imId, 'project.json'), 'utf8'));
      const ok = q.tracks.every(t => t.source && Math.abs(t.source.offset - expected[path.basename(t.source.file)]) <= TOL);
      check('新しい回の頭揃えが正しい', ok, q.tracks.map(t => `${path.basename(t.source.file)} ${t.source.offset}`).join(' / '));
      const qh = q.cuts.find(c => c.origin === 'head');
      check('新しい回（録音を落とした時の流れ）でも、手拍子より前を切る所が入る', qh && qh.start === 0 && qh.end > 0.3,
        qh ? `0〜${qh.end}秒` : '入っていない');
      check('頭揃えの一時ファイルを消した', !fs.existsSync(path.join(dataDir, imId, 'work', 'aligned')));
      // 窓で決めた間の詰め方（2秒以上の間を 0.6秒に）を、自動編集の決まり（余白 0.3秒・切る長さ 1.4秒以上）に直して切る所を探す。
      // 同じ決まりで 3) の頭揃え済みの音から探した切る所と同じで、既定（1.4秒以上の間）より少ない
      const ap = q.autoParams;
      const same = run('analyze.js', alignedFiles, { env: { ...process.env, PAD: '0.3', MIN_CUT: '1.4' } });
      const want = same.status === 0 ? JSON.stringify(JSON.parse(same.stdout).cuts) : null;
      const qa = q.cuts.filter(c => c.origin === 'auto').map(c => [c.start, c.end]);
      check('新しい回の窓で決めた間の詰め方（2秒以上の間を 0.6秒に）で切る所を探す',
        ap && ap.pad === 0.3 && ap.minCut === 1.4 && JSON.stringify(qa) === want && qa.length > 0 && qa.length < cuts.cuts.length,
        `${qa.length}か所（既定の 1.4秒以上なら ${cuts.cuts.length}か所）・決まり ${JSON.stringify(ap)}`);
    }

    // 12b) 頭揃えが自動で決まらない時（2026-10-23・倉田さんの考えた流れ）: 止めずに「頭揃え待ち」の回として読み込み（切る所・被り・
    //      手拍子より前を切る所は無し）、手で選んだ手拍子（画面の「頭を揃える」窓が import.json に書く claps）でもう一度走らせると、
    //      正しく揃って、切る所と被りの印が入る。決まらない録音は、自動の判定を環境変数で全部効かなくして作る
    {
      const pdId = 'align-pending';
      const pdDir = path.join(dataDir, pdId);
      fs.rmSync(pdDir, { recursive: true, force: true });
      fs.mkdirSync(pdDir, { recursive: true });
      const job = { name: '頭揃え待ちの確認', files, bgm: null, cm: null };
      fs.writeFileSync(path.join(pdDir, 'import.json'), JSON.stringify(job));
      const noSync = { ...env, CLAP_QUIET_DB: '-400', MIN_LOCAL: '2', MIN_CORR: '2', MIN_TURN: '2' };
      const importOnce = () => spawnSync('node', [path.join(ROOT, 'ui', 'import.js'), pdId], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: noSync });
      const pd = importOnce();
      const pp = pd.status === 0 ? JSON.parse(fs.readFileSync(path.join(pdDir, 'project.json'), 'utf8')) : null;
      check('頭揃えが決まらなくても止めずに「頭揃え待ち」の回として読み込む（切る所・被りはまだ探さない）',
        Boolean(pp && JSON.stringify(pp.alignPending) === JSON.stringify(files.slice(1).map((_, i) => i + 1)) && pp.cuts.length === 0 && pp.overlaps.length === 0),
        pp ? `頭揃え待ち ${JSON.stringify(pp.alignPending)}・切る所 ${pp.cuts.length}・被り ${pp.overlaps.length}` : pd.stderr.slice(-200));
      if (pp) {
        // 手で選んだ手拍子: 基準の手拍子（自動の判定を効かなくしたので、高い音が一番大きい所＝合成音源の手拍子）から、正しいずれを引いた時刻
        const ref0 = JSON.parse(fs.readFileSync(path.join(pdDir, 'work', 'sync.json'), 'utf8')).results[0].clapAt;
        const claps = files.map(f => +(ref0 - expected[path.basename(f)]).toFixed(4));
        fs.writeFileSync(path.join(pdDir, 'import.json'), JSON.stringify({ ...job, claps }));
        const pd2 = importOnce();
        const p2 = pd2.status === 0 ? JSON.parse(fs.readFileSync(path.join(pdDir, 'project.json'), 'utf8')) : null;
        const auto = p2 ? p2.cuts.filter(c => c.origin === 'auto').length : 0;
        // 被りの印は、同じ揃え方で作った 9) の回と同じ数だけ入る
        const fx = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture', 'project.json'), 'utf8'));
        check('手で選んだ手拍子で揃え直すと、頭揃えが正しく、手拍子より前を切る所・切る所・被りの印が入る',
          Boolean(p2 && !p2.alignPending && p2.tracks.every(t => Math.abs(t.source.offset - expected[path.basename(t.source.file)]) <= 0.001)
            && p2.cuts.some(c => c.origin === 'head') && auto > 0 && p2.overlaps.length === fx.overlaps.length && fx.overlaps.length > 0),
          p2 ? `${p2.tracks.map(t => `${path.basename(t.source.file)} ${t.source.offset}`).join(' / ')}・切る所 ${auto}・被り ${p2.overlaps.length}（9) の回 ${fx.overlaps.length}）`
            : pd2.stderr.slice(-200));
      }
    }

    // 13) 落とされたファイルの元の場所を探せるか（名前・大きさ・更新日時。名前の濁点の持ち方が違っても）
    {
      const { findOriginals } = require('../ui/files');
      const searchDir = path.join(dataDir, 'search');
      fs.mkdirSync(searchDir, { recursive: true });
      const jp = path.join(searchDir, 'テスト.wav');
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=d=1:r=44100', jp]);
      const st = fs.statSync(jp);
      process.env.HIMADAN_SEARCH = searchDir;
      const [hit, miss] = findOriginals([
        { name: 'テスト.wav'.normalize('NFD'), size: st.size, lastModified: st.mtimeMs },
        { name: 'テスト.wav', size: st.size + 1, lastModified: st.mtimeMs },
      ]);
      delete process.env.HIMADAN_SEARCH;
      check('落とされたファイルの元の場所を探せる（濁点の持ち方が違っても）', hit === jp, hit || '見つからない');
      check('大きさが違えば別のファイルとみなす（コピーに回す）', miss === null);
    }

    // 14) CM のフォルダを選ぶ（2026-10-18）: サーバーを立て、フォルダを選んだことにして（HIMADAN_CHOOSE_FOLDER＝窓を出さない）、
    //     覚える（回の置き場の隣の settings.json）・CM の一覧がそのフォルダの中身になる・`~/Documents` の外のフォルダの CM にも入れ替えられる
    {
      const cmFolder = path.join(dataDir, 'cm-folder');
      fs.mkdirSync(cmFolder, { recursive: true });
      const cmFile = path.join(cmFolder, 'テストのCM.mp3');
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', cmFile]);
      const settings = path.join(path.dirname(dataDir), 'settings.json');
      fs.rmSync(settings, { force: true });
      const port = 18000 + (process.pid % 1000);
      const senv = { ...env, HIMADAN_CHOOSE_FOLDER: cmFolder };
      delete senv.HIMADAN_CM_DIR;
      delete senv.HIMADAN_EXPORT; // 書き出し先を選ぶ確かめで、設定が効くように
      const server = require('child_process').spawn('node', [path.join(ROOT, 'ui', 'serve.js'), String(port)], { env: senv, stdio: 'ignore' });
      const curl = (method, url, body) => {
        const r = spawnSync('curl', ['-s', '-X', method, '-H', 'x-himadan: 1', '-H', 'Content-Type: application/json',
          ...(body ? ['-d', JSON.stringify(body)] : []), `http://127.0.0.1:${port}${url}`], { encoding: 'utf8' });
        try { return JSON.parse(r.stdout); } catch { return null; }
      };
      let up = false;
      for (let i = 0; i < 50 && !up; i++) { up = !!curl('GET', '/api/projects'); if (!up) spawnSync('sleep', ['0.2']); }
      check('サーバーが立つ（CM のフォルダの確認用）', up);
      if (up) {
        const chose = curl('POST', '/api/cm/folder', {});
        const saved = (() => { try { return JSON.parse(fs.readFileSync(settings, 'utf8')).cmDir; } catch { return null; } })();
        const list = curl('GET', '/api/cm');
        check('CM のフォルダを選ぶと覚えて、一覧がそのフォルダの中身になる',
          chose && chose.chosen && saved === cmFolder && list && list.files.length === 1 && list.files[0].path === cmFile,
          chose ? `覚えた所 ${saved}・一覧 ${list && list.files.map(f => f.name).join(' / ')}` : '答えが無い');
        const swapped = curl('POST', '/api/projects/fixture/asset', { kind: 'cm', path: cmFile });
        check('選んだフォルダの CM に入れ替えられる（書類フォルダの外でも）', swapped && swapped.project && swapped.project.cm && swapped.project.cm.file === cmFile,
          swapped && swapped.error ? swapped.error : '');
        // 別のフォルダに変えた後でも、回で使っている CM（「最近の回で使った CM」の欄に出る物）は選べる。どの回でも使っていない、
        // 選んでいないフォルダの音は選べない（好きな場所のファイルをサーバーに読ませない）
        const other = path.join(dataDir, 'cm-folder-2'), stray = path.join(dataDir, 'cm-folder-3', 'よそのCM.mp3');
        fs.mkdirSync(other, { recursive: true });
        fs.mkdirSync(path.dirname(stray), { recursive: true });
        spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=2', stray]);
        fs.writeFileSync(settings, JSON.stringify({ cmDir: other }));
        const again = curl('POST', '/api/projects/fixture/asset', { kind: 'cm', path: cmFile });
        const refused = curl('POST', '/api/projects/fixture/asset', { kind: 'cm', path: stray });
        check('別のフォルダに変えた後でも回で使っている CM は選べて、どこでもない所の音は選べない',
          again && again.project && again.project.cm && again.project.cm.file === cmFile && refused && refused.error && !refused.project,
          `使っている CM ${again && again.error ? again.error : 'OK'}・よその音 ${refused && refused.error ? `断った（${refused.error}）` : '断らなかった'}`);

        // 書き出し先のフォルダを選ぶ（2026-10-18）: 選ぶと覚えて（settings.json の exportDir）、書き出しの窓の書き出し先がそのフォルダになる
        const fxName = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture', 'project.json'), 'utf8')).name;
        const exChose = curl('POST', '/api/export/folder', {});
        const exSaved = (() => { try { return JSON.parse(fs.readFileSync(settings, 'utf8')).exportDir; } catch { return null; } })();
        const exView = curl('GET', '/api/projects/fixture/export');
        check('書き出し先のフォルダを選ぶと覚えて、書き出しの窓の書き出し先がそのフォルダになる',
          exChose && exChose.chosen && exSaved === cmFolder && exView && exView.targets && exView.targets.wav.path === path.join(cmFolder, `${fxName}.wav`) &&
          exView.folder && exView.folder.chosen && !exView.folder.fixed,
          exView && exView.targets ? exView.targets.wav.path : '答えが無い');
        // 書き出しの窓の名前の欄: その名前の書き出し先と、置き換えの心配（書き出し先に CM がある。CM と同じ名前は置き換えない）
        const exNamed = curl('GET', `/api/projects/fixture/export?name=${encodeURIComponent('テストのCM')}`);
        const t3 = exNamed && exNamed.targets && exNamed.targets.mp3;
        check('書き出しの窓の名前で、書き出し先と「置き換えてよいか」が分かる（CM と同じ名前は置き換えない）',
          t3 && t3.path === cmFile && t3.exists && !t3.replaceable && exNamed.name === 'テストのCM', t3 ? JSON.stringify(t3) : '答えが無い');

        // 15) 前の回の設定を引き継ぐ（2026-10-18）: 編集の状態が無い新しい回（取り込みの確認で作った回）を開くと、いちばん最近触った
        //     version 2 以上の回（fixture）の値が inherit で届く。切った所などは届かない
        const fx = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture', 'project.json'), 'utf8'));
        const fxState = path.join(dataDir, 'fixture', 'state.json');
        // 新しい回の窓の間の詰め方は、前の回で選んだ値だけ引き継ぐ（2026-10-19）。fixture は窓を通さずに作った回（import.json が無い）
        // なので、作った時の決まり（1.4秒・0.4秒）のままなら引き継がず、既定（1.2秒・0.4秒）から始まる
        fs.writeFileSync(fxState, JSON.stringify({ projectCreatedAt: fx.createdAt, cuts: fx.cuts, mutes: [], tight: 1.4, tightGap: 0.4 }));
        const io0 = curl('GET', '/api/import/options');
        check('前の回が作った時の詰め方のまま（窓で選んでも「調整」で変えてもいない）なら、引き継がずに既定の 1.2秒・0.4秒から始まる',
          io0 && io0.tight && io0.tight.tight === 1.2 && io0.tight.gap === 0.4 && io0.tight.from === null, io0 ? JSON.stringify(io0.tight) : '答えが無い');
        // 窓を通して作った回でも、既定のまま作った回（tightChosen: false）からは引き継がない。印の無い前の記録は、窓で決めた物として
        // 引き継ぐ（2026-10-19 の監査。前は窓を通した回をいつも「選んだ」に数え、次に既定を変えた時に前の既定が引き継がれ続けた）
        const fxImport = path.join(dataDir, 'fixture', 'import.json');
        fs.writeFileSync(fxImport, JSON.stringify({ tight: 1.4, gap: 0.4, tightChosen: false }));
        const ioD = curl('GET', '/api/import/options');
        fs.writeFileSync(fxImport, JSON.stringify({ tight: 1.4, gap: 0.4 }));
        const ioC = curl('GET', '/api/import/options');
        fs.rmSync(fxImport, { force: true });
        check('窓で既定のまま作った回からは引き継がず、窓で決めた回（前の記録）からは引き継ぐ',
          ioD && ioD.tight && ioD.tight.from === null && ioD.tight.tight === 1.2 && ioC && ioC.tight && ioC.tight.from === fx.name && ioC.tight.tight === 1.4,
          `既定のまま ${ioD && JSON.stringify(ioD.tight)}・前の記録 ${ioC && JSON.stringify(ioC.tight)}`);
        fs.writeFileSync(fxState, JSON.stringify({
          projectCreatedAt: fx.createdAt, cuts: fx.cuts, mutes: [], splits: [], keeps: [],
          bgm: { mute: false, volume: 0.2, fadeOut: 5 }, cm: { mute: false, gap: -3, fadeIn: 1 }, exportFormat: 'mp3', jumpLead: 4,
          tight: 2.2, tightGap: 0.5,
        }));
        // 新しい回の窓の間の詰め方の初めの値（2026-10-19）は、いちばん最近触った回（fixture）で使っていた値
        const io = curl('GET', '/api/import/options');
        check('新しい回の窓の間の詰め方は、いちばん最近触った回の値から始まる',
          io && io.tight && io.tight.tight === 2.2 && io.tight.gap === 0.5 && io.tight.from === fx.name, io ? JSON.stringify(io.tight) : '答えが無い');
        // 回の一覧に作った日時（同じ名前の回が並んだ時、画面が日付を添えて見分ける）
        const pl = curl('GET', '/api/projects');
        check('回の一覧に作った日時が付く', pl && pl.length >= 2 && pl.every(x => typeof x.createdAt === 'string' && !Number.isNaN(Date.parse(x.createdAt))),
          pl ? pl.map(x => `${x.name} ${x.createdAt}`).join(' / ') : '答えが無い');
        const opened = curl('GET', `/api/projects/${imId}`);
        const inh = opened && opened.inherit;
        check('新しい回を開くと、前の回の設定が届く（BGM の音量とフェード・CM の位置とフェード・書き出しの形・何秒前）',
          opened && opened.state === null && inh && inh.from === fx.name && inh.bgm.volume === 0.2 && inh.bgm.fadeOut === 5 &&
          inh.cm.gap === -3 && inh.cm.fadeIn === 1 && inh.exportFormat === 'mp3' && inh.jumpLead === 4 && !('cuts' in inh),
          inh ? JSON.stringify(inh) : '届かない');
        const self = curl('GET', '/api/projects/fixture');
        check('編集の状態がある回には、前の回の設定を添えない', self && self.state && self.inherit === null);
        fs.rmSync(fxState, { force: true });
      }
      server.kill();
      fs.rmSync(settings, { force: true });
    }

    // 16) 説明文と目次の下書き（2026-10-18）: 偽の Whisper（test/fake-whisper.js）と偽の AI・RSS（test/fake-ai.js）で ui/describe.js を走らせる。
    //     鍵は HIMADAN_AI_KEY（キーチェーンを触らない）。書き出しの記録は試し用に置き換える（書き出し先＝dataDir・本編 40秒・CM は
    //     2秒前から重ねる＝CM の頭は 38秒）
    {
      const fixDir = path.join(dataDir, 'fixture');
      const exJson = path.join(fixDir, 'export.json');
      const exBackup = fs.existsSync(exJson) ? fs.readFileSync(exJson) : null;
      fs.writeFileSync(exJson, JSON.stringify({ out: path.join(dataDir, 'out.wav'), talk: 40, duration: 52, cm: { gap: -2 } }));
      const settings = path.join(path.dirname(dataDir), 'settings.json');
      const aiPort = 19000 + (process.pid % 1000), port = 17000 + (process.pid % 1000);
      const aiLog = path.join(dataDir, 'fake-ai-last.json');
      const fake = require('child_process').spawn('node', [path.join(__dirname, 'fake-ai.js'), String(aiPort), aiLog], { stdio: 'ignore' });
      const denv = { ...env, HIMADAN_EXPORT: dataDir, HIMADAN_WHISPER: path.join(__dirname, 'fake-whisper.js'),
        HIMADAN_AI_BASE: `http://127.0.0.1:${aiPort}`, HIMADAN_AI_KEY: 'test-key', HIMADAN_RSS: `http://127.0.0.1:${aiPort}/rss` };
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        up = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${aiPort}/rss`], { encoding: 'utf8' }).stdout === '200';
        if (!up) spawnSync('sleep', ['0.2']);
      }
      check('偽の AI・RSS が立つ（説明文の確認用）', up);
      // AI を選んで（settings.json）describe.js を走らせ、できた物（description.json）を読む
      const describe = (provider, extraEnv = {}) => {
        if (provider) fs.writeFileSync(settings, JSON.stringify({ ai: { provider } })); else fs.rmSync(settings, { force: true });
        fs.rmSync(path.join(fixDir, 'description.json'), { force: true });
        const r = spawnSync('node', [path.join(ROOT, 'ui', 'describe.js'), 'fixture'], { encoding: 'utf8', env: { ...denv, ...extraEnv } });
        let d = null;
        try { d = JSON.parse(fs.readFileSync(path.join(fixDir, 'description.json'), 'utf8')); } catch { /* 作れなかった */ }
        return { status: r.status, stderr: r.stderr, d };
      };
      const sent = () => { try { return JSON.parse(fs.readFileSync(aiLog, 'utf8')); } catch { return {}; } };
      if (up) {
        fs.rmSync(path.join(fixDir, 'transcript.json'), { force: true });
        // a) AI を使わない: 文字起こし（空耳を除く）と「AI に頼む文」まで。次の番号は RSS の最新（#507）の次
        const none = describe(null);
        const nd = none.d || {}, tx = nd.transcriptText || '', pr = nd.prompt || '';
        check('説明文（AI なし）: 文字起こしと「AI に頼む文」まで作り、次の番号は RSS の最新の次',
          none.status === 0 && nd.ai === false && nd.number === 508, none.status === 0 ? `#${nd.number}` : none.stderr.slice(-200));
        check('文字起こしから空耳（決まり文句・3回以上のくり返し）を除く',
          tx.includes('[00:30] 本題に入ります') && !tx.includes('ご視聴') && tx.split('あはは').length === 2 && tx.includes('おしまいです'), tx.replace(/\n/g, ' / '));
        check('AI に頼む文は CM の頭（本編の終わりの2秒前）までの文字起こしで、「#508 {タイトル}」の形を頼む',
          pr.includes('[00:30] 本題に入ります') && !pr.includes('おしまいです') && pr.includes('00:38 より後は CM') && pr.includes('「#508 {タイトル}」'),
          `CM の頭 ${nd.cmStart}秒`);
        // b) Gemini: 下書きを読み、説明文は本文 → 目次 → 紹介 → 呼びかけ → 定型。形の違う時刻・音より後の時刻は目次から捨てる
        const tMtime = fs.statSync(path.join(fixDir, 'transcript.json')).mtimeMs;
        const gm = describe('gemini'), g = gm.d || {}, gs = sent();
        const { DEFAULT_FOOTER } = require('../ui/describe');
        check('説明文（Gemini）: タイトル案4つ・目次は正しい時刻だけ（12:99・音より後の 99:00 は捨てる）',
          gm.status === 0 && g.ai === true && g.titles.length === 4 && JSON.stringify((g.toc || []).map(x => x.t)) === '["00:00","00:30"]',
          gm.status === 0 ? `目次 ${(g.toc || []).map(x => x.t).join(' ')}` : gm.stderr.slice(-200));
        check('説明文の全文は 本文 → ▼目次 → ▼本日紹介したもの → 呼びかけ → 定型 の順',
          typeof g.description === 'string' && g.description.startsWith('偽の本文です。') && g.description.endsWith(DEFAULT_FOOTER) &&
          g.description.includes('▼目次\n00:00 オープニング\n00:30 本題\n\n▼本日紹介したもの\n・偽の本\n\nお便りお待ちしています。'));
        check('Gemini の窓口へ、鍵を x-goog-api-key で・文字起こしを入れて送る（無料枠のいちばん新しい gemini-3.8-flash）',
          gs.url === '/v1beta/models/gemini-3.8-flash:generateContent' && gs.headers && gs.headers['x-goog-api-key'] === 'test-key' &&
          String(gs.body).includes('本題に入ります'), gs.url || '届いていない');
        // 下書きに、書いた AI とモデルの名前が残る（画面の見出しに出し、今の設定と違えば知らせる・2026-10-19・倉田さん「ここ今選んでる
        // モデルの反映されるべきじゃない？」）
        check('できた下書きに、書いた AI とモデルの名前が残る', g.provider === 'gemini' && g.model === 'gemini-3.8-flash', `${g.provider}・${g.model}`);
        // 今日の日付と、知らない製品名・版を古い知識で直さない決まりも頼む（2026-10-19・Gemini が新しいモデル名を古い版と違うと挙げていた）
        const today = new Date();
        const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        check('AI に頼む文に今日の日付と、知らない製品名・版を古い知識で直さない決まりが入る',
          String(gs.body).includes(`今日は ${ymd} です`) && String(gs.body).includes('あなたの知識より新しいことがある'), ymd);
        check('音が同じなら文字起こしを使い回す', fs.statSync(path.join(fixDir, 'transcript.json')).mtimeMs === tMtime);
        // c) Claude・OpenAI の窓口の形（Claude は JSON の前に文が付いても読む）
        const cl = describe('claude'), cs = sent();
        check('説明文（Claude）: 前に文が付いた返事も読み、鍵は x-api-key で送る',
          cl.status === 0 && cl.d && cl.d.ai && cl.d.titles.length === 4 && cs.headers && cs.headers['x-api-key'] === 'test-key' &&
          JSON.parse(cs.body || '{}').model === 'claude-sonnet-5-5', cl.status === 0 ? '' : cl.stderr.slice(-200));
        const oa = describe('openai'), os2 = sent();
        check('説明文（OpenAI）: 鍵は Authorization: Bearer で送る',
          oa.status === 0 && oa.d && oa.d.ai && os2.headers && os2.headers.authorization === 'Bearer test-key', oa.status === 0 ? '' : oa.stderr.slice(-200));
        // d) 鍵が無い時は、AI を呼ばずに「AI に頼む文」まで（止めない）
        const nk = describe('gemini', { HIMADAN_AI_KEY: '' });
        check('鍵が無い時は AI を呼ばず、「AI に頼む文」までにして鍵を入れるよう案内する',
          nk.status === 0 && nk.d && nk.d.ai === false && /鍵が入っていません/.test(nk.d.reason || ''), nk.d ? nk.d.reason : nk.stderr.slice(-200));
        // 鍵が違う・つながらない時は、何をすればよいかを日本語で（各社の英語の理由だけにしない）
        const bk = describe('gemini', { HIMADAN_AI_KEY: 'bad-key' });
        const nc = describe('gemini', { HIMADAN_AI_BASE: 'http://127.0.0.1:9' });
        check('鍵が違う時・AI につながらない時は、何をすればよいかを日本語で出して止まる',
          bk.status !== 0 && bk.stderr.includes('鍵が違うか、使えなくなっています') && nc.status !== 0 && nc.stderr.includes('につながりませんでした'),
          `${bk.stderr.trim().slice(0, 50)} / ${nc.stderr.trim().slice(0, 50)}`);
        // 混んでいる時（5xx）は、間を空けてやり直し、だめなら軽いモデルで試す。回数の上限（429）はやり直さない（2026-10-23・その日
        // Gemini が 503「high demand」を返して止まった）。偽の AI の鍵で場面を作り、待つ秒数は 0 にする
        const busyRun = key => {
          fs.writeFileSync(settings, JSON.stringify({ ai: { provider: 'gemini' } }));
          fs.rmSync(path.join(fixDir, 'description.json'), { force: true });
          const r = spawnSync('node', [path.join(ROOT, 'ui', 'describe.js'), 'fixture', '--progress'],
            { encoding: 'utf8', env: { ...denv, HIMADAN_AI_KEY: key, HIMADAN_AI_WAIT: '0,0' } });
          const steps = r.stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(x => x && x.type === 'progress').map(x => x.step);
          let calls = [], d = null;
          try { calls = JSON.parse(spawnSync('curl', ['-s', `http://127.0.0.1:${aiPort}/calls/${key}`], { encoding: 'utf8' }).stdout); } catch { /* 数えられない */ }
          try { d = JSON.parse(fs.readFileSync(path.join(fixDir, 'description.json'), 'utf8')); } catch { /* 作れなかった */ }
          return { status: r.status, stdout: r.stdout, steps, calls, d };
        };
        const b2 = busyRun('busy-2');
        check('説明文: 混んでいる（503）時は、やり直していることを出しながら3回まで頼み、3回目で書ける',
          b2.status === 0 && b2.d && b2.d.model === 'gemini-3.8-flash' && b2.calls.length === 3 &&
            b2.steps.includes('混んでいるので、やり直しています（2/3）') && b2.steps.includes('混んでいるので、やり直しています（3/3）'),
          `${b2.calls.length}回・${b2.d ? b2.d.model : '作れない'}`);
        const bl = busyRun('busy-lite');
        check('説明文: 3回とも混んでいたら、軽いモデル（gemini-3.5-flash-lite）で書き、そのモデルの名前を残す',
          bl.status === 0 && bl.d && bl.d.model === 'gemini-3.5-flash-lite' && bl.steps.some(s => s.includes('軽いモデル')) &&
            JSON.stringify(bl.calls) === JSON.stringify(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']),
          bl.calls.join(' → '));
        const ba = busyRun('busy-all');
        check('説明文: 軽いモデルも混んでいたら、初めの「混んでいる」の知らせを出して止まる',
          ba.status !== 0 && /混んでいるようです/.test(ba.stdout) && ba.calls.length === 4, `${ba.calls.length}回`);
        const lm = busyRun('limit');
        check('説明文: 回数の上限（429）はやり直さない', lm.status !== 0 && /使える回数の上限/.test(lm.stdout) && lm.calls.length === 1, `${lm.calls.length}回`);
        // e) 書き出していない回・決まった書き出し先の外へ書き出しただけの回は、先に書き出すよう案内して止まる
        const nx = spawnSync('node', [path.join(ROOT, 'ui', 'describe.js'), imId], { encoding: 'utf8', env: denv });
        const outside = spawnSync('node', [path.join(ROOT, 'ui', 'describe.js'), 'fixture'], { encoding: 'utf8', env: { ...denv, HIMADAN_EXPORT: path.join(dataDir, 'よそ') } });
        check('書き出していない回・書き出し先の外へ書き出しただけの回は、先に書き出すよう案内して止まる',
          nx.status !== 0 && nx.stderr.includes('先に書き出してください') && outside.status !== 0 && outside.stderr.includes('先に書き出してください'),
          `${nx.stderr.trim().slice(0, 60)} / ${outside.stderr.trim().slice(0, 60)}`);
        // 書き出し先を後で変えても、書き出した時の書き出し先（export.json の dir）に書いた物は使える（dir の無い前の記録は、
        // 今の書き出し先で見る＝上の確かめ）
        fs.writeFileSync(exJson, JSON.stringify({ out: path.join(dataDir, 'out.wav'), dir: dataDir, talk: 40, duration: 52, cm: { gap: -2 } }));
        const moved = spawnSync('node', [path.join(ROOT, 'ui', 'describe.js'), 'fixture'], { encoding: 'utf8', env: { ...denv, HIMADAN_EXPORT: path.join(dataDir, 'よそ') } });
        check('書き出し先を変えても、書き出した時の書き出し先に書いた物から説明文を作れる', moved.status === 0, moved.status === 0 ? '' : moved.stderr.trim().slice(0, 120));
        // 書き出した日時（exportedAt）も入れておく（サーバーが画面に渡し、画面は前の書き出しから作った下書きに「作り直す」を案内する）
        const exAt = new Date(Date.now() - 60000).toISOString();
        fs.writeFileSync(exJson, JSON.stringify({ out: path.join(dataDir, 'out.wav'), talk: 40, duration: 52, cm: { gap: -2 }, exportedAt: exAt }));
        // 文字起こしの途中で「やめる」（サーバーと同じ SIGTERM）と、文字起こしの道具も止まる（裏で走り続けない）
        const fakeWhisper = path.join(__dirname, 'fake-whisper.js');
        const slow = require('child_process').spawn('node', [path.join(ROOT, 'ui', 'describe.js'), 'fixture', '--again'],
          { env: { ...denv, HIMADAN_FAKE_WHISPER_WAIT: '30' }, stdio: 'ignore' });
        let started = false;
        for (let i = 0; i < 50 && !started; i++) { started = spawnSync('pgrep', ['-f', fakeWhisper]).status === 0; if (!started) spawnSync('sleep', ['0.1']); }
        slow.kill('SIGTERM');
        let left = true;
        for (let i = 0; i < 30 && left; i++) { spawnSync('sleep', ['0.1']); left = spawnSync('pgrep', ['-f', fakeWhisper]).status === 0; }
        check('作る途中で「やめる」と、文字起こしの道具も止まる', started && !left, started ? (left ? '文字起こしが残った' : '') : '文字起こしが始まらなかった');

        // f) 画面の窓口: AI の設定は鍵を返さず、settings.json にも書かない。空白の混ざった鍵は断る。画面の「作る」と同じ流れで作れる
        const server = require('child_process').spawn('node', [path.join(ROOT, 'ui', 'serve.js'), String(port)], { env: denv, stdio: 'ignore' });
        const curl = (method, url, body) => {
          const r = spawnSync('curl', ['-s', '-X', method, '-H', 'x-himadan: 1', '-H', 'Content-Type: application/json',
            ...(body ? ['-d', JSON.stringify(body)] : []), `http://127.0.0.1:${port}${url}`], { encoding: 'utf8' });
          try { return JSON.parse(r.stdout); } catch { return null; }
        };
        let sUp = false;
        for (let i = 0; i < 50 && !sUp; i++) { sUp = !!curl('GET', '/api/ai'); if (!sUp) spawnSync('sleep', ['0.2']); }
        check('サーバーが立つ（説明文の確認用）', sUp);
        if (sUp) {
          const KEY = 'AIzaTest0123456789';
          const saved = curl('POST', '/api/ai', { provider: 'gemini', key: KEY, model: '' });
          const sText = (() => { try { return fs.readFileSync(settings, 'utf8'); } catch { return ''; } })();
          check('AI の設定: 選んだ AI を覚え、鍵は答えにも設定のファイルにも出さない',
            saved && saved.provider === 'gemini' && saved.providers.length === 3 && !JSON.stringify(saved).includes(KEY) && sText.includes('gemini') && !sText.includes(KEY),
            saved ? `${saved.provider}・${sText.replace(/\s+/g, '')}` : '答えが無い');
          const bad = curl('POST', '/api/ai', { provider: 'gemini', key: 'AIza Test' });
          const odd = curl('POST', '/api/ai', { provider: 'constructor' }); // どの物にもある名前（一覧の AI と取り違えない）
          check('空白の混ざった鍵（貼り間違い）・一覧に無い AI の名前は断る', bad && bad.error && !bad.providers && odd && odd.error && !odd.providers,
            `${bad && bad.error} / ${odd && odd.error}`);
          const fixedEx = curl('POST', '/api/export/folder', {});
          check('試しの書き出し先（HIMADAN_EXPORT）が決まっている時は、画面から書き出し先を変えない', fixedEx && fixedEx.error && !fixedEx.chosen,
            fixedEx && fixedEx.error);
          // 中身が null の保存でも、サーバーは止まらずに断る（前は null.cuts で投げてサーバーごと止まった・2026-10-19 の監査）
          const nullSave = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H', 'x-himadan: 1', '-H', 'Content-Type: application/json',
            '-d', 'null', `http://127.0.0.1:${port}/api/projects/fixture/state`], { encoding: 'utf8' }).stdout;
          const alive = !!curl('GET', '/api/ai');
          check('中身が null の保存は断り、サーバーは止まらない', nullSave === '400' && alive, `${nullSave}・${alive ? '動いている' : '止まった'}`);
          curl('POST', '/api/projects/fixture/describe', {});
          let st = null;
          for (let i = 0; i < 100; i++) { st = curl('GET', '/api/projects/fixture/describe'); if (st && st.state !== 'running') break; spawnSync('sleep', ['0.2']); }
          check('画面の「作る」と同じ流れ（サーバーが ui/describe.js を走らせる）で作れて、書き出し済みと出る',
            st && st.state === 'done' && st.last && st.last.ai === true && st.last.titles.length === 4 && st.exported === true,
            st ? `${st.state}${st.error ? `: ${st.error}` : ''}` : '答えが無い');
          // 書き出しの日時も渡す（画面は、下書きがそれより前なら「前の書き出しから作りました」と「作り直す」を案内する・2026-10-19）
          check('説明文の窓口は書き出しの日時も返し、今の書き出しから作った下書きはそれより後になる',
            st && st.exportedAt === exAt && st.last && new Date(st.last.createdAt) > new Date(st.exportedAt),
            st ? `書き出し ${st.exportedAt}・下書き ${st.last && st.last.createdAt}` : '答えが無い');
        }
        server.kill();
      }
      fake.kill();
      fs.rmSync(settings, { force: true });
      fs.rmSync(aiLog, { force: true });
      fs.rmSync(path.join(fixDir, 'description.json'), { force: true });
      fs.rmSync(path.join(fixDir, 'transcript.json'), { force: true });
      if (exBackup) fs.writeFileSync(exJson, exBackup); else fs.rmSync(exJson, { force: true });
    }

    // 18) 回を消す（2026-10-19 倉田さん「これってどこで消せるの？なんか一生溜まっちゃうじゃん」→「整理する…」の窓でまとめて消す）:
    //     窓の一覧に出す物・書き出しの最中は消さない・回のフォルダだけがゴミ箱へ移る（元の録音は残る）。窓は印を付けた回ごとに同じ窓口へ送る。
    //     ゴミ箱は試し用のフォルダ（HIMADAN_TRASH）で、Mac のゴミ箱は使わない。
    //     新しい回の窓の間の詰め方を、サーバーがつまみの幅に整えて import.json に書くかも見る
    {
      const trashDir = path.join(dataDir, 'trash-check'), exTmp = path.join(dataDir, 'trash-export');
      fs.rmSync(trashDir, { recursive: true, force: true });
      fs.rmSync(exTmp, { recursive: true, force: true });
      const port = 16000 + (process.pid % 1000);
      const tenv = { ...env, HIMADAN_TRASH: trashDir, HIMADAN_SEARCH: dir, HIMADAN_EXPORT: exTmp };
      const server = require('child_process').spawn('node', [path.join(ROOT, 'ui', 'serve.js'), String(port)], { env: tenv, stdio: 'ignore' });
      const curl = (method, url, body) => {
        const r = spawnSync('curl', ['-s', '-X', method, '-H', 'x-himadan: 1', '-H', 'Content-Type: application/json',
          ...(body ? ['-d', JSON.stringify(body)] : []), `http://127.0.0.1:${port}${url}`], { encoding: 'utf8' });
        try { return JSON.parse(r.stdout); } catch { return null; }
      };
      const waitDone = url => { for (let i = 0; i < 100; i++) { const s = curl('GET', url); if (s && s.state !== 'running') return s; spawnSync('sleep', ['0.2']); } return null; };
      let up = false;
      for (let i = 0; i < 50 && !up; i++) { up = !!curl('GET', '/api/projects'); if (!up) spawnSync('sleep', ['0.2']); }
      check('サーバーが立つ（回を消す確認用）', up);
      if (up) {
        const started = curl('POST', '/api/imports', { name: '詰め方の確認', files, tight: 5, gap: 0.04 });
        const imJson = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, started.id, 'import.json'), 'utf8')); } catch { return null; } })();
        if (started && started.id) { curl('POST', `/api/imports/${started.id}/cancel`, {}); waitDone(`/api/imports/${started.id}`); }
        check('新しい回の窓の間の詰め方は、つまみの幅と 0.1秒きざみに整えて覚える（5秒→3秒・0.04秒→0.1秒）・既定から動かした値は「選んだ」',
          imJson && imJson.tight === 3 && imJson.gap === 0.1 && imJson.tightChosen === true,
          imJson ? `${imJson.tight}秒・${imJson.gap}秒・選んだ ${imJson.tightChosen}` : (started && started.error) || '答えが無い');

        // 「整理する…」の窓の一覧（?detail=1）: 回ごとの大きさ・書き出し済みか・今動いている仕事
        const detail = curl('GET', '/api/projects?detail=1');
        const row = detail && detail.find(x => x.id === imId), fxRow = detail && detail.find(x => x.id === 'fixture');
        check('「整理する…」の一覧に、回ごとの大きさ・作った日時・書き出し済みか・今動いている仕事が付く',
          row && row.name === '取り込みの確認' && row.size > 1e6 && typeof row.createdAt === 'string' && row.exported === false && row.busy === null &&
          fxRow && typeof fxRow.exported === 'boolean', row ? `${row.name}・${(row.size / 1e6).toFixed(1)}MB・書き出し済み ${row.exported}` : '答えが無い');
        curl('POST', `/api/projects/${imId}/export`, { format: 'wav' });
        const busyRow = (curl('GET', '/api/projects?detail=1') || []).find(x => x.id === imId);
        const refused = curl('POST', `/api/projects/${imId}/trash`, {});
        check('書き出しの最中は一覧にそう出して、消さない',
          busyRow && busyRow.busy === '書き出し' && refused && refused.error && refused.error.includes('書き出し') && fs.existsSync(path.join(dataDir, imId, 'project.json')),
          `一覧 ${busyRow && busyRow.busy}・${refused && refused.error}`);
        curl('POST', `/api/projects/${imId}/export/cancel`, {});
        waitDone(`/api/projects/${imId}/export`);
        const done = curl('POST', `/api/projects/${imId}/trash`, {});
        const list = curl('GET', '/api/projects');
        check('回をゴミ箱に入れる: 回のフォルダだけが移り、一覧から消え、元の録音とほかの回は残る',
          done && done.ok && !fs.existsSync(path.join(dataDir, imId)) && fs.existsSync(path.join(trashDir, imId, 'project.json')) &&
          list && !list.some(x => x.id === imId) && list.some(x => x.id === 'fixture') && files.every(f => fs.existsSync(f)),
          done ? done.error || `ゴミ箱の中 ${fs.readdirSync(trashDir).join(' / ')}` : '答えが無い');
        const again = curl('POST', `/api/projects/${imId}/trash`, {});
        check('消した回をもう一度消そうとしても何もしない（見つからない）', again && again.error && !again.ok, again && again.error);
      }
      server.kill();
      fs.rmSync(trashDir, { recursive: true, force: true });
      fs.rmSync(exTmp, { recursive: true, force: true });
    }
  }

  // 17) 5人の回（ゲストを呼んだ回・2026-10-19 倉田さん「ゲストをさ、一人呼んでさ、録音が4つになったとしても使えるの？」「行っても4本か
  //     5本」）: 5本の録音を画面に落とした時と同じ流れで新しい回を作れる（人数分のトラック・頭揃え・手拍子より前を切る所）・書き出しで
  //     5人の声を重ねられる
  if (mode === 'remote5') {
    const dataDir5 = path.join(dir, 'ui-data');
    const env5 = { ...process.env, HIMADAN_DATA: dataDir5 };
    const id5 = 'five';
    fs.rmSync(path.join(dataDir5, id5), { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir5, id5), { recursive: true });
    fs.writeFileSync(path.join(dataDir5, id5, 'import.json'), JSON.stringify({ name: '5人の回', files, bgm: null, cm: null }));
    const im5 = spawnSync('node', [path.join(ROOT, 'ui', 'import.js'), id5], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: env5 });
    check('5人の録音で新しい回を作れる（録音を落とした時の流れ）', im5.status === 0, im5.status !== 0 ? im5.stderr.slice(-200) : '');
    if (im5.status === 0) {
      const q5 = JSON.parse(fs.readFileSync(path.join(dataDir5, id5, 'project.json'), 'utf8'));
      check('5人の回: トラックが5本で、頭揃えが正しい',
        q5.tracks.length === 5 && q5.tracks.every(t => t.source && Math.abs(t.source.offset - expected[path.basename(t.source.file)]) <= TOL),
        q5.tracks.map(t => `${path.basename(t.source.file)} ${t.source.offset}`).join(' / '));
      const h5 = q5.cuts.find(c => c.origin === 'head');
      check('5人の回でも手拍子より前を切る所が入る', h5 && h5.start === 0 && h5.end > 0.3, h5 ? `0〜${h5.end}秒` : '入っていない');
      const v5 = path.join(dataDir5, 'voices5.wav');
      const ev5 = spawnSync('node', [path.join(ROOT, 'ui', 'export.js'), id5, '--voices-wav', v5], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: env5 });
      const r5 = ev5.status === 0 ? JSON.parse(ev5.stdout) : null;
      check('5人の回を書き出せる（5人の声を重ねる・切った分だけ短い）', r5 && fs.existsSync(v5) && r5.talkSec > 60 && r5.talkSec < q5.duration,
        r5 ? `本編 ${r5.talkSec.toFixed(1)}秒（元 ${q5.duration.toFixed(1)}秒）` : ev5.stderr.slice(-200));
      fs.rmSync(v5, { force: true });
    }
  }
}

// 音合わせの拍手の判定（src/clap.js の syncClap・2026-10-23・個人開発回）: 最大の音の半分に届かなくても、ほかの拍手らしい音より
// ずっと大きく、普段の音よりはっきり大きければ拍手とみなす。似た音が続く物（キーボード）・話の間の小さなクリックは拾わない
console.log('\n[拍手の判定]');
{
  const { syncClap } = require('../src/clap');
  // 拍手らしい音の1位・2位（無ければ 0）・一番大きい音・普段の音（山の上位 1%）の大きさ
  const c = (s, second, loudest, usual) => ({
    clapLike: [{ t: 6, peak: s }, ...(second ? [{ t: 40, peak: second }] : [])], top: [{ t: 56, peak: loudest }], usual,
  });
  check('最大の音の半分以上の拍手らしい音は、これまでどおり拍手', Boolean(syncClap(c(0.6, 0.5, 1, 0.5))));
  check('半分に届かなくても、ほかの拍手らしい音の 5倍以上・普段の音の 2倍以上なら拍手（個人開発回の3本目: 0.40倍・19倍・2.68倍）',
    Boolean(syncClap(c(0.2765, 0.0144, 0.6844, 0.1032))));
  check('似た音が続く（キーボード）なら、半分に届かない音は拍手にしない', !syncClap(c(0.3, 0.2, 0.7, 0.1)));
  check('普段の音と変わらない小さな音（拍手を切った録音の、話の間のクリック: 0.26倍・普段の音の 0.95倍）は拍手にしない',
    !syncClap(c(0.1868, 0, 0.7157, 0.1966)));
  check('最大の音の 4分の1 に届かない音は拍手にしない', !syncClap(c(0.15, 0, 1, 0.05)));
}

// 11) 話し声の大きさの測り方: 話す時間の長さに左右されず、声の大きさの差は差として出るか
console.log('\n[声の大きさ]');
{
  const { speechDb } = require('../ui/analyze-project');
  const RATE = 8000;
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  // 0.5秒ごとに「話す／黙る」を切り替えた1分の音（talk = 話している割合）
  const make = (amp, talk) => {
    const x = new Float32Array(RATE * 60);
    for (let i = 0; i < x.length; i++) {
      const speaking = Math.floor(i / (RATE / 2)) % 10 < talk * 10;
      x[i] = speaking ? amp * Math.sin((2 * Math.PI * 220 * i) / RATE) : 0.0005 * (rnd() * 2 - 1);
    }
    return x;
  };
  const a = speechDb(make(0.3, 0.1)), b = speechDb(make(0.3, 0.5)), c = speechDb(make(0.3, 1)), d = speechDb(make(0.15, 0.1));
  check('話す時間が短くても小さく出ない', Math.abs(a - b) < 1, `1割 ${a.toFixed(1)}dB / 5割 ${b.toFixed(1)}dB`);
  check('ずっと話していても測れる', c !== null && Math.abs(a - c) < 1, `ずっと ${c === null ? '測れない' : c.toFixed(1) + 'dB'}`);
  check('声が半分の大きさなら約6dB小さく出る', Math.abs(a - d - 6.02) < 1, `${a.toFixed(1)}dB と ${d.toFixed(1)}dB`);
}

// 音量の線の式（書き出しで BGM・CM に掛ける ffmpeg の式）と、録音の時間 → 書き出しの時間（2026-10-18）
console.log('\n[音量の線の式]');
{
  const { lineExpr, rawToOut } = require('../ui/export');
  // 切る所 [10, 12]・[20, 25]、元の長さ 100秒（書き出しの本編 93秒）
  const got = [5, 11, 15, 22, 30, 100, 101.5].map(t => +rawToOut([[10, 12], [20, 25]], 100, 93, t).toFixed(6));
  check('録音の時間 → 書き出しの時間（切った分を引く・切る所の中は継ぎ目・本編の後ろはそのままずらす）',
    JSON.stringify(got) === JSON.stringify([5, 10, 13, 18, 23, 93, 94.5]), got.join(' / '));
  // 1kHz の音 6秒に、点 1秒 ±0dB → 3秒 −12dB → 4秒 −12dB → 5秒 無音 の式を掛ける
  const wav = path.join(__dirname, 'fixtures', '_line-expr.wav');
  const expr = lineExpr([{ t: 1, db: 0 }, { t: 3, db: -12 }, { t: 4, db: -12 }, { t: 5, db: -24 }], 't');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=6',
    '-af', `asetnsamples=n=256,volume='${expr}':eval=frame`, '-c:a', 'pcm_f32le', wav], { encoding: 'utf8' });
  if (r.status !== 0) check('音量の線の式を ffmpeg が読める', false, r.stderr.slice(-300));
  else {
    const at = s => rmsDb(wav, s - 0.05, 0.1);
    const base = at(0.5), mid = at(2) - base, flat = at(3.5) - base, down = at(4.5) - base, silent = at(5.6);
    check('音量の線の式（点と点の間は dB でまっすぐ・無音へは倍率でまっすぐ・最後の点の後はその大きさ）',
      Math.abs(mid + 6) < 0.3 && Math.abs(flat + 12) < 0.2 && Math.abs(down + 18.06) < 0.6 && silent < -80,
      `2秒 ${mid.toFixed(2)}dB・3.5秒 ${flat.toFixed(2)}dB・4.5秒 ${down.toFixed(2)}dB・5.6秒 ${silent.toFixed(1)}dB`);
  }
  fs.rmSync(wav, { force: true });
}

// 9) 無関係な音源は同期を拒否するか
console.log('\n[対照実験]');
{
  const dir = path.join(__dirname, 'fixtures', 'remote');
  const junk = path.join(dir, '_junk.wav');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'anoisesrc=d=600:c=white:a=0.4:r=44100', '-ac', '1', junk], { encoding: 'utf8' });
  const r = run('sync.js', [path.join(dir, 'M1.wav'), junk]);
  const out = r.status === 0 ? JSON.parse(r.stdout) : null;
  check('無関係な音源は採用しない', Boolean(out && out.results[1].offsetSeconds === null),
    out ? `判定 ${out.results[1].recordingType || '不採用'}` : '実行失敗');
}

console.log(failed === 0 ? '\n全て通りました' : `\n${failed}件 失敗しました`);
process.exit(failed === 0 ? 0 : 1);
