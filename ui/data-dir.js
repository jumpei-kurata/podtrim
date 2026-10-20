// 「回」のデータの置き場所。リポジトリの外（Mac のアプリの標準の置き場所）に置く。
// リポジトリの中（ui/data）に置くと、作業用の分岐を片付けた時に、倉田さんの編集の状態ごと消える（2026-10-17 の監査）。
// 環境変数 HIMADAN_DATA で変えられる（テスト用など）。
const os = require('os');
const path = require('path');

module.exports = process.env.HIMADAN_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'himadan-edit', 'projects');
