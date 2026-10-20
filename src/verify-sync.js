#!/usr/bin/env node
// カット後も3本（ゲストを呼んだ回は4〜5本。何本でも同じ）が揃っているかを、仮定に頼らず直接確かめる。
//
// 判定は2本立て:
//   A) 長さ検査 … 3本のサンプル数が完全一致するか（同一カットなら構造的にそうなるはず）
//   B) 内容照合 … 出力の各所をランダムに抜き、カットリストから逆算した「元ファイルの該当位置」の
//                 波形と一致するかを実データで突き合わせる。全トラックで同じ写像が成立していれば、
//                 残した音が正しい順で入っており、かつ3本の相対位置も保たれている。
//
// 採らなかった検証方法とその理由:
//  - 「元の無音境界が予測位置に来たか」→ カットに隣接する境界は統合・消滅して対応物が無くなり、
//    最近傍で突き合わせると誤警報が出る（実測: 656件中615件は誤差1ms以内なのに35件の偽陽性）。
//  - 「出力どうしの相互相関が0か」→ 話者ごとに中身が違うトラックでは相関が元々ほぼ0で、
//    ピーク位置が無意味になる（実測: 相関-0.04で探索範囲の端に張り付いた）。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// apply.js が書き出したのと同じレートで照合する（ここを下げると位相がずれて一致しなくなる）
const NATIVE_RATE = Number(process.env.OUT_RATE || 44100);

const planPath = process.argv[2];
const outDir = process.argv[3];
if (!planPath || !outDir) {
  console.error('usage: node verify-sync.js <cuts.json> <outDir>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const outs = plan.files.map(f => path.join(outDir, path.basename(f, path.extname(f)) + '_cut.wav'));

function samples(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration_ts', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  return Number(r.stdout.trim());
}

// 照合はカット時と同じサンプルレートで行う。ダウンサンプルして比べると、リサンプラの
// 位相がファイル内の絶対位置に依存するため、中身が同一でも波形が一致しなくなる
// （実測: 4kHzに落として比較したら13箇所中4箇所しか一致しなかった）。
function pcmRange(file, startSec, lenSec) {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', String(startSec), '-t', String(lenSec),
     '-i', file, '-ac', '1', '-ar', String(NATIVE_RATE), '-f', 'f32le', '-'],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${r.stderr}`);
  const n = r.stdout.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r.stdout.readFloatLE(i * 4);
  return out;
}

// A) 長さ検査
const counts = outs.map(samples);
const lengthOk = new Set(counts).size === 1;

// カットリストから「残した区間」を再構成し、出力位置 → 元ファイル位置 の写像を作る
const keep = [];
{
  let cursor = 0;
  for (const [s, e] of plan.cuts) {
    if (s > cursor) keep.push([cursor, s]);
    cursor = e;
  }
  if (cursor < plan.total) keep.push([cursor, plan.total]);
}
// 重要: apply.js と同じ整数サンプル演算で位置を出す。
// 秒のまま累積すると、境界ごとの丸め差が積み上がって数十サンプルずれ、
// 中身は正しいのに相関0.75程度に落ちて「不一致」と誤判定する（実測でそうなった）。
const map = []; // {outStart, outEnd, srcStart} すべて秒だがサンプル起点で算出
{
  let accSamples = 0;
  for (const [s, e] of keep) {
    const ss = Math.round(s * NATIVE_RATE);
    const es = Math.round(e * NATIVE_RATE);
    map.push({
      outStart: accSamples / NATIVE_RATE,
      outEnd: (accSamples + (es - ss)) / NATIVE_RATE,
      srcStart: ss / NATIVE_RATE,
    });
    accSamples += es - ss;
  }
}

// B) 内容照合: 出力の各所を抜き、元ファイルの該当位置と波形が一致するか実データで確認
const FADE_GUARD = 0.05; // 継ぎ目のフェード領域は値が変わるので避ける
const PROBE_LEN = 0.05; // 1回あたり照合する長さ(秒)
const SEEK_SLACK = 4; // ffmpeg -ss の丸めを吸収するために許容するサンプル数
const contentChecks = [];
plan.files.forEach((srcFile, ti) => {
  const outFile = outs[ti];
  let checked = 0;
  let matched = 0;
  const details = [];

  // 長めの残存区間を選び、その中央付近を照合する（決定論的に等間隔で選ぶ）。話す量の少ない人（ゲストを呼んだ5人の回など）は、
  // 等間隔の所がみな黙っている所（無音＝照合できない）のことがあるので、確かめられた所が3か所に届くまで、残りの区間も順に試す
  // （2026-10-19・5人の合成音源で1人だけ照合0か所になり、ずれていないのに不合格になった）
  const usable = map.filter(m => m.outEnd - m.outStart > FADE_GUARD * 2 + PROBE_LEN);
  const step = Math.max(1, Math.floor(usable.length / 12));
  const spaced = usable.map((_, k) => k).filter(k => k % step === 0);
  const order = [...spaced, ...usable.map((_, k) => k).filter(k => k % step !== 0)];
  for (const k of order) {
    if (k % step !== 0 && checked >= 3) break;
    const m = usable[k];
    const offsetIntoSeg = (m.outEnd - m.outStart) / 2;
    const outAt = m.outStart + offsetIntoSeg;
    const srcAt = m.srcStart + offsetIntoSeg;

    const out = pcmRange(outFile, outAt, PROBE_LEN);
    // ffmpeg -ss は秒指定を内部でサンプルに丸めるため、抜き出し位置が±1サンプル揺れる。
    // 広帯域音は1サンプルずれるだけで相関が0.85程度まで落ちるので、
    // 元ファイル側は少し広めに取り、数サンプルの範囲で最良一致を探す。
    // （本当に位置がずれていれば数百サンプル以上ずれるので、この許容で見逃すことはない）
    const src = pcmRange(srcFile, srcAt - SEEK_SLACK / NATIVE_RATE, PROBE_LEN + (SEEK_SLACK * 2) / NATIVE_RATE);
    const n = out.length;
    if (n < NATIVE_RATE * PROBE_LEN * 0.5) continue;

    let bestCorr = -2;
    let bestShift = null;
    for (let s = -SEEK_SLACK; s <= SEEK_SLACK; s++) {
      let num = 0;
      let da = 0;
      let db = 0;
      let ok = true;
      for (let j = 0; j < n; j++) {
        const k = SEEK_SLACK + s + j;
        if (k < 0 || k >= src.length) { ok = false; break; }
        num += out[j] * src[k];
        da += out[j] * out[j];
        db += src[k] * src[k];
      }
      if (!ok || da <= 1e-12 || db <= 1e-12) continue; // 無音区間は相関が定義できない
      const c = num / Math.sqrt(da * db);
      if (c > bestCorr) { bestCorr = c; bestShift = s; }
    }
    if (bestShift === null) continue; // 照合できる中身が無かった（無音等）
    checked++;
    if (bestCorr > 0.99) matched++;
    else details.push({ outSeconds: +outAt.toFixed(3), srcSeconds: +srcAt.toFixed(3), corr: +bestCorr.toFixed(4), shiftSamples: bestShift });
  }
  contentChecks.push({
    track: path.basename(outFile),
    checked,
    matched,
    ok: checked > 0 && matched === checked,
    mismatches: details.slice(0, 5),
  });
});
const contentOk = contentChecks.every(c => c.ok);

const verdict = lengthOk && contentOk;
console.log(
  JSON.stringify(
    {
      lengthCheck: { ok: lengthOk, sampleCounts: counts },
      contentCheck: { ok: contentOk, tracks: contentChecks },
      syncPreserved: verdict,
      note: verdict
        ? `${outs.length}本の長さが完全一致し、残した音も全トラックで元ファイルの正しい位置と一致しました。同期は保たれています。`
        : '同期が壊れている可能性があります。成果物として使わないでください。',
    },
    null,
    2
  )
);
process.exit(verdict ? 0 : 1);
