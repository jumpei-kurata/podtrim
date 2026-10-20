# Podtrim

A Mac app that turns separately recorded podcast tracks into a finished episode: synced, trimmed, reviewed, mixed, and ready to upload.

日本語: [README.ja.md](README.ja.md)

I co-host *Himajin Programmer*, a Japanese tech podcast with 500+ episodes, and built Podtrim to replace our GarageBand editing workflow.

## Why not GarageBand?

- **One key to cut across all tracks.** In GarageBand I selected three regions, deleted them, then dragged the rest left to close the gap. In Podtrim, `⌘⌫` does it.
- **Automatic silence trimming** on all tracks at once. The default was tuned against my own hand edits and removes 76% of what I cut by hand.
- **Automatic sync** from the clap at the start of the recording.
- **Review mode** plays every cut and overlap in order.
- **Playback at up to 2x speed**, with the pitch preserved.
- **Show notes**: on-device transcription, then AI-drafted titles, a description, and chapters.

## Also

- Never modifies the original recordings, with 300 steps of undo
- Exports WAV or MP3 at -16 LUFS, the loudness Apple Podcasts recommends, with the ad normalized separately
- Never overwrites a file it did not write

## Built with

Node.js with no npm dependencies, ffmpeg, a plain JavaScript UI, and Electron. Covered by 140 automated checks on synthesized recordings.

## Install (macOS, Apple silicon)

```bash
brew install node ffmpeg uv
uv tool install mlx-whisper
git clone https://github.com/jumpei-kurata/podtrim.git
cd podtrim
node app/build.js
```

The UI is in Japanese. Step-by-step guide: [docs/guide.md](docs/guide.md)

## License

[MIT](LICENSE)
