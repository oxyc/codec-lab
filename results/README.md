# Results

Reports saved from the page, one folder per day, kept as they were downloaded. A report's `started` time and the
lab commit it ran against say which clips and judging rules it reflects: later fixes to the page don't rewrite
earlier results.

| Report | Device | Lab commit | Notes |
|---|---|---|---|
| `2026-09-15/brave-ios-1.json` | iPhone, Brave (iOS WebKit 26.6) | 6fef622 or 3909484 | Before audio calibration: sound in HLS, hls.js, DASH and WebM reads as missing when it was only unmeasurable, Atmos reads as stalled, and fMP4 WebVTT cues are 1.4 s late (the lab's own mapping). |
| `2026-09-15/brave-ios-2.json` | iPhone, Brave (iOS WebKit 26.6) | 15deafb | Segment 1 held back 10 s is judged played though both players stopped after segment 0. |
| `2026-09-15/safari-ios.json` | iPhone, Safari 26.6.1 | 7e49f36 | Matches `brave-ios-2.json` apart from that judging fix. |
| `2026-09-15/safari-macos.json` | Safari 18.6, macOS 15.7, Apple M4 | 7e49f36 | Native HLS started at `EXT-X-START` counts no presented frames and reads as stalled; see the note in den#26 §A6. |
| `2026-09-15/chrome-macos-vp9-long.json` | Chrome 151, macOS 15.7, Apple M4 | 3f2475d | The 30 s VP9 1080p30 and 1080p60 clips only. |
| `2026-09-15/safari-macos-vp9-long.json` | Safari 18.6, macOS 15.7, Apple M4 | 3f2475d | The same clips: every path played to the end, Safari's own HLS player included. |
| `2026-09-15/safari-ios-vp9-long-file-only.json` | iPhone, Safari 26.6.1 | 57649d4 | The same clips in codecs mode, which tries only the MP4 file: refused, though the probe says "probably". |
| `2026-09-15/safari-ios-vp9-long.json` | iPhone, Safari 26.6.1 | 57649d4 | The same clips, every path: own HLS player and hls.js played 30 s; the MP4 file is refused. `time` and `audio` read as on the Mac run. |
| `2026-09-15/chrome-macos.json` | Chrome 151, macOS 15.7, Apple M4 | 7e49f36 | An earlier run the same day is not kept: its tab was hidden, which stops video drawing. |
| `2026-09-16/chrome-macos.json` | Chrome 151, macOS 15.7, Apple M4 | d2952a7 | The subset den#26 left open: both High-tier clips, both VP9 profile-2 clips, and the 5.1 audio cases. The control, not the question — Chrome played every video case in every path. Two things worth reading off it anyway: AC-3 and E-AC-3 give picture with no sound as files and **fail outright** in HLS (`manifestIncompatibleCodecsError`), and Chrome's `mediaCapabilities` claims `supported: true` for both while `canPlayType` says `""` and `isTypeSupported` says false. `time` on the two long clips reads ~0.6 s because the seek test ends by seeking back to 0.5 s, not because the clock stalled: 300 and 842 frames were presented. |

| `2026-09-16/safari-ios.json` | iPhone, Safari 26.6.1 (iOS 18.7) | f3339f2 | The run den#26 was waiting for, and it answers both questions. **HEVC High tier, 2160p at 20 Mbit/s, played in all three paths** — file, Apple's own HLS player and hls.js — so the blanket High-tier refusal on WebKit is broader than the evidence for it. **VP9 profile 2 played in both HLS players** (842 and 843 frames of the 30 s clip) and failed only as a progressive MP4 file, which is the known WebKit rule rather than a profile-2 fault. Audio reads as heard only on the `file` rows: on iOS a page cannot hear HLS or Media Source. |

| `2026-09-16/safari-macos.json` | Safari 18.6, macOS 15.7, Apple M4 | f3339f2 | Completes the set. High tier at 20 Mbit/s played in all three paths, as on the iPhone. VP9 profile 2 played in **every** path here including the progressive MP4, which the iPhone refuses — so that refusal is WebKit-on-iOS, not WebKit. Opus 5.1 failed in all three paths (`MediaError 4` as a file, `3` natively, a MediaSource reset in hls.js). Two lab quirks to read past: frame counts on the `hls.js` rows are consistently **double** what the clip holds (224 for a four-second clip, 1681 for the thirty-second one) while the file and native rows are right, so judge those rows by their verdict rather than their count; and audio reads as `false` on every HLS row though `audioUnmeasurable` is empty — WebKit routes HLS and Media Source around the analyser on macOS too, and the calibration did not catch it here. |

| `2026-09-16/safari-ios-bitrate.json` | iPhone, Safari 26.6.1 (iOS 18.7) | b5f0ac3 | The High‑tier bitrate ladder: 20, 40 and 60 Mbit/s at 2160p. **Every one played in all three paths** — file, Apple's own HLS player, hls.js — 149–155 frames of the five judged seconds, 0–3.7% dropped. Time to first frame climbs with bitrate (2.0–4.0 s) but nothing failed. **No ceiling was found.** VP9 profile 2 re-ran as a regression check: native player 836 frames, hls.js 843, and the progressive MP4 refused as before. |
| `2026-09-16/safari-macos-bitrate.json` | Safari 18.6, macOS 15.7, Apple M4 | b5f0ac3 | The same ladder, same answer: 20, 40 and 60 Mbit/s all played in all three paths, 0–3.8% dropped, TTFF 2.5–4.9 s. So the ceiling is not device-specific either — it was not found on the weaker decoder or the stronger one. |

Two runs from this day are deliberately **not** kept. Both Safari reports taken before `f3339f2` had every case twice, interleaved, with one frame counter shared between two concurrent loops — a four-second clip reporting 572 frames. The cause was the lab's, not the browser's: autorun started a run that waited on an audio context Safari will not resume without a tap, and the tap that followed started a second one while resolving the first's wait. Guard, bounded resume and the removal of autorun all landed in response; a report that says nothing about having run twice is worse than no report.

What these mean for Den is written up in [oxyc/den#26](https://github.com/oxyc/den/issues/26) §A6.
