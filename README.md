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

Three modes: **Codecs** plays each codec once, the plainest way the browser can (a file, else HLS, else DASH);
**Delivery** plays the cases about how media arrives — containers, den-remux-shaped HLS, slow responses, starts on
open-GOP keyframes — every way; **Everything** plays every clip every way. Results are a matrix of case against
delivery: file, HLS in the browser's own player, HLS through hls.js (with Den Web's settings), DASH through dash.js.

A test passes when the picture has a size, at least 15 frames are presented (`requestVideoFrameCallback`, else
`getVideoPlaybackQuality`) and playback reaches the end of the clip, or six seconds past its first frame for a long
stream. Audio counts when bytes were decoded (`webkitAudioDecodedByteCount`) or an analyser hears it. Neither hears every
path (WebKit on iOS routes HLS, Media Source and WebM around the analyser), so each path is first tried on a plain
AAC or Opus clip, and one that comes through silent reports audio as not measurable rather than missing; playback is
unmuted at volume 0 where the browser allows it (iOS ignores volume, so it stays muted there). A pass is only partly
one (~) when audio or cues are missing, the first cue isn't at 0.5 s, a seek to 80 % and back doesn't recover, playback
didn't start at `EXT-X-START`, more than 5 % of frames dropped, or it played only muted. Each result records time to
first frame. It fails on a `MediaError` or a fatal hls.js/dash.js error, and stalls when it doesn't get there in 20
seconds. A hidden tab stops drawing video, so a test the tab was hidden during is thrown away and run again once the
tab is back. It does not judge how the picture looks — whether HDR is shown as HDR still takes eyes.

The capability probe asks, for every clip's real codec string, `canPlayType`, `MediaSource.isTypeSupported` and
`MediaCapabilities.decodingInfo` (with the HDR transfer, gamut and metadata type), plus a list of codec strings
nothing here can encode yet (AC-4, MPEG-H, xHE-AAC, VVC, IAMF…).

## Results so far

From the reports in [`results/`](results/), 2026-09-15. ✅ plays · ❌ doesn't · 🔇 picture but no sound. "Own
player" is HLS handed to the browser's `<video>`; iPhone is iOS 26.6 WebKit, where Safari and Brave matched.

| | iPhone | Safari 18.6, Mac | Chrome 151, Mac |
|---|---|---|---|
| H.264 8-bit up to 2160p, 23.976–120 fps | ✅ | ✅ | ✅ |
| H.264 High 10, High 4:4:4 | ✅ | ❌ | ✅ |
| HEVC Main/Main 10, High tier, RExt, 8K | ✅ | ✅ | ✅ |
| HEVC tagged `hev1`, as a file | ❌ (✅ in HLS) | ❌ (✅ in HLS) | ✅ |
| HEVC in MPEG-TS HLS, own player | ❌ | ❌ | ❌ |
| HDR10, HLG, HDR10+ (picture; HDR look not judged) | ✅ | ✅ | ✅ |
| PQ master without `VIDEO-RANGE` or `FRAME-RATE`, own player | ❌ | ❌ | ✅ |
| Dolby Vision 8.1, 8.4, 8.2 | ✅ | ✅ | ✅ base layer |
| Dolby Vision 5 | ✅ | ✅ | ❌ in HLS |
| Dolby Vision 7 | ❌ | ❌ | ❌ in HLS; base layer as a file |
| AV1 up to 2160p, MP4 and HLS | ✅ | ✅ | ✅ |
| AV1 in WebM | ✅ | ❌ | ✅ |
| AV1 4320p in HLS | ❌ | ✅ | ✅ |
| AV1 High 4:4:4, VP9 4:4:4 | ❌ | ❌ | ✅ |
| VP9 profiles 0 and 2 | ✅ WebM, hls.js; ❌ MP4; own player ❓ ¹ | ✅ WebM, MP4, hls.js, own player ¹ | ✅ |
| VP9 1080p30 and 1080p60, 30 s at 6 Mbit/s, with AAC | ✅ own player, hls.js; ❌ file ² | ✅ file, own player, hls.js | ✅ file, own player, hls.js |
| MPEG-4 Part 2 in MP4, ProRes 422 | ✅ | ✅ | ❌ |
| MPEG-2 | ❌ | ✅ TS file only | ❌ |
| Theora, AVI, FLV | ❌ | ❌ | ❌ |
| Matroska | ❌ | ❌ | ✅ |
| MPEG-TS and M2TS files (H.264) | ❌ | ✅ | ❌ |
| AAC LC and HE-AAC, FLAC | ✅ | ✅ | ✅ |
| AC-3, E-AC-3, ALAC | ✅ | ✅ | 🔇 file; ❌ HLS |
| MP3 | 🔇 MP4 file; ❌ HLS | 🔇 MP4 file; ❌ HLS | ✅ file and TS HLS; ❌ hls.js |
| Opus | 2.0 ✅ file and hls.js; 5.1 ❌; ❌ own player | 2.0 ✅ file and hls.js; 5.1 ❌; ❌ own player | ✅ |
| DTS core, TrueHD | 🔇 DTS in MP4; TrueHD in Matroska ❌ | 🔇 DTS in MP4; TrueHD in Matroska ❌ | 🔇 |
| Atmos in E-AC-3 JOC (Dolby's kit) | ✅ picture; sound not measurable | ✅ picture; sound not measurable | ❌ (🔇 in dash.js) |
| WebVTT | ✅ | ✅ | ✅ `<track>` and hls.js; own player hides it |
| SRT, ASS, VobSub, PGS, `mov_text` | ❌ no cues | ❌ no cues | plays, no cues |
| `EXT-X-START`, own player | ✅ | ❓ clock moves, no frames counted | ❌ starts at 0 |
| `EXT-X-START`, hls.js | ✅ | ✅ | ✅ |
| den-remux resume, H.264 / HDR10 HEVC, hls.js | ✅ / ✅ | ✅ / ❌ | ✅ / ✅ |
| `init.mp4` late, own player | ❌ from 3 s | ✅ 6 s; ❌ 10 s | ✅ 10 s |
| `init.mp4` late, hls.js | ✅ 6 s; ❌ 10 s | ✅ 6 s; ❌ 10 s | ✅ 6 s; ❌ 10 s |
| Segment 1 10 s late | ❌ both players | ❌ both players | ✅ own player; ❌ hls.js |

¹ The short `vp9-p0` clip failed in Safari's own HLS player, but it carries Opus audio, and Opus in HLS fails there on
its own. With AAC, Safari 18.6 on macOS and Safari 26.6.1 on the iPhone played VP9 1080p30 and 1080p60 in their own
HLS player for 30 s. The Den trailer stall that first pointed at VP9 on WebKit turned out not to be a codec problem:
Den Web forced an hls.js level before the first fragment, and Safari is slow to start YouTube's fragmented MP4 files
whatever their codec. Both are written up in oxyc/den#26, section A7.

² On the iPhone the MP4 file is refused with `MEDIA_ERR_SRC_NOT_SUPPORTED` although `canPlayType` answers "probably"
and Media Capabilities calls it supported, smooth and power efficient. The same stream plays in HLS. The 60 fps clip
presented about 48 frames a second in the own player and 55 in hls.js, with none reported dropped.

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
- **Starting mid-stream**: open-GOP H.264 and CRA-keyframe HEVC played from `EXT-X-START`, beside closed-GOP
  contrasts.
- **Delivered like den-remux**: a 60-second clip resumed at 31.2 s, in segments of about 6 s cut on uneven keyframes and
  joined from per-GOP fragments, with the resumed job's init and a job from zero behind it (H.264 with AAC 5.1, and a
  1920×800 HDR10 HEVC).
- **HDR signalling faults one at a time**: masters with no `VIDEO-RANGE`, no `FRAME-RATE`, or neither, and an HDR10
  file whose container names no colours (only the SPS does).
- **Slow responses**: `docs/sw.js`, a service worker, holds back `init.mp4` for 3, 6 or 10 seconds, or segment 1 for
  10, beside a pass-through that holds nothing, so a player that can't play through a service worker at all shows
  up there; where a player doesn't fetch through it, the result is marked unmeasured.
- **From elsewhere**: Atmos in E-AC-3 (Dolby's delivery-kit test signal as a file, HLS and DASH, and Apple's
  Dolby Vision + Atmos HLS example), DTS Express and DTS-HD High Resolution (DASH-IF test vectors), all played from
  where they are hosted; DTS:X for streaming (`dtsx`), committed from shaka-packager's BSD-licensed test data.
- **Asked about only**: VC-1, TrueHD with Atmos, DTS-HD Master Audio — FFmpeg's FATE samples are raw streams with no
  licence, which no browser plays bare.
- **Containers**: MP4 (progressive), HLS with fMP4 and MPEG-TS segments, DASH (through
  [dash.js](https://github.com/Dash-Industry-Forum/dash.js)), WebM, Matroska, Ogg, QuickTime, AVI, MPEG-TS and M2TS
  files, FLV.

Not covered: DTS:X inside DTS-HD MA (the Blu-ray kind), which has no stable source — browsers don't decode DTS-HD MA
at all, so it would read like the MA row — and segments too large for GitHub Pages (a 4K remux's 100–250 MB GOPs,
which can exceed a SourceBuffer's quota); that one needs hosting elsewhere.

## Page options

- `?mode=codecs|delivery|everything` — which tests Run plays (codecs by default).
- `?groups=hdr,dolby-vision` — only those groups ticked.
- `?only=hevc-main10` — only cases whose id starts with it.
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
