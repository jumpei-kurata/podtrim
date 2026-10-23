#!/usr/bin/env node
// 頭出しオフセットを独立した2系統の根拠で決める。
//
//   候補の出所A: 手拍子(高域の急峻な立ち上がり)の位置        … 別々の場所で録っていても効く
//   候補の出所B: 全域の相互相関(FFT)のピーク                  … 同室でマイクかぶりがあれば効く
//   採点:        候補ごとに正規化相互相関を実測して比べる
//
// 重要: 「2手法が一致したら採用」だけでは不十分だった。正解が候補に1つも無いと、
// 弱い相関同士で一致してしまい誤った値を自信満々に返す（実測: 相関0.21同士で一致し-1.234sを9.75sと誤答）。
// そのため (1)候補は両系統から集める (2)勝者の相関が絶対値で高いことを必須にする。
//
// 3人の実音源で分かったこと（2026-10-17・ピープルウェアー回）:
//   - 会話の譲り合い（2本の包絡の逆相関）は3人だと打ち消される。3人目が喋る間は残りの2人が
//     そろって黙る＝正の相関になるため。実測: 正解の位置でも -0.02 / +0.08（2人の回は +0.30）
//   - 手拍子まわりの波形照合は、別々の手の拍手でも偶然 0.65 まで一致した（正解の位置は 0.52）
//     → 同室と判定され -47秒という誤った値で確定した
//   一方で手拍子そのものは3本とも、1位の高域ピークが2位の2倍以上ではっきり立っていた。
//   そこで「基準と相手の両方で音合わせの拍手がはっきりしていれば、その時刻の差を最優先で使う」。
//   人が GarageBand で手拍子の波形を見て揃えるのと同じやり方で、倉田さんの手編集の揃え方と
//   1ms 以内で一致した（-2.664 / -2.331 に対し -2.665 / -2.33）。他の判定はその次に回す。
//   拍手は大きさだけでなく形でも見分ける（src/clap.js の clapCandidates の説明・守りのトークン抑え回）。

const path = require('path');
const {
  CLAP_RATE, WINDOW, HPF, TOP_N, CLAP_QUIET_DB, CLAP_DECAY_DB, CLAP_MIN_REL, CLAP_ALONE, CLAP_MIN_REL_ALONE, CLAP_OVER_USUAL, CLAP_DOMINANCE,
  pcm, clapPcm: readClap, clapCandidates, syncClap, clapDominance, dominanceOut, describeClap,
} = require('./clap');

const CORR_RATE = Number(process.env.CORR_RATE || 4000);
const CORR_WINDOW = Number(process.env.CORR_WINDOW || 600); // 相関に使う秒数
const MAX_OFFSET = Number(process.env.MAX_OFFSET || 90); // 想定される最大ズレ(秒)
const MIN_CORR = Number(process.env.MIN_CORR || 0.5); // 勝者に要求する相関の絶対値
// 手拍子まわりを照合する窓の半幅(秒)。拍手は20ms程度なので広げすぎると周囲の話し声で薄まる。
const LOCAL_HALF = Number(process.env.LOCAL_HALF || 0.04);
// 候補の周辺を何秒ぶん探索するか。手拍子検出の分解能(5ms)より十分広く取る
const LOCAL_SEARCH = Number(process.env.LOCAL_SEARCH || 0.05);
const AGREE_TOL = Number(process.env.AGREE_TOL || 0.05); // 2系統が一致とみなす誤差(秒)
// リモート判定用: 会話の逆相関(譲り合い)がこれ以上なら「だいたい揃っている」とみなす
const MIN_TURN = Number(process.env.MIN_TURN || 0.15);
// 包絡の平滑化幅(秒)。会話のターン構造を見るための値（実音源で校正）
const ENV_SMOOTH = Number(process.env.ENV_SMOOTH || 0.2);
// その中で1位の拍手が2位より何倍鋭ければ確定とみなすか
const ATTACK_MARGIN = Number(process.env.ATTACK_MARGIN || 1.5);
// 同室の「同じ1回の拍手」とみなす波形一致の下限。
// 合成の同室音源の本物は 0.85 以上、実音源の別々の拍手の偶然の一致は 0.65 だった
const MIN_LOCAL = Number(process.env.MIN_LOCAL || 0.8);

// ---------- 包絡とFFT ----------
// 平滑化の幅は「会話のターン（数秒）」を見たいので 20ms では細かすぎる。
// 実音源で測ると、譲り合いの逆相関は 20ms で -0.18、0.2s で -0.28 と明確に強くなる。
// さらに鈍らせると信号は強まる（1s で -0.48、2s で -0.55）が、最小点が正解から
// 0.2秒ずれていくので位置決めが甘くなる。0.2s が強さと位置精度の折り合いが良い。
function envelope(x, rate) {
  const win = Math.max(1, Math.round(rate * ENV_SMOOTH));
  const out = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= win) acc -= x[i - win] * x[i - win];
    // clamp しないと桁落ちで負に振れ sqrt が NaN になり、相関全体が静かに壊れる
    out[i] = Math.sqrt(Math.max(0, acc) / Math.min(i + 1, win));
  }
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// ---------- 候補の出所B: 相互相関のピーク上位 ----------
function corrCandidates(a, b) {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const rr = ar[i] * br[i] + ai[i] * bi[i];
    const ii = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = rr;
    ai[i] = ii;
  }
  fft(ar, ai, true);

  const maxLag = Math.min(Math.round(MAX_OFFSET * CORR_RATE), n >> 1);
  const vals = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = ar[lag >= 0 ? lag : n + lag];
    if (!Number.isFinite(v)) throw new Error('相関値が NaN になりました。入力音声を確認してください。');
    vals.push({ lag, v });
  }
  vals.sort((x, y) => y.v - x.v);
  const picked = [];
  for (const c of vals) {
    const t = -c.lag / CORR_RATE;
    if (picked.some(p => Math.abs(p.t - t) < 0.3)) continue;
    picked.push({ t });
    if (picked.length >= TOP_N) break;
  }
  return picked;
}

// 候補位置の「まわりだけ」を生波形で照合する（-1〜1）。
// 全編の包絡相関は、各自の声が支配的だと弱くなって使い物にならない（実測0.03）。
// 一方これは「その一瞬が同じ音か」を直接見るので、共通の手拍子があれば1.0近くになる。
// 3人が同室 or 互いの音を拾っている前提の検証。完全別室なら各自の拍手は別物なので低く出る。
// 重要: 拍手は広帯域なので1サンプルずれただけで相関が消える。候補のズレ量をそのまま
// 試すだけでは、検出の分解能(5ms=80サンプル)の誤差でスコアが0付近に落ちる。
// そこで候補の周辺を1サンプル刻みで探索してピークを取る。副産物としてズレ量が
// サンプル精度まで精緻化される。
function localCorrSearch(a, b, centerA, offsetSeconds, rate, halfWidth, searchSec) {
  const w = Math.round(halfWidth * rate);
  const ia = Math.round(centerA * rate);
  const ib0 = Math.round((centerA - offsetSeconds) * rate);
  const search = Math.round(searchSec * rate);

  // 基準側の窓は固定なので分母を先に計算しておく
  let da = 0;
  for (let k = -w; k <= w; k++) {
    const pa = ia + k;
    if (pa < 0 || pa >= a.length) continue;
    da += a[pa] * a[pa];
  }
  if (da <= 0) return { corr: 0, refinedOffset: offsetSeconds };

  let best = 0;
  let bestShift = 0;
  for (let s = -search; s <= search; s++) {
    let num = 0;
    let db = 0;
    let count = 0;
    for (let k = -w; k <= w; k++) {
      const pa = ia + k;
      const pb = ib0 + s + k;
      if (pa < 0 || pb < 0 || pa >= a.length || pb >= b.length) continue;
      num += a[pa] * b[pb];
      db += b[pb] * b[pb];
      count++;
    }
    if (count < w || db <= 0) continue;
    const c = num / Math.sqrt(da * db);
    if (c > best) { best = c; bestShift = s; }
  }
  // b 側を bestShift サンプルずらした位置が正解 → その分オフセットを補正する
  return { corr: best, refinedOffset: +(offsetSeconds - bestShift / rate).toFixed(5) };
}

// 指定オフセットでの正規化相互相関（-1〜1）。候補の採点用
function corrAt(a, b, lagSamples) {
  let num = 0;
  let da = 0;
  let db = 0;
  const start = Math.max(0, -lagSamples);
  const end = Math.min(a.length, b.length - lagSamples);
  if (end - start < CORR_RATE) return 0; // 重なりが1秒未満なら評価不能
  for (let i = start; i < end; i++) {
    const va = a[i];
    const vb = b[i + lagSamples];
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error('usage: node sync.js <reference> <track2> [track3...]');
  process.exit(1);
}

const clapPcm = files.map(readClap);
const corrEnv = files.map(f => envelope(pcm(f, CORR_WINDOW, CORR_RATE), CORR_RATE));
const claps = clapPcm.map(clapCandidates);

const resolved = {};
files.forEach(f => { resolved[path.basename(f)] = path.resolve(f); });

// 基準の拍手: 音合わせの拍手が見つかればそれ、無ければ従来どおり高域が最大の音
const refSync = syncClap(claps[0]);
const refClap = refSync || claps[0].top[0];
const refDominance = clapDominance(claps[0]);
const results = [
  {
    file: path.basename(files[0]),
    clapAt: refClap ? +refClap.t.toFixed(4) : null,
    // clapAt が音合わせの拍手（拍手らしい形の音）か。false なら高域が最大の音で、拍手とは限らない
    syncClap: Boolean(refSync),
    clapDominance: dominanceOut(refDominance),
    offsetSeconds: 0,
    role: '基準',
  },
];

for (let i = 1; i < files.length; i++) {
  // 両系統から候補を集める。片方が失敗しても正解が候補に残るようにするため
  // 手拍子の候補は、音合わせの拍手（見つかれば先頭）＋高域の大きさの上位
  const tgtSync = syncClap(claps[i]);
  const clapList = tgtSync
    ? [tgtSync, ...claps[i].top.filter(c => Math.abs(c.t - tgtSync.t) >= 0.3)]
    : claps[i].top;
  const fromClap = refClap
    ? clapList.map(c => ({
        offsetSeconds: +(refClap.t - c.t).toFixed(4),
        source: 'clap',
        clapAt: +c.t.toFixed(4),
        peak: +c.peak.toFixed(4), // 高域ピークの大きさ
        attack: +c.attack.toFixed(2), // 立ち上がりの鋭さ。リモート時の絞り込みに使う
        quietDb: +c.quietDb.toFixed(1), // 直前の静かさ（拍手らしさ）
        decayDb: +c.decayDb.toFixed(1), // 余韻の短さ（拍手らしさ）
        ...(refSync && c === tgtSync ? { syncPair: true } : {}), // 基準と相手の音合わせの拍手どうしの組
      }))
    : [];
  const fromCorr = corrCandidates(corrEnv[0], corrEnv[i]).map(c => ({
    offsetSeconds: +c.t.toFixed(4),
    source: 'corr',
  }));

  // 重複を除いてまとめ、全候補を同じ物差し(正規化相関)で採点する
  const merged = [];
  for (const c of [...fromClap, ...fromCorr]) {
    const hit = merged.find(m => Math.abs(m.offsetSeconds - c.offsetSeconds) <= AGREE_TOL);
    if (hit) {
      if (!hit.source.includes(c.source)) hit.source += '+' + c.source;
      continue;
    }
    merged.push({ ...c });
  }
  // 各候補を3つの独立した物差しで採点する。録音形態によって効く物差しが違うため。
  //   localCorr  : その一瞬が同じ音か        … 同室録音（共通の1回の拍手が3本に入る）で高い
  //   globalCorr : 全編で同じ部屋の音を拾うか … 同室録音で高い
  //   turnTaking : 発話が譲り合っているか     … リモート録音（他人の声が入らない）で効く
  //
  // リモートでは前2つが原理的に効かない。各自が自分の手を叩くので波形は別物だし、
  // 他人の声も部屋の音も入らないので相関も出ない。
  // 代わりに「3人は基本1人ずつ喋る」という会話の性質を使う。正しく揃った位置では
  // A が喋る間 B は黙る＝包絡が逆相関になり、ズレていればランダムに重なって相関0付近になる。
  for (const m of merged) {
    if (refClap) {
      // 候補の周辺 ±LOCAL_SEARCH 秒を探索。ヒットすればズレ量がサンプル精度に精緻化される
      const r = localCorrSearch(clapPcm[0], clapPcm[i], refClap.t, m.offsetSeconds, CLAP_RATE, LOCAL_HALF, LOCAL_SEARCH);
      m.localCorr = +r.corr.toFixed(4);
      m.refinedOffset = r.refinedOffset;
    } else {
      m.localCorr = 0;
      m.refinedOffset = m.offsetSeconds;
    }
    m.globalCorr = +corrAt(corrEnv[0], corrEnv[i], Math.round(-m.offsetSeconds * CORR_RATE)).toFixed(4);
    m.turnTaking = +(-m.globalCorr).toFixed(4);
    m.sameRoomScore = Math.max(m.localCorr, m.globalCorr);
  }

  // --- 判定0: 手拍子がはっきりしているか（最優先） ---
  // 基準と相手の両方で、拍手らしい形の音がほかより十分大きければ、その2つが音合わせの拍手。
  // 録音形態も会話の人数も関係なく効く。
  const trackDominance = clapDominance(claps[i]);
  const pair = merged.find(m => m.syncPair);
  const clapClear = Boolean(pair && refDominance >= CLAP_DOMINANCE && trackDominance >= CLAP_DOMINANCE);

  // --- 判定1: 同室録音として決まるか ---
  // 波形一致は窓が80msと短く偶然の一致が起きるので、MIN_LOCAL 以上の時だけ根拠にする
  const sameRoomSorted = [...merged].sort((a, b) => b.sameRoomScore - a.sameRoomScore);
  const srBest = sameRoomSorted[0];
  const srUp = sameRoomSorted[1];
  const srStrong = Boolean(srBest && (srBest.localCorr >= MIN_LOCAL || srBest.globalCorr >= MIN_CORR));
  const sameRoomOk = srStrong && (!srUp || srBest.sameRoomScore - srUp.sameRoomScore >= 0.1);

  // --- 判定2: リモート録音として決まるか ---
  // 逆相関が十分強い候補だけに絞り、その中で最も拍手の立ち上がりが鋭いものを採る。
  // 逆相関の谷は1〜2秒と幅広く単独では位置を決められないが、秒単位で離れた偽の候補は確実に落とせる。
  // 一方 拍手の鋭さは位置をms精度で決められるが、どれが拍手かの確信が持てない。両者は補完的。
  const turnCands = merged.filter(m => m.turnTaking >= MIN_TURN && m.attack !== undefined);
  turnCands.sort((a, b) => b.attack - a.attack);
  const tBest = turnCands[0];
  const tUp = turnCands[1];
  const remoteOk = Boolean(tBest && (!tUp || tBest.attack >= tUp.attack * ATTACK_MARGIN));

  let basis;
  let chosen;
  let recordingType;
  if (clapClear) {
    // 同じ1回の拍手（同室）なら波形まで一致するので、サンプル単位に詰めた値を使う。
    // 別々の手の拍手（リモート）は波形が別物なので、検出した拍手の時刻の差そのものを採る
    const shared = pair.localCorr >= MIN_LOCAL;
    recordingType = shared ? '同室' : 'リモート';
    basis = shared ? 'はっきりした手拍子＋波形一致（同室録音）' : 'はっきりした手拍子の時刻（リモート録音）';
    chosen = shared ? pair.refinedOffset : pair.offsetSeconds;
  } else if (sameRoomOk) {
    const byLocal = srBest.localCorr >= srBest.globalCorr;
    recordingType = '同室';
    basis = byLocal ? '手拍子の波形一致（同室録音）' : '全編の相関（同室録音）';
    chosen = byLocal ? srBest.refinedOffset : srBest.offsetSeconds;
  } else if (remoteOk) {
    recordingType = 'リモート';
    basis = '手拍子の位置＋会話の譲り合い（リモート録音）';
    // リモートでは波形照合が効かないので精緻化は使わず、検出した拍手位置そのものを採る
    chosen = tBest.offsetSeconds;
  }
  const accept = clapClear || sameRoomOk || remoteOk;
  const strong = Boolean(tBest);

  results.push({
    file: path.basename(files[i]),
    offsetSeconds: accept ? chosen : null,
    accepted: accept,
    recordingType: accept ? recordingType : null,
    basis: accept ? basis : null,
    // 基準と、このトラックの両方で手拍子がはっきりしていて、その手拍子で揃えたか（判定0）。
    // 回を作る時、これが1つでもあれば手拍子より前を切る（ui/prep.js）
    clapClear,
    clapDominance: dominanceOut(trackDominance),
    sameRoomScore: srBest ? srBest.sameRoomScore : null,
    turnTakingScore: tBest ? tBest.turnTaking : null,
    candidates: merged,
    note: accept
      ? `${basis}で確定。`
      : !strong
        ? `どの候補も根拠が弱く信頼できません（手拍子 基準 ${describeClap(refDominance)}・このトラック ${describeClap(trackDominance)}` +
          ` / 同室の一致度 最良 ${srBest ? srBest.sameRoomScore.toFixed(3) : 'なし'} / 譲り合いの根拠を満たす候補なし）。` +
          `手拍子が録れていない、または会話の譲り合いが読み取れない可能性があります。候補から人間が選ぶか、オフセットを直接指定してください。`
        : '譲り合いの条件は満たす候補が複数あり、手拍子の鋭さでも決め手に欠けます。候補から人間が選んでください。',
  });
}

console.log(
  JSON.stringify(
    {
      params: {
        WINDOW, CORR_WINDOW, HPF, CLAP_QUIET_DB, CLAP_DECAY_DB, CLAP_MIN_REL, CLAP_ALONE, CLAP_MIN_REL_ALONE, CLAP_OVER_USUAL, CLAP_DOMINANCE,
        MIN_LOCAL, MIN_CORR, MIN_TURN, ATTACK_MARGIN, MAX_OFFSET,
      },
      resolved,
      results,
    },
    null,
    2
  )
);
