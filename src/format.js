// 入力の音声フォーマットを調べ、出力で同じ品質を保つための共通処理。
//
// これが無いと ffmpeg の既定に任せることになり、24bitステレオの素材が
// 黙って16bitモノラルに落ちる（実音源で実際にそうなっていた）。
// 元素材の品質を勝手に下げないことは、成果物を人が仕上げる前提の本ツールでは必須。

const { spawnSync } = require('child_process');

function probe(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0',
     '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample,sample_fmt',
     '-of', 'json', file],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`ffprobe failed: ${file}\n${r.stderr}`);
  const s = JSON.parse(r.stdout).streams[0];
  if (!s) throw new Error(`音声ストリームが見つかりません: ${file}`);
  const bits = Number(s.bits_per_raw_sample) || (s.codec_name === 'pcm_s16le' ? 16 : 16);
  return {
    codec: s.codec_name,
    rate: Number(s.sample_rate),
    channels: Number(s.channels),
    bits,
  };
}

// 元のビット深度を保てる WAV の codec を返す
function wavCodecFor(bits) {
  if (bits >= 32) return 'pcm_s32le';
  if (bits >= 24) return 'pcm_s24le';
  return 'pcm_s16le';
}

// 複数ファイルのフォーマットが揃っているかを確認する。
// 揃っていないと、同じサンプル番号で切っても実時間がずれて同期が壊れる。
function requireSameFormat(files) {
  const fmts = files.map(f => ({ file: f, fmt: probe(f) }));
  const ref = fmts[0].fmt;
  const bad = fmts.filter(x => x.fmt.rate !== ref.rate || x.fmt.channels !== ref.channels);
  if (bad.length) {
    const lines = fmts.map(x => `  ${x.file}: ${x.fmt.rate}Hz ${x.fmt.channels}ch ${x.fmt.bits}bit`).join('\n');
    throw new Error(
      `入力のサンプルレート/チャンネル数が揃っていません。同じサンプル番号で切っても実時間がずれ、同期が壊れます。\n${lines}\n` +
        `先に揃えてから実行してください。`
    );
  }
  // ビット深度だけは違っても構わない（最大のものに合わせて書き出す）
  const bits = Math.max(...fmts.map(x => x.fmt.bits));
  return { rate: ref.rate, channels: ref.channels, bits };
}

module.exports = { probe, wavCodecFor, requireSameFormat };
