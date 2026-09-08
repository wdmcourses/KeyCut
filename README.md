<p align="center">
  <img src="assets/icon.png" width="96" height="96" alt="KeyCut" />
</p>

<h1 align="center">KeyCut</h1>

<p align="center"><b>Fast lossless video editor</b></p>

<p align="center">
  <a href="https://github.com/wdmcourses/KeyCut/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/wdmcourses/KeyCut?style=flat-square&label=Release"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

KeyCut is a video editor that cuts and joins videos without re-encoding.
It splits video at keyframes and splices the kept parts back together, so the
output keeps the original quality and the whole operation is fast.

<p align="center">
  <img src="keycut.png" width="82%" alt="KeyCut screenshot" />
</p>

## Features

- Lossless cutting and splicing, no re-encoding, no quality loss
- Split, delete, restore and merge segments directly on the timeline
- Export the kept segments as a single file
- Reads most container formats: MP4, MOV, MKV, WebM, AVI, TS/M2TS, FLV and more
- Portable single-executable build with FFmpeg bundled

## Keyboard

| Keys | Action |
| --- | --- |
| Space | Play / pause |
| S / F | Previous / next keyframe |
| C | Cut at the caret |
| X / R | Delete / restore segment |
| V | Merge segments |
| Alt + click | Multi-select segments |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+O / Ctrl+S | Open / save project |
| Ctrl+E | Export |

## Download

Builds are published on the [Releases](https://github.com/wdmcourses/KeyCut/releases)
page. Download the archive, extract and run `KeyCut.exe`.

## Building from source

```bash
npm install
npm run ffmpeg   # downloads the static FFmpeg build
npm run pack     # produces the portable build in dist/KeyCut
```

Run the tests:

```bash
npm test            # renderer tests
npm run test:keys   # editing and playback logic
npm run test:scroll # timeline and scrollbar tests
```

## License

[MIT](LICENSE)