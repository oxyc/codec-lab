// Codec Lab: asks this browser what it claims for each clip's codecs, then plays the clips — one reference test each
// ("codecs"), every container and player ("delivery"), or both — and lays the results out as a matrix of case against
// delivery. One <video> element is reused throughout: a browser that allowed it to play once, on the tap that started
// the run, lets it play again.
'use strict';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const video = $('player');
const TIMEOUT_MS = 20000;
const FRAMES_TO_PASS = 15;
// How far past its first frame a clip must play: to the end of a short clip, six seconds of a long stream.
const PLAY_SECONDS = 6;
// Den Web's own hls.js settings (den-edge's Player.svelte), so what plays here plays there.
const HLS_CONFIG = { enableWorker: false };
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
// Cases about how media is delivered rather than which codec it is in: they have no single reference test.
const DELIVERY_GROUPS = new Set(['delivery', 'gop', 'containers']);

// The matrix's delivery columns, and which player each takes.
const COLUMNS = [
  { key: 'file', label: 'File', method: 'file' },
  { key: 'native', label: 'HLS · native player', method: 'native' },
  { key: 'hlsjs', label: 'HLS · hls.js', method: 'hls.js' },
  { key: 'dash', label: 'DASH · dash.js', method: 'dash.js' },
];
const FORMAT_LABEL = {
  'hls-fmp4': 'fMP4', 'hls-ts': 'TS', 'hls-fmp4-bare': 'no range or fps', 'hls-fmp4-no-range': 'no VIDEO-RANGE',
  'hls-fmp4-no-fps': 'no FRAME-RATE', 'hls-fmp4-start': 'from mid-clip', 'hls-denremux': 'den-remux',
  dash: 'manifest',
};
const formatLabel = (f) => FORMAT_LABEL[f] || f.replace(/^hls-slow-(init|seg1)-(\d+)$/, (_, what, s) => `${what === 'init' ? 'init' : 'segment 1'} +${s}s`);

const report = { lab: 'codec-lab', started: new Date().toISOString(), env: {}, capability: {}, playback: [] };
let cases = [];
let stopping = false;

// ---------------------------------------------------------------------------------------------------------------
// Environment

async function environment() {
  const env = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    ios: IOS,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    dynamicRangeHigh: matchMedia('(dynamic-range: high)').matches,
    videoDynamicRangeHigh: matchMedia('(video-dynamic-range: high)').matches,
    colorGamut: ['rec2020', 'p3', 'srgb'].find((g) => matchMedia(`(color-gamut: ${g})`).matches) || 'unknown',
    mediaSource: 'MediaSource' in window,
    managedMediaSource: 'ManagedMediaSource' in window,
    nativeHls: video.canPlayType('application/vnd.apple.mpegurl') || '',
    hlsJs: typeof Hls !== 'undefined' && Hls.isSupported(),
    hlsJsVersion: typeof Hls !== 'undefined' ? Hls.version : null,
    dashJs: typeof dashjs !== 'undefined' && !!(window.MediaSource || window.ManagedMediaSource),
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  };
  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      env.userAgentData = await navigator.userAgentData.getHighEntropyValues(
        ['platform', 'platformVersion', 'architecture', 'model', 'fullVersionList'],
      );
    } catch { /* not granted */ }
  }
  // Brave hides itself behind Chrome's UA; it says so here.
  if (navigator.brave?.isBrave) {
    try { env.brave = await navigator.brave.isBrave(); } catch { env.brave = true; }
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    env.gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
  } catch { env.gpu = null; }
  env.serviceWorker = await serviceWorker();
  return env;
}

/** The service worker that slows the slow-delivery cases down: registered, and controlling this page. */
async function serviceWorker() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    }
    return !!navigator.serviceWorker.controller;
  } catch {
    return false;
  }
}

function browserName(env) {
  const ua = env.userAgent;
  if (env.brave) return /iPhone|iPad/.test(ua) ? 'Brave (iOS)' : 'Brave';
  if (/CriOS/.test(ua)) return 'Chrome (iOS)';
  if (/FxiOS/.test(ua)) return 'Firefox (iOS)';
  if (/EdgiOS|Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return env.ios ? 'Safari (iOS/iPadOS)' : 'Safari';
  return 'Unknown';
}

function showEnvironment(env) {
  const rows = [
    ['Browser', browserName(env)],
    ['User agent', env.userAgent],
    ['Screen', `${env.screen}, HDR ${env.dynamicRangeHigh ? 'yes' : 'no'}, gamut ${env.colorGamut}`],
    ['GPU', env.gpu || 'not reported'],
    ['Players', [
      env.nativeHls ? `native HLS (${env.nativeHls})` : 'no native HLS',
      env.mediaSource ? 'MSE' : env.managedMediaSource ? 'ManagedMediaSource' : 'no MSE',
      env.hlsJs ? `hls.js ${env.hlsJsVersion}` : 'no hls.js',
      env.dashJs ? 'dash.js' : 'no dash.js',
      env.serviceWorker ? 'service worker' : 'no service worker (slow cases unmeasured)',
    ].join(' · ')],
  ];
  $('env').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// What the browser says

const TRANSFER = { PQ: 'pq', HLG: 'hlg', SDR: 'srgb' };

function videoString(c) {
  const v = c.codecs.video;
  return !v || typeof v === 'string' ? v : v.base;
}

async function decodingInfo(config) {
  if (!navigator.mediaCapabilities?.decodingInfo) return null;
  try {
    const r = await navigator.mediaCapabilities.decodingInfo(config);
    return { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
  } catch (e) {
    return { error: String(e.name || e) };
  }
}

function mseSupports(type) {
  const MS = window.MediaSource || window.ManagedMediaSource;
  return MS ? MS.isTypeSupported(type) : null;
}

async function probe(c) {
  const out = {};
  const file = c.formats.find((f) => f.mime && !f.mime.startsWith('application/'));
  const container = file ? file.mime.split(';')[0].replace('audio/', 'video/') : 'video/mp4';
  const vstr = videoString(c);
  if (vstr) {
    const type = `${container}; codecs="${[vstr, c.codecs.audio].filter(Boolean).join(',')}"`;
    out.type = type;
    out.canPlayType = video.canPlayType(type);
    out.mse = mseSupports(type);
    const videoConfig = {
      contentType: `${container}; codecs="${vstr}"`,
      width: c.width || 1920, height: c.height || 1080, bitrate: 4_000_000, framerate: c.fps || 30,
      transferFunction: TRANSFER[c.video_range], colorGamut: c.video_range === 'SDR' ? 'srgb' : 'rec2020',
    };
    if (c.video_range === 'PQ') videoConfig.hdrMetadataType = 'smpteSt2086';
    out.mediaCapabilities = {
      file: await decodingInfo({ type: 'file', video: videoConfig }),
      mediaSource: await decodingInfo({ type: 'media-source', video: videoConfig }),
    };
  }
  if (c.codecs.audio) {
    const audioType = `${container.replace('video/', 'audio/')}; codecs="${c.codecs.audio}"`;
    const audio = { contentType: audioType, channels: c.spatial ? '16/JOC' : String(c.audio_channels || 2), bitrate: 256000, samplerate: 48000 };
    if (c.spatial) audio.spatialRendering = true;
    out.audio = {
      type: audioType,
      canPlayType: video.canPlayType(audioType),
      mse: mseSupports(audioType),
      mediaCapabilities: await decodingInfo({ type: 'media-source', audio }),
    };
  }
  if (c.codecs.video && typeof c.codecs.video === 'object') {
    const dv = `video/mp4; codecs="${c.codecs.video.dolby_vision}"`;
    out.dolbyVision = { type: dv, canPlayType: video.canPlayType(dv), mse: mseSupports(dv) };
  }
  return out;
}

// Codec strings with no clip here, asked about all the same.
const EXTRA_TYPES = [
  'video/mp4; codecs="dvh1.05.06"', 'video/mp4; codecs="dvh1.08.06"', 'video/mp4; codecs="dvav.09.05"',
  'video/mp4; codecs="dav1.10.06"', 'video/mp4; codecs="vvc1.1.L123.CQA.O1+3"', 'video/mp4; codecs="evc1"',
  'video/mp4; codecs="apv1"', 'audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="ac-4.02.01.01"',
  'audio/mp4; codecs="mp4a.40.42"', 'audio/mp4; codecs="mp4a.40.39"', 'audio/mp4; codecs="mhm1.0x0D"',
  'audio/mp4; codecs="dtsx"', 'audio/mp4; codecs="dtse"', 'audio/mp4; codecs="iamf.001.001.Opus"',
  'audio/mp4; codecs="apac"', 'audio/mp4; codecs="mlpa"', 'audio/mp4; codecs="alac"', 'audio/x-caf', 'audio/flac',
  'audio/wav', 'audio/ogg; codecs="opus"',
];

// ---------------------------------------------------------------------------------------------------------------
// What the browser plays

function methodsFor(format, env) {
  // No browser plays DASH on its own; dash.js needs Media Source Extensions.
  if (format.format === 'dash') return [env.dashJs ? 'dash.js' : '-dash.js'];
  if (format.format.startsWith('hls')) {
    return [env.nativeHls ? 'native' : '-native', env.hlsJs ? 'hls.js' : '-hls.js'];
  }
  return ['file'];
}

/** A case's one reference test: the plainest way this browser can play it. */
function reference(c, env) {
  const order = ['mp4', 'webm', 'mkv', 'mov', 'ogg', 'hls-fmp4', 'hls-ts', 'dash', 'avi', 'ts', 'm2ts', 'flv'];
  for (const name of order) {
    const format = c.formats.find((f) => f.format === name && !f.unavailable);
    const method = format && methodsFor(format, env).find((m) => !m.startsWith('-'));
    if (method) return [format, method];
  }
  return null;
}

let audioProbe = null;

/** A way to tell audio was decoded. WebKit and Chromium count decoded bytes; elsewhere an analyser listens, routed
 *  nowhere, so the element plays unmuted in silence. */
function setUpAudioProbe() {
  if ('webkitAudioDecodedByteCount' in video) {
    audioProbe = { kind: 'bytes' };
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    audioProbe = { kind: 'none' };
    return;
  }
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaElementSource(video).connect(analyser);
  audioProbe = { kind: 'analyser', ctx, analyser, buf: new Float32Array(analyser.fftSize) };
}

function audioHeard() {
  if (!audioProbe) return null;
  if (audioProbe.kind === 'bytes') return video.webkitAudioDecodedByteCount > 0;
  if (audioProbe.kind === 'analyser') {
    audioProbe.analyser.getFloatTimeDomainData(audioProbe.buf);
    return audioProbe.buf.some((s) => Math.abs(s) > 0.001);
  }
  return null;
}

// Neither probe hears every way of playing: WebKit on iOS routes HLS, Media Source and WebM around the analyser, and
// a decoded-byte counter may count only file playback. Each way is first tried on a clip whose AAC or Opus every
// browser playing that way decodes, and one that comes through silent reports audio as unmeasured, not missing.
const pathOf = (format, method) => (method === 'file' && format.format === 'webm' ? 'file-webm' : method);
const CALIBRATION = {
  file: ['audio-aac-lc-20', 'mp4'], 'file-webm': ['audio-opus-20-webm', 'webm'], native: ['audio-aac-lc-20', 'hls-fmp4'],
  'hls.js': ['audio-aac-lc-20', 'hls-fmp4'], 'dash.js': ['h264-high-40', 'dash'],
};
let deaf = new Set();

async function calibrateAudio(steps) {
  deaf = new Set();
  if (!audioProbe || audioProbe.kind === 'none') return;
  const paths = new Set(steps.filter(([, f, m]) => f && !m.startsWith('-')).map(([, f, m]) => pathOf(f, m)));
  for (const path of paths) {
    const [id, name] = CALIBRATION[path] || [];
    const c = cases.find((x) => x.id === id);
    const f = c?.formats.find((x) => x.format === name);
    if (!f) continue;
    $('now').textContent = `Checking audio can be heard: ${c.id} · ${formatLabel(f.format)} · ${path}`;
    const r = await play(c, f, path === 'file-webm' ? 'file' : path);
    if (r.result === 'played' && r.audio === false) deaf.add(path);
  }
  report.audioUnmeasurable = [...deaf];
}

let hls = null;
let dash = null;
let held = [];

navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.lab === 'held') held.push(event.data.name);
});

function reset() {
  if (hls) { hls.destroy(); hls = null; }
  if (dash) { dash.reset(); dash = null; }
  video.pause();
  for (const t of [...video.querySelectorAll('track')]) t.remove();
  video.removeAttribute('src');
  video.load();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const visible = () => new Promise((resolve) => {
  const onChange = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', onChange);
    resolve();
  };
  document.addEventListener('visibilitychange', onChange);
});

function frameCount(result) {
  return 'requestVideoFrameCallback' in video ? result.frames : (video.getVideoPlaybackQuality?.().totalVideoFrames || 0);
}

function cuesLoaded() {
  return [...video.textTracks].some((t) => t.cues && t.cues.length > 0);
}

/** Seek to `time` and wait for `seeked` and fresh frames. */
async function seekTo(result, time, timeoutMs = 8000) {
  const before = frameCount(result);
  const started = performance.now();
  let seeked = false;
  const onSeeked = () => { seeked = true; };
  video.addEventListener('seeked', onSeeked, { once: true });
  video.currentTime = time;
  while (performance.now() - started < timeoutMs) {
    if (seeked && frameCount(result) >= before + 5 && Math.abs(video.currentTime - time) < 3) {
      return { to: Math.round(time * 10) / 10, ok: true, ms: Math.round(performance.now() - started) };
    }
    if (video.error) break;
    await sleep(100);
  }
  video.removeEventListener('seeked', onSeeked);
  return { to: Math.round(time * 10) / 10, ok: false, ms: Math.round(performance.now() - started) };
}

async function play(c, format, method) {
  reset();
  held = [];
  const started = performance.now();
  const audioOnly = !c.codecs.video;
  const unheard = deaf.has(pathOf(format, method));
  const result = {
    case: c.id, format: format.format, method, url: format.url, result: 'stalled',
    width: 0, height: 0, frames: 0, time: 0, ttffMs: null, droppedPct: null, reachedEnd: false,
    audio: c.codecs.audio ? null : undefined, subtitles: c.subtitles ? false : undefined,
    unmuted: null, error: null, ms: 0,
  };
  let frameHandle = null;
  let failure = null;
  // A hidden tab stops drawing video and throttles timers, so a test that was hidden at any point measured nothing.
  let hidden = document.hidden;
  const onVisibility = () => { if (document.hidden) hidden = true; };
  document.addEventListener('visibilitychange', onVisibility);
  // The playback-quality counters are not reset by every browser between sources: dropped frames are counted from here.
  const qualityBefore = video.getVideoPlaybackQuality?.();
  const onFrame = (now, meta) => {
    result.frames += 1;
    if (result.ttffMs === null) {
      result.ttffMs = Math.round(performance.now() - started);
      result.startedAt = Math.round((meta?.mediaTime ?? video.currentTime) * 10) / 10;
    }
    frameHandle = video.requestVideoFrameCallback(onFrame);
  };
  if ('requestVideoFrameCallback' in video) frameHandle = video.requestVideoFrameCallback(onFrame);
  video.onerror = () => {
    const e = video.error;
    failure = e ? { code: e.code, message: e.message || '' } : { message: 'error event' };
  };
  video.onplaying = () => {
    if (result.ttffMs === null && !('requestVideoFrameCallback' in video)) {
      result.ttffMs = Math.round(performance.now() - started);
      result.startedAt = Math.round(video.currentTime * 10) / 10;
    }
  };
  // Safari adds a native HLS stream's subtitle tracks after its metadata; each is set to load cues as it arrives.
  video.textTracks.onaddtrack = (event) => { event.track.mode = 'hidden'; };

  if (method === 'hls.js') {
    hls = new Hls({ ...HLS_CONFIG });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) failure = { hls: data.type, details: data.details, reason: String(data.reason || data.error || '') };
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (c.subtitles === 'webvtt') hls.subtitleTrack = 0; });
    hls.loadSource(format.url);
    hls.attachMedia(video);
  } else if (method === 'dash.js') {
    dash = dashjs.MediaPlayer().create();
    dash.updateSettings({ debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE } });
    dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      failure = { dash: e.error?.code ?? null, message: String(e.error?.message || e.error || '') };
    });
    dash.initialize(video, format.url, false);
  } else {
    if (format.track) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = 'en';
      track.src = format.track;
      track.default = true;
      video.appendChild(track);
    }
    video.src = format.url;
  }

  // Den plays with sound, so the lab does too where it can: unmuted at volume 0. iOS ignores volume, so it stays
  // muted there; a browser that refuses unmuted playback is retried muted, and the result says so.
  const muted = IOS;
  video.muted = muted;
  video.volume = muted ? 1 : 0;
  if (audioProbe?.kind === 'analyser') { video.muted = false; video.volume = 1; }
  // play()'s promise waits for the media to load, which may be never: the deadline below has to keep running.
  const playing = (promise) => Promise.race([promise, sleep(TIMEOUT_MS + (format.delay || 0) * 1000)]);
  try {
    await playing(video.play());
    result.unmuted = !video.muted;
  } catch (e) {
    if (e.name === 'NotAllowedError' && !video.muted) {
      video.muted = true;
      try {
        await playing(video.play());
        result.unmuted = false;
      } catch (again) {
        failure = { message: 'autoplay refused: tap Run again' };
        result.result = 'blocked';
      }
    } else if (e.name === 'NotAllowedError') {
      failure = { message: 'autoplay refused: tap Run again' };
      result.result = 'blocked';
    }
  }

  // Play: to the end of a short clip, or PLAY_SECONDS past the first frame of a long one.
  const deadline = started + TIMEOUT_MS + (format.delay || 0) * 1000;
  let heard = false;
  while (!failure && !hidden && performance.now() < deadline && result.result !== 'blocked') {
    if (c.codecs.audio && !heard) heard = audioHeard() === true;
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    if (video.ended) { result.reachedEnd = true; break; }
    if (audioOnly) {
      if ((heard || unheard) && video.currentTime >= Math.min(duration - 0.3, 1)) break;
    } else if (result.ttffMs !== null) {
      const from = result.startedAt ?? 0;
      const target = Math.min(duration - 0.3, from + PLAY_SECONDS);
      if (video.currentTime >= target) { result.reachedEnd = target >= duration - 0.3; break; }
    }
    await sleep(200);
  }
  if (c.codecs.audio) heard = heard || audioHeard() === true;
  const frames = frameCount(result);
  const moved = video.currentTime - (result.startedAt ?? 0);
  const playedPicture = audioOnly || (video.videoWidth > 0 && frames >= FRAMES_TO_PASS && moved >= Math.min(1.5, PLAY_SECONDS));
  const playedSound = !audioOnly || heard || ((audioProbe?.kind === 'none' || unheard) && video.currentTime >= 1);

  if (result.result !== 'blocked') {
    if (failure) result.result = 'failed';
    else if (playedPicture && playedSound) result.result = 'played';
    else result.result = 'stalled';
  }
  // A seek into what isn't buffered yet, then back: Den's resumes and seeks depend on both.
  if (result.result === 'played' && !audioOnly && Number.isFinite(video.duration) && video.duration > 5) {
    const back = format.start ? Math.max(0.5, format.start - 20) : 0.5;
    result.seek = [await seekTo(result, video.duration * 0.8), await seekTo(result, back)];
  }
  if (format.start !== undefined && result.startedAt !== undefined) {
    result.expectedStart = format.start;
    result.startHonoured = Math.abs(result.startedAt - format.start) < 1.5;
  }
  if (format.delay) {
    result.delayApplied = held.length > 0;
    if (!result.delayApplied) result.result = 'unmeasured';
  }

  if (frameHandle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
  result.error = failure;
  result.width = video.videoWidth;
  result.height = video.videoHeight;
  result.frames = frames;
  result.time = Math.round(video.currentTime * 100) / 100;
  const quality = video.getVideoPlaybackQuality?.();
  if (quality) {
    const since = qualityBefore && quality.totalVideoFrames >= qualityBefore.totalVideoFrames ? qualityBefore : null;
    const total = quality.totalVideoFrames - (since?.totalVideoFrames || 0);
    const dropped = quality.droppedVideoFrames - (since?.droppedVideoFrames || 0);
    if (total > 0) result.droppedPct = Math.round((dropped / total) * 1000) / 10;
  }
  if (c.codecs.audio) result.audio = heard || (unheard ? null : false);
  if (c.subtitles) {
    result.subtitles = cuesLoaded();
    const first = [...video.textTracks].flatMap((t) => [...(t.cues || [])]).sort((a, b) => a.startTime - b.startTime)[0];
    // Every generated subtitle's first cue starts at 0.5 s.
    if (first) result.cueStart = Math.round(first.startTime * 100) / 100;
  }
  result.ms = Math.round(performance.now() - started);
  document.removeEventListener('visibilitychange', onVisibility);
  if (hidden) result.result = 'interrupted';
  reset();
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// The matrix

function chip(text, cls, title) {
  const span = document.createElement('span');
  span.className = `chip ${cls}`;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

function saysChips(p) {
  const spans = [];
  if (p.canPlayType !== undefined) spans.push(chip(`type ${p.canPlayType || 'no'}`, p.canPlayType ? 'ok' : 'bad', p.type));
  if (p.mse !== undefined && p.mse !== null) spans.push(chip(`MSE ${p.mse ? '✓' : '✗'}`, p.mse ? 'ok' : 'bad'));
  const mc = p.mediaCapabilities?.mediaSource || p.mediaCapabilities?.file;
  if (mc && !mc.error) {
    const extra = mc.supported ? [mc.smooth ? 'smooth' : 'not smooth', mc.powerEfficient ? 'hardware' : 'software'].join(', ') : '';
    spans.push(chip(`MC ${mc.supported ? (mc.powerEfficient ? '✓ hw' : '✓ sw') : '✗'}`, mc.supported ? 'ok' : 'bad', extra));
  }
  if (p.audio) {
    const amc = p.audio.mediaCapabilities;
    const ok = p.audio.canPlayType || amc?.supported;
    spans.push(chip(`audio ${p.audio.canPlayType || (amc?.supported ? 'MC ✓' : 'no')}`, ok ? 'ok' : 'bad', p.audio.type));
  }
  if (p.dolbyVision) {
    spans.push(chip(`DV ${p.dolbyVision.canPlayType || 'no'}`, p.dolbyVision.canPlayType ? 'ok' : 'bad', p.dolbyVision.type));
  }
  return spans;
}

/** A result's shortfalls short of failing: each makes it "partly". */
function shortfalls(r) {
  return [
    r.audio === false && 'no audio decoded',
    r.subtitles === false && 'no cues',
    r.cueStart !== undefined && Math.abs(r.cueStart - 0.5) > 0.2 && `first cue at ${r.cueStart}s, not 0.5s`,
    r.seek && r.seek.some((s) => !s.ok) && 'a seek did not recover',
    r.startHonoured === false && `started at ${r.startedAt}s, not ${r.expectedStart}s`,
    r.droppedPct > 5 && `${r.droppedPct}% frames dropped`,
    r.unmuted === false && 'played only muted',
  ].filter(Boolean);
}

function playChip(r) {
  const label = formatLabel(r.format);
  if (r.result === 'unavailable') return chip(`${label} –`, 'na', 'not available in this browser');
  if (r.result === 'unmeasured') return chip(`${label} ?`, 'na', 'the service worker never saw the request, so nothing was held back');
  const partly = r.result === 'played' ? shortfalls(r) : [];
  const cls = r.result === 'played' ? (partly.length ? 'part' : 'ok') : 'bad';
  const mark = r.result === 'played' ? (partly.length ? '~' : '✓') : '✗';
  const detail = [
    `${r.result} in ${r.ms} ms`, r.ttffMs !== null ? `first frame ${r.ttffMs} ms` : '', `${r.width}×${r.height}`,
    `${r.frames} frames`, ...partly, r.audio === null ? 'audio not measurable this way' : '',
    r.error ? JSON.stringify(r.error) : '',
  ].filter(Boolean).join(' · ');
  return chip(`${label} ${mark}`, cls, detail);
}

function cell(c, key) {
  return row(c).querySelector(`td[data-col="${key}"] .chips`);
}

function row(c) {
  let tr = document.getElementById(`row-${c.id}`);
  if (!tr) {
    tr = document.createElement('tr');
    tr.id = `row-${c.id}`;
    tr.dataset.group = c.group;
    tr.innerHTML = '<th scope="row" class="title"></th><td class="codecs"></td><td data-col="says"><div class="chips"></div></td>'
      + COLUMNS.map((col) => `<td data-col="${col.key}"><div class="chips"></div></td>`).join('');
    tr.querySelector('.title').textContent = c.title;
    if (c.note) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = c.note;
      tr.querySelector('.title').appendChild(note);
    }
    const v = c.codecs.video;
    tr.querySelector('.codecs').textContent = [
      !v || typeof v === 'string' ? v : `${v.base} + ${v.dolby_vision}`, c.codecs.audio,
    ].filter(Boolean).join(', ');
  }
  return tr;
}

function buildTable() {
  const head = $('results').tHead.rows[0];
  head.replaceChildren(...['Case', 'Codecs', 'Says', ...COLUMNS.map((col) => col.label)].map((label) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    return th;
  }));
  const body = $('results').tBodies[0];
  body.replaceChildren();
  let group = null;
  for (const c of cases) {
    if (c.group !== group) {
      group = c.group;
      const g = document.createElement('tr');
      g.className = 'group';
      g.dataset.group = group;
      g.innerHTML = `<td colspan="${3 + COLUMNS.length}"></td>`;
      g.firstChild.textContent = group;
      body.appendChild(g);
    }
    body.appendChild(row(c));
  }
}

function buildGroups() {
  const groups = [...new Set(cases.map((c) => c.group))];
  const wanted = params.get('groups')?.split(',');
  for (const g of groups) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = g;
    box.checked = !wanted || wanted.includes(g);
    box.addEventListener('change', applyFilters);
    label.append(box, ` ${g}`);
    $('groups').appendChild(label);
  }
  const mode = params.get('mode');
  if (mode) for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === mode;
  for (const input of document.querySelectorAll('input[name="mode"]')) input.addEventListener('change', applyFilters);
  applyFilters();
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'codecs';
}

/** Whether a case belongs in the chosen mode and groups. */
function included(c) {
  const groups = new Set([...$('groups').querySelectorAll('input:checked')].map((i) => i.value));
  const mode = currentMode();
  if (!groups.has(c.group)) return false;
  if (mode === 'codecs') return !DELIVERY_GROUPS.has(c.group);
  if (mode === 'delivery') return DELIVERY_GROUPS.has(c.group);
  return true;
}

function applyFilters() {
  const shown = new Set(cases.filter(included).map((c) => c.group));
  for (const c of cases) row(c).hidden = !included(c);
  for (const g of $('results').tBodies[0].querySelectorAll('tr.group')) g.hidden = !shown.has(g.dataset.group);
}

// ---------------------------------------------------------------------------------------------------------------
// Running

async function runProbe() {
  for (const c of cases) {
    const p = await probe(c);
    report.capability[c.id] = p;
    cell(c, 'says').replaceChildren(...saysChips(p));
    if (c.probe_only) for (const col of COLUMNS) cell(c, col.key).replaceChildren(chip('asked about only', 'na'));
  }
  report.extraTypes = Object.fromEntries(EXTRA_TYPES.map((t) => [t, { canPlayType: video.canPlayType(t), mse: mseSupports(t) }]));
}

function plan() {
  const mode = currentMode();
  const steps = [];
  for (const c of cases) {
    if (!included(c) || c.probe_only) continue;
    if (mode === 'codecs') {
      const ref = reference(c, report.env);
      steps.push(ref ? [c, ...ref] : [c, null, '-none']);
      continue;
    }
    for (const f of c.formats) {
      if (f.unavailable) continue;
      for (const m of methodsFor(f, report.env)) steps.push([c, f, m]);
    }
  }
  return steps;
}

function columnFor(method) {
  return (COLUMNS.find((col) => col.method === method.replace(/^-/, '')) || COLUMNS[0]).key;
}

async function runPlayback() {
  if (!audioProbe) setUpAudioProbe();
  if (audioProbe?.ctx?.state === 'suspended') await audioProbe.ctx.resume();
  stopping = false;
  $('run').disabled = true;
  $('stop').hidden = false;
  const steps = plan();
  const ran = new Set(steps.map(([c]) => c.id));
  report.mode = currentMode();
  report.playback = report.playback.filter((r) => !ran.has(r.case));
  for (const id of ran) {
    const c = cases.find((x) => x.id === id);
    for (const col of COLUMNS) cell(c, col.key).replaceChildren();
  }
  const progress = $('progress');
  progress.hidden = false;
  progress.max = steps.length;
  await calibrateAudio(steps);
  let done = 0;
  for (const [c, f, m] of steps) {
    if (stopping) break;
    let r;
    if (!f) {
      r = { case: c.id, format: 'none', method: 'none', result: 'unavailable' };
    } else if (m.startsWith('-')) {
      r = { case: c.id, format: f.format, method: m.slice(1), result: 'unavailable' };
    } else {
      do {
        if (document.hidden) {
          $('now').textContent = 'Paused: a hidden tab stops drawing video. Come back to this tab to continue.';
          await visible();
        }
        $('now').textContent = `${c.id} · ${formatLabel(f.format)} · ${m}`;
        r = await play(c, f, m);
      } while (r.result === 'interrupted' && !stopping);
    }
    report.playback.push(r);
    cell(c, columnFor(m)).appendChild(playChip(r));
    progress.value = ++done;
    $('status').textContent = `${done} of ${steps.length}`;
  }
  $('now').textContent = '';
  $('run').disabled = false;
  $('stop').hidden = true;
  report.finished = new Date().toISOString();
  const failed = report.playback.filter((r) => ['failed', 'stalled', 'blocked'].includes(r.result)).length;
  $('status').textContent = `${stopping ? 'Stopped' : 'Done'}: ${report.playback.length} tried, ${failed} did not play.`;
  enableReport();
  const target = params.get('report');
  if (target) {
    fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) })
      .catch((e) => { $('status').textContent += ` Sending the report failed: ${e}`; });
  }
}

function reportText() {
  return JSON.stringify(report, null, 1);
}

function reportName() {
  return `codec-lab-${browserName(report.env).replace(/\W+/g, '-').toLowerCase()}-${report.started.slice(0, 10)}.json`;
}

function enableReport() {
  $('copy').disabled = false;
  $('download').disabled = false;
  if (navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })) {
    $('share').hidden = false;
    $('share').disabled = false;
  }
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportText());
    $('status').textContent = 'Report copied.';
  } catch (e) {
    $('status').textContent = `Copying failed (${e.name}); use Download or Share instead.`;
  }
});
$('download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([reportText()], { type: 'application/json' }));
  a.download = reportName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
$('share').addEventListener('click', async () => {
  const file = new File([reportText()], reportName(), { type: 'application/json' });
  try { await navigator.share({ files: [file], title: 'Codec Lab report' }); } catch { /* dismissed */ }
});
$('run').addEventListener('click', () => runPlayback());
$('stop').addEventListener('click', () => { stopping = true; });

(async () => {
  report.env = await environment();
  showEnvironment(report.env);
  const manifest = await (await fetch('cases.json', { cache: 'no-cache' })).json();
  const only = params.get('only');
  cases = manifest.cases.filter((c) => !only || only.split(',').some((p) => c.id.startsWith(p)));
  buildTable();
  buildGroups();
  $('status').textContent = 'Asking the browser about every codec…';
  await runProbe();
  enableReport();
  $('status').textContent = 'Capability probe done. Pick what to test and tap “Run tests”.';
  if (params.get('autorun') === '1') runPlayback();
})();
