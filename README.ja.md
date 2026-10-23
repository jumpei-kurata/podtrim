# Podtrim（ひまプロの編集アプリ）

English: [README.md](README.md)

録音から ART19 に上げるまで、この Mac のアプリだけで仕上げる道具です。

## GarageBand より楽になる所

- **消して詰めるがキー1つ**（⌘⌫）: 3人分を選んで消して、右側をドラッグで詰める手間が無くなります
- **黙っている所を自動で詰める**: 全員分いっぺんに
- **頭揃えが自動**: 収録の頭の手拍子で、全員の録音のずれをそろえます（自動で決まらない時は、画面で手拍子の波形を見て選べます）
- **確認モード**: 削った所と被りを1か所ずつ聞けます
- **倍速再生**: 1〜2倍で聞けます（声の高さはそのまま）
- **説明文・タイトル・目次の下書き**を AI が作ります（文字起こしは Mac の中で無料）
- 元の録音は壊さず、⌘Z で300回戻せます。音の大きさも自動でそろいます

## 入れ方（初めに1回）

Apple のチップ（M1 以降）の Mac で、ターミナルに:

```bash
brew install node ffmpeg uv
uv tool install mlx-whisper
cd ~/Documents
git clone https://github.com/jumpei-kurata/podtrim.git
cd podtrim
node app/build.js
```

「できました」と出たら、Finder の「ホーム」→「アプリケーション」の Podtrim を開きます（Dock に入れておくと便利）。

- Homebrew が無ければ、先に https://brew.sh の1行を貼ります
- 初めの組み立てでアプリの土台（約120MB）を、初めての文字起こしでモデル（約1.5GB）を落とすので、それぞれ数分かかります

## 使い方

- 1回分の手順: [docs/guide.md](docs/guide.md)
- 消すキーは2つ: ⌫＝その人の声だけ消す／⌘⌫＝全員分消して詰める
- 録音は「書類」（~/Documents）の中に置きます

## 新しくする

`cd ~/Documents/podtrim` → `git pull` → Podtrim を ⌘Q で閉じて開き直す

## 困った時

`~/Library/Logs/podtrim.log` の最後の方を倉田さんに送ってください。
