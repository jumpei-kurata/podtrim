#!/usr/bin/env node
// 「削りすぎを起こさずに、どこまで削れるか」を探索する。
//
//   node test/tune.js <manual-map.json> <aligned/*.wav ...>
//
// 手編集との比較で分かったこと:
//  - 合計を人間に合わせにいくと、場所が合わずに自然な間を潰す
//  - なので「削りすぎた区間の数」を制約にして、その中で削除量を最大化するのが正しい
// パラメータを総当たりして、制約を満たす中で一番よく削る設定を見つける。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mapPath = process.argv[2];
const files = process.argv.slice(3);
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const rows = map.rows.filter(r => r.matched);

// 1区間あたり何秒までの超過を許すか（これを超えたら「削りすぎ」とみなす）
const TOLERANCE = Number(process.env.TOLERANCE || 1.0);

function analyze(env) {
  const r = spawnSync('node', [path.join(ROOT, 'src', 'analyze.js'), ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

function evaluate(plan) {
  const removedBy = t => {
    let acc = 0;
    for (const [s, e] of plan.cuts) {
      if (e <= t) acc += e - s;
      else if (s < t) acc += t - s;
      else break;
    }
    return acc;
  };
  let over = 0;
  let worstOver = 0;
  for (let i = 1; i < rows.length; i++) {
    const m = rows[i].removedSoFar - rows[i - 1].removedSoFar;
    const a = removedBy(rows[i].rawAt) - removedBy(rows[i - 1].rawAt);
    const diff = a - m;
    if (diff > TOLERANCE) { over++; if (diff > worstOver) worstOver = diff; }
  }
  const manualTotal = rows[rows.length - 1].removedSoFar;
  const autoTotal = removedBy(rows[rows.length - 1].rawAt);
  return {
    removed: +plan.removedSeconds.toFixed(1),
    cuts: plan.cuts.length,
    coverage: +((autoTotal / manualTotal) * 100).toFixed(0),
    overSegments: over,
    worstOver: +worstOver.toFixed(1),
  };
}

const results = [];
for (const NOISE_DB of ['-30dB', '-35dB']) {
  for (const MIN_SIL of [0.4, 0.5, 0.6]) {
    for (const PAD of [0.1, 0.15, 0.2]) {
      for (const MIN_CUT of [0.6, 0.8, 1.0, 1.2]) {
        const env = { NOISE_DB, MIN_SIL: String(MIN_SIL), PAD: String(PAD), MIN_CUT: String(MIN_CUT) };
        const ev = evaluate(analyze(env));
        results.push({ NOISE_DB, MIN_SIL, PAD, MIN_CUT, ...ev });
        process.stderr.write('.');
      }
    }
  }
}
process.stderr.write('\n');

// 削りすぎゼロの中で、一番よく削るもの
const safe = results.filter(r => r.overSegments === 0).sort((a, b) => b.coverage - a.coverage);
// 削りすぎ1区間まで許す場合
const nearSafe = results.filter(r => r.overSegments <= 1).sort((a, b) => b.coverage - a.coverage);

console.log(
  JSON.stringify(
    {
      tolerance: TOLERANCE,
      bestSafe: safe.slice(0, 5),
      bestNearSafe: nearSafe.slice(0, 5),
      all: results.sort((a, b) => b.coverage - a.coverage),
    },
    null,
    2
  )
);
