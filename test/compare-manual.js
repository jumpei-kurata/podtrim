#!/usr/bin/env node
// 人間の編集（完成版から逆算した対応表）と、自動編集のカットリストを突き合わせる。
//
//   node test/compare-manual.js <manual-map.json> <cuts.json>
//
// 見たいこと:
//  - 全体としてどれだけ削り方が違うか（自動は控えめか、削りすぎか）
//  - 場所によって差が出るか（前半だけ甘い、等の偏りがないか）

const fs = require('fs');

const map = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

// 自動編集が「生音源の t 秒までに何秒削ったか」
function autoRemovedBy(t) {
  let acc = 0;
  for (const [s, e] of plan.cuts) {
    if (e <= t) acc += e - s;
    else if (s < t) acc += t - s;
    else break;
  }
  return acc;
}

const rows = map.rows.filter(r => r.matched);
const out = [];
for (const r of rows) {
  const manual = r.removedSoFar; // 生音源のその位置までに人間が削った合計
  const auto = autoRemovedBy(r.rawAt);
  out.push({
    rawAt: r.rawAt,
    manualRemoved: +manual.toFixed(1),
    autoRemoved: +auto.toFixed(1),
    gap: +(manual - auto).toFixed(1),
    autoRatio: manual > 0 ? +(auto / manual).toFixed(2) : null,
  });
}

// 区間ごとの削り方（前後の差分）
const per = [];
for (let i = 1; i < out.length; i++) {
  const spanRaw = out[i].rawAt - out[i - 1].rawAt;
  const m = out[i].manualRemoved - out[i - 1].manualRemoved;
  const a = out[i].autoRemoved - out[i - 1].autoRemoved;
  per.push({
    from: out[i - 1].rawAt,
    to: out[i].rawAt,
    spanSec: +spanRaw.toFixed(1),
    manual: +m.toFixed(1),
    auto: +a.toFixed(1),
    manualPct: +((m / spanRaw) * 100).toFixed(1),
    autoPct: +((a / spanRaw) * 100).toFixed(1),
  });
}

const last = out[out.length - 1];
const totalManual = last.manualRemoved;
const totalAuto = last.autoRemoved;

// 自動が人間より多く削った区間 = 削りすぎの疑い
const overCut = per.filter(p => p.auto > p.manual + 2);

console.log(
  JSON.stringify(
    {
      サマリ: {
        測定範囲: `生音源 0〜${last.rawAt}秒`,
        人間が削った合計: totalManual,
        自動が削った合計: totalAuto,
        自動は人間の何割: +(totalAuto / totalManual).toFixed(2),
        不足分: +(totalManual - totalAuto).toFixed(1),
      },
      削りすぎの疑いがある区間: overCut,
      区間別: per,
    },
    null,
    2
  )
);
