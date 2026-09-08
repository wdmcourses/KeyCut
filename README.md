# KeyCut

**Fast lossless video trimmer and splicer.** Cut lectures, recordings and long
videos on the fly — no re-encoding, no quality loss. A lightweight, focused
alternative to GUI lossless cutters, built on FFmpeg.

![KeyCut](keycut.png)

## Why KeyCut?

- **100% lossless** — segments are cut and spliced with stream copy only. The
  video is never re-encoded, so you get bit-perfect output in seconds.
- **Keyframe-aware** — cuts snap to real keyframes of the file (parsed directly
  from the container, no grid assumptions), so splices are clean and exact.
- **Fast** — the whole 10-hour lecture probes in under a second; rendering
  streams with FFmpeg copy, not transcode.
- **Eats most formats** — MP4, MOV, MKV, WebM, AVI, TS/M2TS, FLV and more
  (anything FFmpeg demuxes), via the bundled static FFmpeg.
- **Portable** — a single executable with FFmpeg and everything bundled, ready
  to run from a USB stick.

## How it works

1. **Open** a video — keyframes are read instantly and shown on the timeline.
2. **Edit** — split (`C`), dim out (delete) what you don't want (`X`), restore
   (`R`), merge adjacent blocks back (`V`), drag block boundaries to resize.
3. **Export** — the kept segments are cut and spliced losslessly.

## Editing

| Keys | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` / `F` | Previous / next keyframe (hold to scan) |
| `C` | Cut at the caret (snapped to the nearest keyframe) |
| `X` | Dim selected segment(s) (excluded from export) |
| `R` | Restore dimmed segment(s) |
| `V` | Merge adjacent selected blocks into one |
| `Alt` + click | Multi-select segments |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+E` | Export |
| `Ctrl+O` / `Ctrl+S` | Open / save project |

- Drag a **block edge** to extend a kept segment into an adjacent dimmed one.
- Drag the **scrollbar thumb** to pan, its **edges** to zoom.
- `Ctrl` + wheel zooms around the cursor; plain wheel pans.
- The playhead always stays in view while playing.

## Download

Grab the portable build from the [Releases](https://github.com/wdmcourses/KeyCut/releases)
page — download, unzip, run `KeyCut.exe`.

## Building from source

```bash
npm install
npm run ffmpeg      # downloads the static FFmpeg build into vendor/
npm run pack        # builds the portable app into dist/KeyCut
```

Run the tests:

```bash
npm test            # renderer tests
npm run test:keys   # editing / playback logic
npm run test:scroll # timeline & scrollbar
```

## License

MIT