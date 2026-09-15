#!/usr/bin/env python3
"""Builds every test clip the lab plays, and docs/cases.json describing them.

Each case is encoded once from a synthetic source (ffmpeg's testsrc2 and a tone) into an intermediate, then copied
without re-encoding into each container that can carry it: a progressive file, HLS with fMP4 segments, HLS with
MPEG-TS segments, WebM, Matroska, Ogg, QuickTime. The RFC 6381 codec string a player is told is read back out of the
MP4 the encoder produced, not written by hand, so it is the string the file really deserves.

    python3 generate.py                 # everything
    python3 generate.py hevc-main10-pq  # cases whose id starts with any of the arguments

Needs ffmpeg with libx264, libx265, libsvtav1, libaom, libvpx, libopus, libvorbis, libmp3lame, libtheora (macOS also
gives aac_at for HE-AAC), and for Dolby Vision `dovi_tool` and GPAC's `MP4Box` on the PATH or through `nix run`.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOCS = ROOT / "docs"
MEDIA = DOCS / "media"
WORK = ROOT / "work"
SECONDS = 4
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


# ---------------------------------------------------------------------------------------------------------------
# The cases


@dataclass
class Video:
    encoder: str
    size: tuple = (640, 360)
    fps: str = "30"
    pix_fmt: str = "yuv420p"
    args: list = field(default_factory=list)
    # H.273 code points, for the colour tags and for VIDEO-RANGE.
    primaries: int = 1
    transfer: int = 1
    matrix: int = 1
    # Dolby Vision: None, or "5", "8.1", "8.4".
    dovi: str = None
    # HDR10+ dynamic metadata, written into the SEI by x265.
    hdr10plus: bool = False


@dataclass
class Audio:
    encoder: str
    channels: int = 2
    rate: int = 48000
    args: list = field(default_factory=list)


@dataclass
class Case:
    id: str
    group: str
    title: str
    video: Video = None
    audio: Audio = None
    formats: list = field(default_factory=list)
    note: str = ""
    # "webvtt" (an HLS rendition and a <track>), "srt-sidecar" (a <track> naming an .srt), or a subtitle stream
    # inside the file: "subrip", "ass", "mov_text".
    subtitles: str = None


AAC = Audio("aac", args=["-b:a", "128k"])


def x264(profile, level, pix="yuv420p", size=(1280, 720), fps="30"):
    return Video("libx264", size, fps, pix, ["-profile:v", profile, "-level:v", level, "-preset", "veryfast", "-crf", "28"])


def x265(params, pix="yuv420p", size=(1280, 720), fps="30", **colour):
    # x265 signals High tier wherever the level allows unless told not to; only the High-tier case asks for it.
    base = "log-level=error:" + ("" if "high-tier=1" in params else "high-tier=0:") + params
    return Video("libx265", size, fps, pix, ["-preset", "fast", "-crf", "30", "-x265-params", base], **colour)


def svt(pix="yuv420p", size=(1280, 720), fps="30", params="", **colour):
    args = ["-preset", "10", "-crf", "45"]
    if params:
        args += ["-svtav1-params", params]
    return Video("libsvtav1", size, fps, pix, args, **colour)


def vp9(profile, pix, size=(1280, 720), fps="30", **colour):
    return Video(
        "libvpx-vp9", size, fps, pix,
        ["-profile:v", str(profile), "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1"], **colour,
    )


PQ = dict(primaries=9, transfer=16, matrix=9)
HLG = dict(primaries=9, transfer=18, matrix=9)
HDR10_PARAMS = (
    "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:hdr10-opt=1:repeat-headers=1:"
    "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400"
)
HLG_PARAMS = "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:repeat-headers=1"

MP4_FAMILY = ["mp4", "hls-fmp4"]

CASES = [
    # --- H.264 ---------------------------------------------------------------------------------------------------
    Case("h264-baseline-30", "h264", "H.264 Constrained Baseline 3.0, 640×360",
         x264("baseline", "3.0", size=(640, 360)), AAC, MP4_FAMILY + ["hls-ts", "mkv"]),
    Case("h264-main-31", "h264", "H.264 Main 3.1, 1280×720", x264("main", "3.1"), AAC, MP4_FAMILY + ["hls-ts"]),
    Case("h264-high-40", "h264", "H.264 High 4.0, 1920×1080", x264("high", "4.0", size=(1920, 1080)), AAC,
         MP4_FAMILY + ["hls-ts", "dash", "mkv", "mov"]),
    Case("h264-high-42-60fps", "h264", "H.264 High 4.2, 1080p60", x264("high", "4.2", size=(1920, 1080), fps="60"),
         AAC, MP4_FAMILY),
    Case("h264-high-51-2160p", "h264", "H.264 High 5.1, 3840×2160", x264("high", "5.1", size=(3840, 2160)), AAC,
         MP4_FAMILY),
    Case("h264-high10", "h264", "H.264 High 10, 1080p", x264("high10", "4.0", "yuv420p10le", (1920, 1080)), AAC,
         MP4_FAMILY + ["mkv"]),
    Case("h264-high422", "h264", "H.264 High 4:2:2 10-bit, 1080p", x264("high422", "4.0", "yuv422p10le", (1920, 1080)),
         AAC, MP4_FAMILY),
    Case("h264-high444", "h264", "H.264 High 4:4:4 Predictive, 1080p", x264("high444", "4.0", "yuv444p", (1920, 1080)),
         AAC, MP4_FAMILY),
    # Frame rates, which Safari reads from FRAME-RATE and a player may refuse outright.
    *[
        Case(f"h264-fps-{name}", "framerate", f"H.264 High, 720p at {label} fps", x264("high", level, fps=rate), AAC,
             MP4_FAMILY)
        for name, label, rate, level in [
            ("23976", "23.976", "24000/1001", "3.1"), ("25", "25", "25", "3.1"), ("2997", "29.97", "30000/1001", "3.1"),
            ("50", "50", "50", "3.2"), ("5994", "59.94", "60000/1001", "3.2"), ("120", "120", "120", "4.2"),
        ]
    ],
    # --- HEVC ----------------------------------------------------------------------------------------------------
    Case("hevc-main-40", "hevc", "HEVC Main 4.0, 1080p (hvc1)", x265("level-idc=40", size=(1920, 1080)), AAC,
         MP4_FAMILY + ["hls-ts", "mkv", "mov"]),
    Case("hevc-main-40-hev1", "hevc", "HEVC Main 4.0, 1080p, tagged hev1", x265("level-idc=40", size=(1920, 1080)),
         AAC, ["mp4", "hls-fmp4"], note="Parameter sets in-band and the sample entry named hev1 rather than hvc1."),
    Case("hevc-main10-40", "hevc", "HEVC Main 10 4.0, 1080p SDR", x265("profile=main10:level-idc=40", "yuv420p10le",
         (1920, 1080)), AAC, MP4_FAMILY + ["dash", "mkv"]),
    Case("hevc-main-51-2160p", "hevc", "HEVC Main 5.1 Main tier, 2160p", x265("level-idc=51", size=(3840, 2160)), AAC,
         MP4_FAMILY),
    Case("hevc-main10-51-high-tier", "hevc", "HEVC Main 10 5.1 High tier, 2160p",
         x265("profile=main10:level-idc=51:high-tier=1", "yuv420p10le", (3840, 2160)), AAC, MP4_FAMILY,
         note="A UHD Blu-ray remux's tier."),
    Case("hevc-main-61-4320p", "hevc", "HEVC Main 6.1, 7680×4320", x265("level-idc=61", size=(7680, 4320)), AAC,
         ["mp4", "hls-fmp4"]),
    Case("hevc-rext-422-10", "hevc", "HEVC Main 4:2:2 10 (RExt), 1080p",
         x265("profile=main422-10:level-idc=41", "yuv422p10le", (1920, 1080)), AAC, MP4_FAMILY),
    Case("hevc-rext-444-8", "hevc", "HEVC Main 4:4:4 (RExt), 1080p",
         x265("profile=main444-8:level-idc=41", "yuv444p", (1920, 1080)), AAC, MP4_FAMILY),
    # --- HDR -----------------------------------------------------------------------------------------------------
    Case("hevc-main10-pq", "hdr", "HEVC Main 10 HDR10 (PQ), 1080p",
         x265("profile=main10:level-idc=41:" + HDR10_PARAMS, "yuv420p10le", (1920, 1080), **PQ), AAC,
         MP4_FAMILY + ["hls-fmp4-bare", "dash", "mkv"],
         note="hls-fmp4-bare is the same stream with no VIDEO-RANGE or FRAME-RATE in its master playlist."),
    Case("hevc-main10-hdr10plus", "hdr", "HEVC Main 10 HDR10+ (PQ with dynamic metadata), 1080p",
         Video("libx265", (1920, 1080), "30", "yuv420p10le",
               ["-preset", "fast", "-crf", "30", "-x265-params",
                "log-level=error:high-tier=0:profile=main10:level-idc=41:" + HDR10_PARAMS], **PQ, hdr10plus=True),
         AAC, MP4_FAMILY + ["mkv"], note="A player without HDR10+ shows the HDR10 base; what is tested is that it plays."),
    Case("hevc-main10-pq-2160p", "hdr", "HEVC Main 10 HDR10 (PQ) 5.1, 2160p",
         x265("profile=main10:level-idc=51:" + HDR10_PARAMS, "yuv420p10le", (3840, 2160), **PQ), AAC, MP4_FAMILY),
    Case("hevc-main10-hlg", "hdr", "HEVC Main 10 HLG, 1080p",
         x265("profile=main10:level-idc=41:" + HLG_PARAMS, "yuv420p10le", (1920, 1080), **HLG), AAC,
         MP4_FAMILY + ["hls-fmp4-bare"]),
    *[
        Case(f"hevc-dv-p{p.replace('.', '')}", "dolby-vision", f"Dolby Vision profile {p}, 1080p",
             Video("libx265", (1920, 1080), "30", "yuv420p10le",
                   ["-preset", "fast", "-crf", "30", "-x265-params",
                    "log-level=error:high-tier=0:profile=main10:level-idc=41:"
                    + (HLG_PARAMS if p == "8.4" else HDR10_PARAMS)],
                   **(HLG if p == "8.4" else PQ), dovi=p),
             AAC, MP4_FAMILY,
             note=("Profile 5's base layer is meant to be IPTPQc2, so its picture is off in colour here; what is "
                   "tested is whether it plays." if p == "5" else ""))
        for p in ["5", "8.1", "8.4"]
    ],
    Case("av1-main10-pq", "hdr", "AV1 Main 10-bit HDR10 (PQ), 1080p",
         svt("yuv420p10le", (1920, 1080), params="color-primaries=9:transfer-characteristics=16:matrix-coefficients=9",
             **PQ), AAC, MP4_FAMILY),
    Case("av1-main10-pq-webm", "hdr", "AV1 Main 10-bit HDR10 (PQ) in WebM with Opus, 1080p",
         svt("yuv420p10le", (1920, 1080), params="color-primaries=9:transfer-characteristics=16:matrix-coefficients=9",
             **PQ), Audio("libopus", args=["-b:a", "96k"]), ["webm"]),
    Case("av1-main10-hlg", "hdr", "AV1 Main 10-bit HLG, 1080p",
         svt("yuv420p10le", (1920, 1080), params="color-primaries=9:transfer-characteristics=18:matrix-coefficients=9",
             **HLG), AAC, MP4_FAMILY),
    Case("vp9-p2-pq", "hdr", "VP9 Profile 2 10-bit HDR10 (PQ), 1080p", vp9(2, "yuv420p10le", (1920, 1080), **PQ),
         Audio("libopus", args=["-b:a", "96k"]), ["webm", "mp4"]),
    # --- AV1 -----------------------------------------------------------------------------------------------------
    Case("av1-main-8bit", "av1", "AV1 Main 8-bit, 1080p", svt(size=(1920, 1080)), AAC, MP4_FAMILY + ["dash", "mkv"]),
    Case("av1-main-10bit", "av1", "AV1 Main 10-bit SDR, 1080p", svt("yuv420p10le", (1920, 1080)), AAC, MP4_FAMILY),
    # WebM carries only Opus or Vorbis beside its video, so AV1 in WebM is its own case.
    Case("av1-main10-webm", "av1", "AV1 Main 10-bit in WebM with Opus, 1080p", svt("yuv420p10le", (1920, 1080)),
         Audio("libopus", args=["-b:a", "96k"]), ["webm"]),
    Case("av1-main-2160p", "av1", "AV1 Main 10-bit, 2160p", svt("yuv420p10le", (3840, 2160)), AAC, MP4_FAMILY),
    Case("av1-main-4320p", "av1", "AV1 Main 8-bit, 7680×4320", svt(size=(7680, 4320)), AAC, ["mp4", "hls-fmp4"]),
    Case("av1-high-444", "av1", "AV1 High 4:4:4 8-bit, 1080p",
         Video("libaom-av1", (1920, 1080), "30", "yuv444p", ["-cpu-used", "8", "-row-mt", "1", "-crf", "45"]), AAC,
         ["mp4", "mkv"]),
    # --- VP9, VP8 and older --------------------------------------------------------------------------------------
    Case("vp9-p0", "vp9", "VP9 Profile 0, 1080p", vp9(0, "yuv420p", (1920, 1080)), Audio("libopus", args=["-b:a", "96k"]),
         ["webm", "mp4", "hls-fmp4", "dash"]),
    Case("vp9-p0-2160p", "vp9", "VP9 Profile 0, 2160p", vp9(0, "yuv420p", (3840, 2160)),
         Audio("libopus", args=["-b:a", "96k"]), ["webm", "mp4"]),
    Case("vp9-p1-444", "vp9", "VP9 Profile 1 4:4:4, 1080p", vp9(1, "yuv444p", (1920, 1080)),
         Audio("libopus", args=["-b:a", "96k"]), ["webm", "mp4"]),
    Case("vp8", "legacy", "VP8, 720p", Video("libvpx", (1280, 720), "30", "yuv420p", ["-b:v", "1M", "-deadline", "realtime",
         "-cpu-used", "8"]), Audio("libvorbis", args=["-q:a", "4"]), ["webm"]),
    Case("theora", "legacy", "Theora, 640×360", Video("libtheora", args=["-q:v", "6"]), Audio("libvorbis", args=["-q:a", "4"]),
         ["ogg"]),
    Case("mpeg4-part2", "legacy", "MPEG-4 Part 2 (Simple), 640×360", Video("mpeg4", args=["-q:v", "4"]), AAC,
         ["mp4", "mkv"]),
    Case("mpeg2", "legacy", "MPEG-2 Main, 720×480", Video("mpeg2video", (720, 480), "30000/1001", "yuv420p", ["-q:v", "4"]),
         Audio("mp2", args=["-b:a", "192k"]), ["hls-ts", "ts", "mkv"]),
    Case("prores-422", "legacy", "Apple ProRes 422, 1080p",
         Video("prores_ks", (1920, 1080), "30", "yuv422p10le", ["-profile:v", "2"]), Audio("pcm_s16le"), ["mov"]),
    # --- Containers not covered above ----------------------------------------------------------------------------
    Case("container-avi-xvid", "containers", "AVI: Xvid (MPEG-4 Part 2) with MP3, 640×360",
         Video("libxvid", args=["-q:v", "4"]), Audio("libmp3lame", 2, 44100, ["-b:a", "160k"]), ["avi", "mkv"]),
    Case("container-ts-h264", "containers", "MPEG-TS and M2TS files: H.264 High with AAC, 720p", x264("high", "3.1"),
         AAC, ["ts", "m2ts"], note="Progressive transport-stream files, not HLS."),
    Case("container-m2ts-hevc-ac3", "containers", "M2TS and MPEG-TS files: HEVC Main 10 with AC-3 5.1, 1080p",
         x265("profile=main10:level-idc=41", "yuv420p10le", (1920, 1080)), Audio("ac3", 6, args=["-b:a", "448k"]),
         ["m2ts", "ts"]),
    Case("container-flv-h264", "containers", "FLV: H.264 Main with AAC, 720p", x264("main", "3.1"), AAC, ["flv"]),
    # --- Audio ---------------------------------------------------------------------------------------------------
    # The video under every audio case is the same small H.264, so the audio is the only thing that can fail.
    *[
        Case(f"audio-{name}", "audio", title, x264("main", "3.0", size=(640, 360)), audio, formats, note=note)
        for name, title, audio, formats, note in [
            ("aac-lc-20", "AAC-LC stereo", Audio("aac", 2, args=["-b:a", "128k"]), MP4_FAMILY + ["hls-ts", "mkv"], ""),
            ("aac-lc-51", "AAC-LC 5.1", Audio("aac", 6, args=["-b:a", "384k"]), MP4_FAMILY + ["mkv"], ""),
            ("aac-lc-71", "AAC-LC 7.1", Audio("aac", 8, args=["-b:a", "512k"]), MP4_FAMILY, ""),
            # AVCodecContext profiles 4 (HE-AAC) and 28 (HE-AAC v2): aac_at names no constants for them.
            ("he-aac-v1", "HE-AAC v1 stereo", Audio("aac_at", 2, args=["-profile:a", "4", "-b:a", "64k"]),
             MP4_FAMILY, "AudioToolbox's encoder: made on a Mac."),
            ("he-aac-v2", "HE-AAC v2 stereo", Audio("aac_at", 2, args=["-profile:a", "28", "-b:a", "32k"]),
             MP4_FAMILY, "AudioToolbox's encoder: made on a Mac."),
            ("mp3-20", "MP3 stereo", Audio("libmp3lame", 2, 44100, ["-b:a", "192k"]), MP4_FAMILY + ["hls-ts", "mkv"], ""),
            ("opus-20", "Opus stereo", Audio("libopus", 2, args=["-b:a", "128k"]), ["mp4", "hls-fmp4", "mkv"], ""),
            ("opus-51", "Opus 5.1", Audio("libopus", 6, args=["-b:a", "256k", "-mapping_family", "1"]),
             ["mp4", "hls-fmp4", "mkv"], ""),
            ("vorbis-20", "Vorbis stereo", Audio("libvorbis", 2, args=["-q:a", "4"]), ["mkv"], ""),
            ("flac-20", "FLAC stereo", Audio("flac", 2), ["mp4", "hls-fmp4", "mkv"], ""),
            ("flac-51", "FLAC 5.1", Audio("flac", 6), ["mp4", "hls-fmp4", "mkv"], ""),
            ("alac-20", "ALAC stereo", Audio("alac", 2), ["mp4", "hls-fmp4", "mov"], ""),
            ("ac3-20", "AC-3 stereo", Audio("ac3", 2, args=["-b:a", "192k"]), MP4_FAMILY + ["hls-ts", "mkv"], ""),
            ("ac3-51", "AC-3 5.1", Audio("ac3", 6, args=["-b:a", "448k"]), MP4_FAMILY + ["hls-ts", "mkv"], ""),
            # ffmpeg's E-AC-3 encoder stops at 5.1, so 7.1 (and Atmos) is only asked about, not played.
            ("eac3-51", "E-AC-3 5.1", Audio("eac3", 6, args=["-b:a", "384k"]), MP4_FAMILY + ["hls-ts", "dash", "mkv"],
             ""),
            ("dts-51", "DTS 5.1", Audio("dca", 6, args=["-strict", "-2", "-b:a", "1509k"]), ["mp4", "mkv"],
             "ffmpeg's DTS encoder is experimental."),
            ("truehd-51", "Dolby TrueHD 5.1", Audio("truehd", 6, args=["-strict", "-2"]), ["mkv"],
             "ffmpeg's TrueHD encoder is experimental, and its MP4 muxer refuses TrueHD."),
            ("pcm-s16-20", "PCM 16-bit stereo", Audio("pcm_s16le", 2), ["mov", "mkv"], ""),
        ]
    ],
    # WebM's audio beside VP9, since WebM takes no H.264.
    Case("audio-opus-20-webm", "audio", "Opus stereo in WebM (VP9 video)", vp9(0, "yuv420p", (640, 360)),
         Audio("libopus", 2, args=["-b:a", "128k"]), ["webm"]),
    Case("audio-opus-51-webm", "audio", "Opus 5.1 in WebM (VP9 video)", vp9(0, "yuv420p", (640, 360)),
         Audio("libopus", 6, args=["-b:a", "256k", "-mapping_family", "1"]), ["webm"]),
    Case("audio-vorbis-20-webm", "audio", "Vorbis stereo in WebM (VP9 video)", vp9(0, "yuv420p", (640, 360)),
         Audio("libvorbis", 2, args=["-q:a", "4"]), ["webm"]),
    # --- Subtitles -----------------------------------------------------------------------------------------------
    Case("subs-webvtt", "subtitles", "WebVTT subtitles (HLS rendition, and a <track> on the MP4)",
         x264("main", "3.0", size=(640, 360)), AAC, ["mp4", "hls-fmp4", "hls-ts"], subtitles="webvtt"),
    Case("subs-srt-sidecar", "subtitles", "SRT as a <track> on an MP4", x264("main", "3.0", size=(640, 360)), AAC,
         ["mp4"], subtitles="srt-sidecar", note="Browsers take WebVTT in <track>; this asks whether any takes SRT."),
    Case("subs-srt-embedded", "subtitles", "SRT (SubRip) inside Matroska", x264("main", "3.0", size=(640, 360)), AAC,
         ["mkv"], subtitles="subrip"),
    Case("subs-ass-embedded", "subtitles", "ASS/SSA inside Matroska", x264("main", "3.0", size=(640, 360)), AAC,
         ["mkv"], subtitles="ass"),
    Case("subs-mov-text", "subtitles", "3GPP timed text (mov_text) inside MP4", x264("main", "3.0", size=(640, 360)),
         AAC, ["mp4"], subtitles="mov_text"),
]


# ---------------------------------------------------------------------------------------------------------------
# Encoding


def run(args, **kw):
    print("  $", " ".join(str(a) for a in args[:12]), "…" if len(args) > 12 else "", flush=True)
    subprocess.run([str(a) for a in args], check=True, **kw)


def tool(name, package):
    """A command on the PATH, or the same through nix."""
    return [name] if shutil.which(name) else ["nix", "shell", f"nixpkgs#{package}", "-c", name]


def fps_value(fps):
    num, _, den = fps.partition("/")
    return float(num) / float(den or 1)


def colour_args(v):
    if (v.primaries, v.transfer, v.matrix) == (1, 1, 1):
        return ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    names = {9: "bt2020", 16: "smpte2084", 18: "arib-std-b67"}
    return ["-color_primaries", names[v.primaries], "-color_trc", names[v.transfer], "-colorspace", "bt2020nc"]


def source_args(case):
    v, a = case.video, case.audio
    w, h = v.size
    text = case.id.replace(":", r"\:")
    draw = f",drawtext=fontfile={FONT}:text='{text}':x=20:y=20:fontsize={max(h // 18, 16)}:fontcolor=white:box=1:boxcolor=black@0.6"
    tags = ""
    if (v.primaries, v.transfer, v.matrix) != (1, 1, 1):
        names = {9: "bt2020", 16: "smpte2084", 18: "arib-std-b67"}
        tags = f",setparams=color_primaries=bt2020:color_trc={names[v.transfer]}:colorspace=bt2020nc"
    args = ["-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={v.fps}:duration={SECONDS}{draw if os.path.exists(FONT) else ''}"]
    if a:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={a.rate}:duration={SECONDS}"]
    return args, f"format={v.pix_fmt}{tags}"


def encode(case, out):
    """The case's streams, encoded once into Matroska — which carries every codec here — or, for Dolby Vision, into
    an MP4 that MP4Box writes with its configuration record."""
    v, a = case.video, case.audio
    inputs, vf = source_args(case)
    gop = max(round(fps_value(v.fps)), 1)
    video = ["-map", "0:v", "-vf", vf, "-c:v", v.encoder, "-pix_fmt", v.pix_fmt, *v.args, "-g", str(gop),
             *colour_args(v)]
    if v.encoder == "libx265":
        # A keyframe every second, and no scene cuts: segments cut on them.
        i = video.index("-x265-params") + 1
        video[i] += f":keyint={gop}:min-keyint={gop}:scenecut=0"
        if case.id.endswith("hev1"):
            video[i] += ":repeat-headers=1"
    audio = []
    if a:
        audio = ["-map", "1:a", "-c:a", a.encoder, "-ac", str(a.channels), "-ar", str(a.rate), *a.args]
    if v.hdr10plus:
        return encode_hdr10plus(case, inputs, video, audio, out)
    subtitles = []
    if case.subtitles in ("subrip", "ass", "mov_text"):
        # Matroska carries SubRip and ASS as they are; mov_text goes into it as SubRip and becomes mov_text in the MP4.
        source = out.parent / ("subs.ass" if case.subtitles == "ass" else "subs.srt")
        source.write_text(ASS if case.subtitles == "ass" else SRT)
        inputs = inputs + ["-i", source]
        index = 2 if a else 1
        subtitles = ["-map", f"{index}:s", "-c:s", "ass" if case.subtitles == "ass" else "subrip",
                     "-metadata:s:s:0", "language=eng"]
    if v.dovi:
        return encode_dovi(case, inputs, video, audio, out)
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, *video, *audio, *subtitles, "-t", SECONDS, out])
    return out


def encode_hdr10plus(case, inputs, video, audio, out):
    """HDR10+: the HDR10 stream encoded bare, its dynamic metadata interleaved as SEI by `hdr10plus_tool` — the x265
    in nixpkgs is built without HDR10_PLUS and ignores `dhdr10-info` — then muxed with the audio."""
    work = out.parent
    raw = work / "base.hevc"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, *video, "-t", SECONDS, "-f", "hevc", raw])
    metadata = work / "hdr10plus.json"
    metadata.write_text(json.dumps(hdr10plus_metadata(int(SECONDS * fps_value(case.video.fps)))))
    injected = work / "hdr10plus.hevc"
    run([*tool("hdr10plus_tool", "hdr10plus_tool"), "inject", "-i", raw, "-j", metadata, "-o", injected])
    tone = work / "audio.mka"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, *audio, "-t", SECONDS, tone])
    # A raw HEVC stream has no timestamps of its own, and ffmpeg won't copy it into Matroska without them: MP4Box
    # wraps it at the frame rate first, as it does for Dolby Vision.
    video_only = work / "hdr10plus.mp4"
    run([*tool("MP4Box", "gpac"), "-quiet", "-add", f"{injected}:fps={case.video.fps}", "-new", video_only])
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video_only, "-i", tone, "-map", "0:v",
         "-map", "1:a", "-c", "copy", out])
    return out


def hdr10plus_metadata(frames):
    """HDR10+ (SMPTE ST 2094-40) metadata as JSON in the layout x265 and `hdr10plus_tool` read: one scene, the same
    values on every frame. The values only have to be valid; what is tested is whether a player takes the stream."""
    frame = {
        "BezierCurveData": {"Anchors": [102, 205, 307, 410, 512, 614, 717, 819, 921], "KneePointX": 64,
                            "KneePointY": 64},
        "LuminanceParameters": {
            "AverageRGB": 1000,
            "LuminanceDistributions": {"DistributionIndex": [1, 5, 10, 25, 50, 75, 90, 95, 99],
                                       "DistributionValues": [0, 10, 50, 200, 400, 600, 800, 900, 1000]},
            "MaxScl": [4000, 4000, 4000],
        },
        "NumberOfWindows": 1, "TargetedSystemDisplayMaximumLuminance": 400, "SceneId": 0,
    }
    return {
        "JSONInfo": {"HDR10plusProfile": "B", "Version": "1.0"},
        "SceneInfo": [{**frame, "SceneFrameIndex": i, "SequenceFrameIndex": i} for i in range(frames)],
        "SceneInfoSummary": {"SceneFirstFrameIndex": [0], "SceneFrameNumbers": [frames]},
        "ToolInfo": {"Tool": "codec-lab", "Version": "1"},
    }


def encode_dovi(case, inputs, video, audio, out):
    """Dolby Vision: the HDR10 or HLG base layer, an RPU generated for every frame injected into it, and an MP4 whose
    sample entry and dvcC name the profile."""
    work = out.parent
    raw = work / "base.hevc"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, *video, "-t", SECONDS, "-f", "hevc", raw])
    frames = int(SECONDS * fps_value(case.video.fps))
    config = work / "dovi.json"
    config.write_text(json.dumps({
        "cm_version": "V40", "length": frames,
        "level6": {"max_display_mastering_luminance": 1000, "min_display_mastering_luminance": 50,
                   "max_content_light_level": 1000, "max_frame_average_light_level": 400},
    }))
    rpu = work / "rpu.bin"
    run([*tool("dovi_tool", "dovi-tool"), "generate", "-j", config, "-p", case.video.dovi, "-o", rpu])
    injected = work / "dv.hevc"
    run([*tool("dovi_tool", "dovi-tool"), "inject-rpu", "-i", raw, "--rpu-in", rpu, "-o", injected])
    profile = case.video.dovi.split(".")[0]
    compat = {"5": 0, "8.1": 1, "8.4": 4}[case.video.dovi]
    video_only = work / "dv.mp4"
    run([*tool("MP4Box", "gpac"), "-quiet", "-add",
         f"{injected}:fps={case.video.fps}:dvp={profile}.{compat}:dv-cm={'hdr10' if compat != 4 else 'hlg'}",
         "-new", video_only])
    if audio:
        tone = work / "audio.mka"
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, *[x.replace("1:a", "1:a") for x in audio],
             "-t", SECONDS, tone])
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video_only, "-i", tone, "-map", "0:v",
             "-map", "1:a", "-c", "copy", "-strict", "unofficial",
             "-tag:v", "dvh1" if profile == "5" else "hvc1", out.with_suffix(".mp4")])
        return out.with_suffix(".mp4")
    return video_only


# ---------------------------------------------------------------------------------------------------------------
# Codec strings, read from the MP4


def boxes(buf):
    i = 0
    while i + 8 <= len(buf):
        size, kind = struct.unpack(">I4s", buf[i:i + 8])
        head = 8
        if size == 1:
            size = struct.unpack(">Q", buf[i + 8:i + 16])[0]
            head = 16
        if size == 0:
            size = len(buf) - i
        yield kind.decode("latin1"), buf[i + head:i + size]
        i += size


def child(buf, *path):
    for name in path:
        buf = next((body for kind, body in boxes(buf) if kind == name), None)
        if buf is None:
            return None
    return buf


def sample_entries(mp4):
    moov = child(mp4, "moov")
    for kind, trak in boxes(moov or b""):
        if kind != "trak":
            continue
        handler = child(trak, "mdia", "hdlr")[8:12].decode("latin1")
        stsd = child(trak, "mdia", "minf", "stbl", "stsd")
        fourcc, entry = next(boxes(stsd[8:]))
        yield handler, fourcc, entry


def bits_reversed(value):
    return int(f"{value:032b}"[::-1], 2)


def hevc_string(fourcc, hvcc):
    space = ["", "A", "B", "C"][hvcc[1] >> 6]
    tier = "H" if hvcc[1] & 0x20 else "L"
    profile = hvcc[1] & 0x1F
    compat = bits_reversed(struct.unpack(">I", hvcc[2:6])[0])
    constraints = list(hvcc[6:12])
    while constraints and constraints[-1] == 0:
        constraints.pop()
    return f"{fourcc}.{space}{profile}.{compat:X}.{tier}{hvcc[12]}" + "".join(f".{c:X}" for c in constraints)


def av1_string(av1c, colr):
    b = av1c
    profile, level = b[1] >> 5, b[1] & 0x1F
    tier = "H" if b[2] & 0x80 else "M"
    depth = 12 if (b[2] & 0x40 and b[2] & 0x20) else 10 if b[2] & 0x40 else 8
    mono, sx, sy, pos = (b[2] >> 4) & 1, (b[2] >> 3) & 1, (b[2] >> 2) & 1, b[2] & 3
    s = f"av01.{profile}.{level:02d}{tier}.{depth:02d}"
    if colr and colr[:4] == b"nclx":
        cp, tc, mc = struct.unpack(">HHH", colr[4:10])
        full = colr[10] >> 7
        s += f".{mono}.{sx}{sy}{pos if (sx, sy) == (1, 1) else 0}.{cp:02d}.{tc:02d}.{mc:02d}.{full}"
    return s


def vp9_string(vpcc):
    b = vpcc[4:]
    profile, level, depth, chroma, full = b[0], b[1], b[2] >> 4, (b[2] >> 1) & 7, b[2] & 1
    cp, tc, mc = b[3], b[4], b[5]
    return f"vp09.{profile:02d}.{level:02d}.{depth:02d}.{chroma:02d}.{cp:02d}.{tc:02d}.{mc:02d}.{full:02d}"


def esds_config(esds):
    """The objectTypeIndication and the decoder-specific info from an esds box's descriptors."""
    data, i, oti, dsi = esds[4:], 0, None, None

    def length(j):
        n = 0
        for _ in range(4):
            byte = data[j]
            j += 1
            n = (n << 7) | (byte & 0x7F)
            if not byte & 0x80:
                break
        return n, j

    while i < len(data):
        tag = data[i]
        n, j = length(i + 1)
        if tag == 0x03:  # ES descriptor: id (2), flags (1), then nested descriptors
            i = j + 3
            continue
        if tag == 0x04:  # decoder config: OTI, then nested
            oti = data[j]
            i = j + 13
            continue
        if tag == 0x05:
            dsi = data[j:j + n]
        i = j + n
    return oti, dsi


def aac_object_type(dsi):
    aot = dsi[0] >> 3
    if aot == 31:
        aot = 32 + (((dsi[0] & 7) << 3) | (dsi[1] >> 5))
    return aot


def codec_strings(mp4_path):
    mp4 = mp4_path.read_bytes()
    video, audio = None, None
    for handler, fourcc, entry in sample_entries(mp4):
        if handler == "vide":
            kids = entry[78:]
            if fourcc in ("avc1", "avc3"):
                c = child(kids, "avcC")
                video = f"{fourcc}.{c[1]:02X}{c[2]:02X}{c[3]:02X}"
            elif fourcc in ("hvc1", "hev1", "dvh1", "dvhe"):
                video = hevc_string(fourcc if fourcc in ("hvc1", "hev1") else fourcc, child(kids, "hvcC"))
                dv = child(kids, "dvcC") or child(kids, "dvvC")
                if dv:
                    dv_profile, dv_level = (dv[2] >> 1) & 0x7F, ((dv[2] & 1) << 5) | (dv[3] >> 3)
                    dv_string = f"dvh1.{dv_profile:02d}.{dv_level:02d}"
                    if fourcc.startswith("dv"):
                        video = dv_string
                    else:
                        video = {"base": video, "dolby_vision": dv_string, "compat": dv[4] >> 4}
            elif fourcc == "av01":
                video = av1_string(child(kids, "av1C"), child(kids, "colr"))
            elif fourcc == "vp09":
                video = vp9_string(child(kids, "vpcC"))
            elif fourcc == "mp4v":
                oti, dsi = esds_config(child(kids, "esds"))
                video = f"mp4v.{oti:02x}" + (f".{dsi[4] if dsi and len(dsi) > 4 else 3}" if oti == 0x20 else "")
            else:
                video = fourcc
        elif handler == "soun":
            kids = entry[28:]
            if fourcc == "mp4a":
                oti, dsi = esds_config(child(kids, "esds"))
                audio = f"mp4a.{oti:02X}" + (f".{aac_object_type(dsi)}" if oti == 0x40 and dsi else "")
            elif fourcc == "Opus":
                audio = "opus"
            else:
                audio = fourcc
    return video, audio


# ---------------------------------------------------------------------------------------------------------------
# Packaging


def copy(src, dst, *extra):
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0", "-c", "copy", *extra, dst])


def video_range(v):
    return {16: "PQ", 18: "HLG"}.get(v.transfer, "SDR")


def master_playlist(case, codecs, bandwidth, media, *, bare=False, audio_group=True):
    v, a = case.video, case.audio
    video_codec = codecs["video"]
    supplemental = ""
    if isinstance(video_codec, dict):
        brand = {1: "db1p", 4: "db4h", 2: "db2g"}.get(video_codec["compat"], "")
        supplemental = f',SUPPLEMENTAL-CODECS="{video_codec["dolby_vision"]}/{brand}"'
        video_codec = video_codec["base"]
    names = [c for c in [video_codec, codecs.get("audio")] if c]
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    group = ""
    if a and a.channels > 2 and audio_group:
        lines.append(f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="{a.channels}"')
        group = ',AUDIO="audio"'
    subs = ""
    if case.subtitles == "webvtt":
        lines.append('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,'
                     'AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"')
        subs = ',SUBTITLES="subs"'
    attrs = f'BANDWIDTH={bandwidth},CODECS="{",".join(names)}"{supplemental}'
    if not bare:
        attrs += f",VIDEO-RANGE={video_range(v)}"
    attrs += f",RESOLUTION={v.size[0]}x{v.size[1]}"
    if not bare:
        attrs += f",FRAME-RATE={fps_value(v.fps):.3f}"
    lines += [f"#EXT-X-STREAM-INF:{attrs}{group}{subs}", media, ""]
    return "\n".join(lines)


WEBVTT = """WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000

00:00:00.500 --> 00:00:02.000
The first cue.

00:00:02.000 --> 00:00:03.800
The second cue.
"""

SRT = """1
00:00:00,500 --> 00:00:02,000
The first cue.

2
00:00:02,000 --> 00:00:03,800
The second cue.
"""

ASS = """[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,The {\\i1}first{\\i0} cue.
Dialogue: 0,0:00:02.00,0:00:03.80,Default,,0,0,0,,The second cue, in yellow.
"""


def package(case):
    work = WORK / case.id
    out = MEDIA / case.id
    shutil.rmtree(out, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True)
    encoded = encode(case, work / "encoded.mkv")

    # The codec strings come from an MP4 whenever the codec can go in one.
    probe = work / "probe.mp4"
    tag = ["-tag:v", "hev1"] if case.id.endswith("hev1") else ["-tag:v", "hvc1"] if case.video.encoder == "libx265" and not case.video.dovi else []
    codecs = {"video": None, "audio": None}
    try:
        if encoded.suffix == ".mp4":
            shutil.copy(encoded, probe)
        else:
            # Video and audio only: an MP4 refuses SubRip and ASS, and the codec strings are about the picture and sound.
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", encoded, "-map", "0:v", "-map", "0:a?",
                 "-c", "copy", *tag, "-strict", "unofficial", probe])
        codecs["video"], codecs["audio"] = codec_strings(probe)
    except subprocess.CalledProcessError:
        # Audio MP4 won't carry (TrueHD): the video's string from a video-only MP4.
        video_probe = work / "probe-video.mp4"
        try:
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", encoded, "-map", "0:v", "-c", "copy", *tag,
                 "-strict", "unofficial", video_probe])
            codecs["video"], _ = codec_strings(video_probe)
        except subprocess.CalledProcessError:
            pass
    if case.audio and case.audio.encoder == "libvorbis":
        # ffmpeg's MP4 muxer takes Vorbis under a private object type (mp4a.DD) no player asks about.
        codecs["audio"] = "vorbis"
    if case.audio and case.audio.encoder == "aac_at" and probe.exists():
        # AudioToolbox signals SBR and PS implicitly, so the esds names plain AAC-LC; the stream itself says HE-AAC,
        # and 40.5 or 40.29 is what a player is told for it.
        profile = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=profile", "-of", "csv=p=0",
             str(probe)], capture_output=True, text=True).stdout.strip()
        codecs["audio"] = {"HE-AAC": "mp4a.40.5", "HE-AACv2": "mp4a.40.29"}.get(profile, codecs["audio"])
    fallback_names = {"libvpx": "vp8", "libtheora": "theora", "libvorbis": "vorbis", "mpeg2video": "mp2v", "mp2": "mp4a.69",
                      "truehd": "mlpa", "dca": "dtsc", "pcm_s16le": "lpcm", "prores_ks": "apcn"}
    if not codecs["video"]:
        codecs["video"] = fallback_names.get(case.video.encoder, case.video.encoder)
    if case.audio and not codecs["audio"]:
        codecs["audio"] = fallback_names.get(case.audio.encoder, case.audio.encoder)

    size = encoded.stat().st_size
    bandwidth = int(size * 8 / SECONDS * 1.3)
    formats = []
    for fmt in case.formats:
        try:
            entry = package_format(case, fmt, encoded, probe, out, tag, codecs, bandwidth)
        except subprocess.CalledProcessError as e:
            print(f"  ! {case.id} {fmt}: {e}", flush=True)
            entry = {"format": fmt, "unavailable": "the muxer refused this combination"}
        formats.append(entry)
    return {
        "id": case.id, "group": case.group, "title": case.title, "note": case.note,
        "codecs": codecs, "video_range": video_range(case.video),
        "width": case.video.size[0], "height": case.video.size[1], "fps": round(fps_value(case.video.fps), 3),
        "audio_channels": case.audio.channels if case.audio else 0,
        "subtitles": case.subtitles, "formats": formats,
    }


def mime_codecs(codecs):
    video = codecs["video"]
    if isinstance(video, dict):
        video = video["base"]
    return ",".join(c for c in [video, codecs.get("audio")] if c)


def package_format(case, fmt, encoded, probe, out, tag, codecs, bandwidth):
    names = mime_codecs(codecs)
    if fmt == "mp4":
        dst = out / "clip.mp4"
        if case.subtitles == "mov_text":
            copy(encoded, dst, *tag, "-c:s", "mov_text", "-movflags", "+faststart", "-strict", "unofficial")
        else:
            copy(probe if probe.exists() else encoded, dst, "-movflags", "+faststart", "-strict", "unofficial")
        entry = {"format": fmt, "url": f"media/{case.id}/clip.mp4", "mime": f'video/mp4; codecs="{names}"'}
        if case.subtitles == "webvtt":
            (out / "subs.vtt").write_text(WEBVTT.replace("X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n", ""))
            entry["track"] = f"media/{case.id}/subs.vtt"
        if case.subtitles == "srt-sidecar":
            (out / "subs.srt").write_text(SRT)
            entry["track"] = f"media/{case.id}/subs.srt"
        return entry
    if fmt == "dash":
        folder = out / "dash"
        folder.mkdir(exist_ok=True)
        source = probe if probe.exists() else encoded
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", "0:v", "-map", "0:a?", "-c", "copy",
             *tag, "-strict", "unofficial", "-f", "dash", "-seg_duration", "2", "-use_template", "1",
             "-use_timeline", "1", "-init_seg_name", "init-$RepresentationID$.m4s",
             "-media_seg_name", "seg-$RepresentationID$-$Number%03d$.m4s", folder / "manifest.mpd"])
        # ffmpeg's DASH muxer names an HEVC or AV1 representation by its fourcc alone (codecs="hvc1"), which tells a
        # player nothing about profile, depth or HDR: the strings read from the file go in instead.
        manifest = folder / "manifest.mpd"
        video_codec = codecs["video"]["base"] if isinstance(codecs["video"], dict) else codecs["video"]
        text = manifest.read_text()
        text = re.sub(r'(mimeType="video/mp4" codecs=")[^"]*"', lambda m: f'{m.group(1)}{video_codec}"', text)
        if codecs.get("audio"):
            text = re.sub(r'(mimeType="audio/mp4" codecs=")[^"]*"', lambda m: f'{m.group(1)}{codecs["audio"]}"', text)
        manifest.write_text(text)
        return {"format": fmt, "url": f"media/{case.id}/dash/manifest.mpd", "mime": "application/dash+xml"}
    if fmt in ("hls-fmp4", "hls-ts", "hls-fmp4-bare"):
        sub = {"hls-fmp4": "hls", "hls-ts": "ts", "hls-fmp4-bare": "hls"}[fmt]
        folder = out / sub
        folder.mkdir(exist_ok=True)
        if fmt != "hls-fmp4-bare":
            seg = ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"] if fmt != "hls-ts" else []
            source = probe if (fmt != "hls-ts" and probe.exists()) else encoded
            ts_tag = [] if fmt == "hls-ts" else tag
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", "0", "-c", "copy", *ts_tag,
                 "-strict", "unofficial", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", *seg,
                 "-hls_segment_filename", str(folder / ("seg%d.m4s" if fmt != "hls-ts" else "seg%d.ts")),
                 folder / "media.m3u8"])
            if case.subtitles == "webvtt":
                (folder / "subs.vtt").write_text(WEBVTT)
                (folder / "subs.m3u8").write_text(
                    f"#EXTM3U\n#EXT-X-TARGETDURATION:{SECONDS}\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:0\n"
                    f"#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:{SECONDS}.0,\nsubs.vtt\n#EXT-X-ENDLIST\n")
        name = "master-bare.m3u8" if fmt == "hls-fmp4-bare" else "master.m3u8"
        (folder / name).write_text(master_playlist(case, codecs, bandwidth, "media.m3u8", bare=fmt == "hls-fmp4-bare"))
        return {"format": fmt, "url": f"media/{case.id}/{sub}/{name}", "mime": "application/vnd.apple.mpegurl"}
    extension, mime = {"webm": ("webm", "video/webm"), "mkv": ("mkv", "video/x-matroska"), "ogg": ("ogv", "video/ogg"),
                       "mov": ("mov", "video/quicktime"), "avi": ("avi", "video/x-msvideo"), "ts": ("ts", "video/mp2t"),
                       "m2ts": ("m2ts", "video/mp2t"), "flv": ("flv", "video/x-flv")}[fmt]
    dst = out / f"clip.{extension}"
    if fmt in ("avi", "ts", "m2ts", "flv"):
        muxer = {"ts": ["-f", "mpegts"], "m2ts": ["-f", "mpegts", "-mpegts_m2ts_mode", "1"]}.get(fmt, [])
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", encoded, "-map", "0:v", "-map", "0:a?",
             "-c", "copy", *muxer, dst])
    else:
        copy(encoded, dst, *(["-strict", "unofficial"] if fmt != "webm" else []))
    short = {"libvpx-vp9": "vp9", "libvpx": "vp8", "libtheora": "theora", "libsvtav1": codecs["video"],
             "libaom-av1": codecs["video"]}
    audio_short = {"libopus": "opus", "libvorbis": "vorbis", "flac": "flac"}
    parts = [short.get(case.video.encoder, codecs["video"] if isinstance(codecs["video"], str) else None)]
    if case.audio:
        parts.append(audio_short.get(case.audio.encoder, codecs.get("audio")))
    return {"format": fmt, "url": f"media/{case.id}/clip.{extension}",
            "mime": f'{mime}; codecs="{",".join(p for p in parts if p)}"'}


def main():
    wanted = sys.argv[1:]
    MEDIA.mkdir(parents=True, exist_ok=True)
    manifest = DOCS / "cases.json"
    existing = {c["id"]: c for c in json.loads(manifest.read_text())["cases"]} if manifest.exists() else {}
    for case in CASES:
        if wanted and not any(case.id.startswith(w) for w in wanted):
            continue
        print(f"== {case.id}", flush=True)
        try:
            existing[case.id] = package(case)
        except subprocess.CalledProcessError as e:
            print(f"  ! {case.id} failed: {e}", flush=True)
    order = [c.id for c in CASES]
    cases = [existing[i] for i in order if i in existing]
    manifest.write_text(json.dumps({"seconds": SECONDS, "cases": cases}, indent=1) + "\n")
    print(f"{len(cases)} cases in {manifest}")


if __name__ == "__main__":
    main()
