# Results

Reports saved from the page, one folder per day, kept as they were downloaded. A report's `started` time and the
lab commit it ran against say which clips and judging rules it reflects: later fixes to the page don't rewrite
earlier results.

| Report | Device | Lab commit | Notes |
|---|---|---|---|
| `2026-09-15/brave-ios-1.json` | iPhone, Brave (iOS WebKit 26.6) | 6fef622 or 3909484 | Before audio calibration: sound in HLS, hls.js, DASH and WebM reads as missing when it was only unmeasurable, Atmos reads as stalled, and fMP4 WebVTT cues are 1.4 s late (the lab's own mapping). |
| `2026-09-15/brave-ios-2.json` | iPhone, Brave (iOS WebKit 26.6) | 15deafb | Segment 1 held back 10 s is judged played though both players stopped after segment 0. |
| `2026-09-15/safari-ios.json` | iPhone, Safari 26.6.1 | 7e49f36 | Matches `brave-ios-2.json` apart from that judging fix. |
| `2026-09-15/chrome-macos.json` | Chrome 151, macOS 15.7, Apple M4 | 7e49f36 | An earlier run the same day is not kept: its tab was hidden, which stops video drawing. |

What these mean for Den is written up in [oxyc/den#26](https://github.com/oxyc/den/issues/26) §A6.
