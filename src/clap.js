// 音合わせの手拍子を見つける。頭揃え（src/sync.js）と、手で頭を揃える窓（ui/serve.js の /align）が使う。
//
// 拍手は大きさだけでなく形でも見分ける（clapCandidates の説明・守りのトークン抑え回）。

const { spawnSync } = require('child_process');

const CLAP_RATE = Number(process.env.CLAP_RATE || 16000);
const WINDOW = Number(process.env.WINDOW || 90); // 手拍子を探す冒頭の秒数
const HPF = Number(process.env.HPF || 2000);
const TOP_N = Number(process.env.TOP_N || 5); // 各系統から取る候補数
// 拍手らしい形の条件（実音源8本・3回分で校正。clapCandidates の説明を参照）
const CLAP_QUIET_DB = Number(process.env.CLAP_QUIET_DB || -40); // 直前 200〜10ms がこれ以下に静か
const CLAP_DECAY_DB = Number(process.env.CLAP_DECAY_DB || -20); // 30〜200ms 後にこれ以下まで消える
// 拍手らしい形でも、そのトラックの最大の音の半分に届かない小さな音（キーボード等）は音合わせとみなさない
const CLAP_MIN_REL = Number(process.env.CLAP_MIN_REL || 0.5);
// ただし、ほかに拍手らしい音が無いほど際立っていて（1位が2位の CLAP_ALONE 倍以上）、冒頭の普段の音（5ms ごとの高い音の山の
// 上位 1%）の CLAP_OVER_USUAL 倍以上あれば、最大の音の CLAP_MIN_REL_ALONE 倍までは音合わせの拍手とみなす（2026-10-23・個人開発回の
// 3本目: 6.19秒の拍手が、拍手でない最大の音〈56.6秒〉の 0.40 倍しかなく落ちていた。2位の拍手らしい音の 19 倍・普段の音の 2.68 倍）。
// 過去の録音 144本で測ると、音合わせの拍手は普段の音の 2.23 倍以上（107本）。拍手を切った後の録音で唯一の「拍手らしい音」になった
// 話の間のクリック音は 0.95 倍、ほかの拍手でない音も 1.3 倍以下だった。キーボードの打鍵のように似た音が続く物は2位が近いので拾わない
const CLAP_ALONE = Number(process.env.CLAP_ALONE || 5);
const CLAP_MIN_REL_ALONE = Number(process.env.CLAP_MIN_REL_ALONE || 0.25);
const CLAP_OVER_USUAL = Number(process.env.CLAP_OVER_USUAL || 2);
// 手拍子が「はっきりしている」とみなす倍率（拍手らしい音の1位が2位の何倍以上か）。
// 2回叩いた・試しに叩いた等で同じくらいの拍手が2つあると、どちらが音合わせか決められないため
const CLAP_DOMINANCE = Number(process.env.CLAP_DOMINANCE || 1.8);

function pcm(file, seconds, rate, extraFilter) {
  const af = extraFilter ? ['-af', extraFilter] : [];
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-t', String(seconds), '-i', file, ...af,
     '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
    { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' }
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${file}\n${res.stderr}`);
  const n = res.stdout.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = res.stdout.readFloatLE(i * 4);
  return out;
}

// 手拍子を探す用の音（冒頭 WINDOW 秒・高い音だけ）
const clapPcm = file => pcm(file, WINDOW, CLAP_RATE, `highpass=f=${HPF}`);

// ---------- 候補の出所A: 手拍子 ----------
// 順位付けは「高域の絶対的な大きさ」で行う。
// 当初は「直前50msに対する急増率」で順位付けしていたが、実音源では外した:
// 無音の直後の小さな物音が比としては巨大になり(比2547倍)、本物の拍手を押しのけてしまう。
// 実音源では拍手は高域のピークが2位の約2倍という圧倒的な絶対値で立っていた（両トラックとも）。
// 音合わせの拍手はマイクのすぐ前で強く叩くものなので、絶対値で見るのが理にかなう。
//
// ただし大きさだけでは足りなかった（2026-10-17・守りのトークン抑え回）。机やマイクに触れた音、
// 話の途中の笑いや物音が、拍手と同じくらい・それ以上の大きさで入ることがある。
// そこで「形」も見る。実音源8本（3回分）で測ると、音合わせの拍手は8本とも
//   直前 200〜10ms が拍手より -56dB 以下に静か（「よーおっ」の「っ」で一瞬黙るため）
//   30〜200ms 後に約 -27dB 以下まで消える（手を打った音は短い）
// 一方、机やマイクに触れた音は余韻が長く（-14dB）、話の途中の音は直前が静かでない（-30dB より上）。
// 上位の候補で両方を満たした拍手以外の音は1つも無かった。
function clapCandidates(x) {
  const win = Math.round(CLAP_RATE * 0.005);
  const nb = Math.floor(x.length / win);
  const peak = new Float64Array(nb);
  const energy = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    let p = 0;
    for (let i = b * win; i < (b + 1) * win; i++) {
      const v = Math.abs(x[i]);
      if (v > p) p = v;
      s += x[i] * x[i];
    }
    peak[b] = p;
    energy[b] = Math.sqrt(s / win);
  }
  // [b0, b1) のブロックの平均の大きさ（RMS）
  const levelOver = (b0, b1) => {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, b0); k < Math.min(nb, b1); k++) { s += energy[k] * energy[k]; n++; }
    return n ? Math.sqrt(s / n) : 0;
  };
  const dB = (v, ref) => 20 * Math.log10((v + 1e-12) / (ref + 1e-12));
  const back = 10; // 直前50ms
  const cand = [];
  for (let b = back; b < nb; b++) {
    let base = 0;
    for (let k = b - back; k < b; k++) base += energy[k];
    base /= back;
    if (peak[b] < 1e-4) continue;
    const level = Math.max(energy[b], b + 1 < nb ? energy[b + 1] : 0);
    const quietDb = dB(levelOver(b - 40, b - 2), level); // 200〜10ms 前
    const decayDb = dB(levelOver(b + 6, b + 40), level); // 30〜200ms 後
    cand.push({
      t: (b * win) / CLAP_RATE,
      peak: peak[b], // 順位付けの主軸
      attack: energy[b] / (base + 1e-9), // 立ち上がりの鋭さ（参考・同点時の手がかり）
      quietDb,
      decayDb,
      clapLike: quietDb <= CLAP_QUIET_DB && decayDb <= CLAP_DECAY_DB,
    });
  }
  cand.sort((a, b) => b.peak - a.peak);
  const pick = (list, limit) => {
    const picked = [];
    for (const c of list) {
      if (picked.some(p => Math.abs(p.t - c.t) < 0.3)) continue;
      picked.push(c);
      if (picked.length >= limit) break;
    }
    return picked;
  };
  const sorted = Array.from(peak).sort((a, b) => a - b);
  return {
    top: pick(cand, TOP_N), // 大きさの上位（判定1・2の候補に使う）
    clapLike: pick(cand.filter(c => c.clapLike), 2), // 拍手らしい形の上位2つ（判定0に使う）
    usual: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0, // 普段の音（山の上位 1%）
  };
}

// 音合わせの拍手: 拍手らしい形の音のうち最大のもの。小さすぎる音は選ばない（ほかに拍手らしい音が無いほど際立っていれば、少し小さくてもよい）
function syncClap(c) {
  const s = c.clapLike[0];
  if (!s || !c.top.length) return null;
  const rel = s.peak / c.top[0].peak;
  if (rel >= CLAP_MIN_REL) return s;
  const alone = !c.clapLike[1] || s.peak >= CLAP_ALONE * c.clapLike[1].peak;
  return alone && rel >= CLAP_MIN_REL_ALONE && s.peak >= CLAP_OVER_USUAL * c.usual ? s : null;
}

// 音合わせの拍手が、ほかの拍手らしい音の何倍の大きさか（はっきり度）。ほかに無ければ際立っているとみなす
function clapDominance(c) {
  if (!syncClap(c)) return 0;
  if (c.clapLike.length === 1) return Infinity;
  return c.clapLike[0].peak / c.clapLike[1].peak;
}

// JSON は Infinity を書けず null になり「拍手なし」と紛らわしいので、言葉で残す
const dominanceOut = d => (Number.isFinite(d) ? +d.toFixed(2) : 'ほかに拍手らしい音なし');

const describeClap = d =>
  d === 0 ? '拍手らしい音なし'
    : !Number.isFinite(d) ? 'はっきり（ほかに拍手らしい音なし）'
      : `${d.toFixed(2)}倍（目安 ${CLAP_DOMINANCE}倍以上）`;

module.exports = {
  CLAP_RATE, WINDOW, HPF, TOP_N, CLAP_QUIET_DB, CLAP_DECAY_DB, CLAP_MIN_REL, CLAP_ALONE, CLAP_MIN_REL_ALONE, CLAP_OVER_USUAL, CLAP_DOMINANCE,
  pcm, clapPcm, clapCandidates, syncClap, clapDominance, dominanceOut, describeClap,
};
