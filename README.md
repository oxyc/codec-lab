# Codec Lab

What a browser says it plays, and what it actually plays. Open the page on a device, let the capability probe run,
tap **Run playback tests**, and keep the report.

**https://oxyc.github.io/codec-lab/**

Every clip is a four-second synthetic test pattern (ffmpeg's `testsrc2` with the case's id drawn on it, and a
440 Hz tone), so the repository holds no third-party media. Each clip is played every way the browser can play it:

- **file** — the progressive file in a `<video>` (MP4, WebM, Matroska, Ogg, QuickTime);
- **native** — HLS handed to the browser's own player (Safari on macOS and iOS, and every iOS browser, since they
  are all WebKit);
- **hls.js** — the same HLS through [hls.js](https://github.com/video-dev/hls.js) and Media Source Extensions
  (or ManagedMediaSource on iOS).

A test passes when the picture has a size, at least 15 frames are presented (`requestVideoFrameCallback`, else
`getVideoPlaybackQuality`) and playback passes two seconds; audio counts when bytes were decoded
(`webkitAudioDecodedByteCount`) or an analyser hears it; subtitles count when cues load. It fails on a `MediaError`
or a fatal hls.js error, and stalls when none of that happens in 15 seconds. It does not judge how the picture looks
— whether HDR is shown as HDR still takes eyes.

The capability probe asks, for every clip's real codec string, `canPlayType`, `MediaSource.isTypeSupported` and
`MediaCapabilities.decodingInfo` (with the HDR transfer, gamut and metadata type), plus a list of codec strings
nothing here can encode yet (AC-4, MPEG-H, xHE-AAC, VVC, IAMF…).

## What is covered

- **H.264**: Constrained Baseline, Main, High at levels 3.0–5.1 up to 2160p, High 10, High 4:2:2, High 4:4:4.
- **Frame rates**: 23.976, 25, 29.97, 50, 59.94, 120.
- **HEVC**: Main and Main 10, `hvc1` and `hev1`, Main and High tier, up to 4320p, RExt 4:2:2 10-bit and 4:4:4.
- **HDR**: HDR10 (PQ with mastering metadata) and HLG in HEVC, AV1 and VP9; HDR10+ dynamic metadata in HEVC;
  Dolby Vision profiles 5, 8.1, 8.2 and 8.4 (RPUs generated with `dovi_tool`, muxed by GPAC) and profile 7 dual
  layer (a MEL built from `dovi_tool`'s MIT-licensed test RPU); an HLS master with no `VIDEO-RANGE` or
  `FRAME-RATE`, which Safari handles differently.
- **AV1**: Main 8- and 10-bit up to 4320p, High 4:4:4.
- **VP9** profiles 0, 1 and 2; **VP8**, **Theora**, **MPEG-4 Part 2**, **MPEG-2**, **ProRes 422**.
- **Audio**: AAC-LC 2.0/5.1/7.1, HE-AAC v1 and v2, MP3, Opus 2.0/5.1, Vorbis, FLAC 2.0/5.1, ALAC, AC-3 2.0/5.1,
  E-AC-3 5.1/7.1, DTS 5.1, TrueHD 5.1, PCM.
- **Subtitles**: WebVTT as an HLS rendition (fMP4 and TS) and as a `<track>`; SRT as a `<track>`; SRT and ASS
  inside Matroska; 3GPP timed text inside MP4; VobSub (rendered by `spumux`) and PGS (rendered by tsMuxeR) inside
  Matroska.
- **Linked, not copied**: VC-1 Advanced Profile, TrueHD with Atmos and DTS-HD Master Audio, as raw streams from
  FFmpeg's FATE suite (fate-suite.ffmpeg.org). Those samples state no licence, so the page plays them from there.
- **Containers**: MP4 (progressive), HLS with fMP4 and MPEG-TS segments, DASH (through
  [dash.js](https://github.com/Dash-Industry-Forum/dash.js)), WebM, Matroska, Ogg, QuickTime, AVI, MPEG-TS and M2TS
  files, FLV.

Not covered, because no free encoder or freely usable sample exists: Atmos in E-AC-3 (JOC) and DTS:X. The capability
probe still asks about both.

## Page options

- `?groups=hdr,dolby-vision` — only those groups ticked.
- `?only=hevc-main10` — only cases whose id starts with it.
- `?autorun=1` — start playback without a tap (for a driven browser: Safari's `safaridriver`, Playwright).
- `?report=https://…` — POST the finished report there as JSON.

## Regenerating the clips

```sh
python3 generate.py            # every case
python3 generate.py hevc- av1- # cases whose id starts with any argument
```

Needs ffmpeg with libx264, libx265, libsvtav1, libaom, libvpx, libopus, libvorbis, libmp3lame and libtheora; on
macOS, AudioToolbox's `aac_at` for HE-AAC. Dolby Vision and HDR10+ also need `dovi_tool`, `hdr10plus_tool` and
GPAC's `MP4Box`, VobSub needs dvdauthor's `spumux` — each used from the PATH or through `nix shell` — and PGS needs
tsMuxeR (not in nixpkgs: `$TSMUXER`, the PATH, or its release binary at `tools/tsMuxeR`). Codec strings in `docs/cases.json` are read back out of the files, not typed in.

hls.js is vendored in `docs/vendor` under its Apache-2.0 license.
