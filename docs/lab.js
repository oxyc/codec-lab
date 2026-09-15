// Codec Lab: probes what this browser claims for each clip's codecs, then plays every clip in every way this browser
// can play it, and builds a report of both. One <video> element is reused throughout: a browser that allowed it to
// play once, on the tap that started the run, lets it play again.
'use strict';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const video = $('player');
const PLAY_TIMEOUT_MS = 15000;
const FRAMES_TO_PASS = 15;

const report = {
  lab: 'codec-lab',
  started: new Date().toISOString(),
  env: {},
  capability: {},
  playback: [],
};
let cases = [];
let stopping = false;

// ---------------------------------------------------------------------------------------------------------------
// Environment

async function environment() {
  const env = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
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
    dashJsVersion: typeof dashjs !== 'undefined' && dashjs.Version ? dashjs.Version : null,
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
  return env;
}

function browserName(env) {
  const ua = env.userAgent;
  if (env.brave) return /iPhone|iPad/.test(ua) ? 'Brave (iOS)' : 'Brave';
  if (/CriOS/.test(ua)) return 'Chrome (iOS)';
  if (/FxiOS/.test(ua)) return 'Firefox (iOS)';
  if (/EdgiOS|Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return /iPhone|iPad/.test(ua) || (env.maxTouchPoints > 1 && /Macintosh/.test(ua)) ? 'Safari (iOS/iPadOS)' : 'Safari';
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
  const mp4 = c.formats.find((f) => f.format === 'mp4' && f.mime);
  const file = c.formats.find((f) => f.mime && !f.mime.startsWith('application/')) || mp4;
  const type = file?.mime;
  const vstr = videoString(c);
  if (type) {
    out.type = type;
    out.canPlayType = video.canPlayType(type);
    out.mse = mseSupports(type);
  }
  const container = type ? type.split(';')[0].replace('audio/', 'video/') : 'video/mp4';
  if (vstr) {
    const videoConfig = {
      contentType: `${container}; codecs="${vstr}"`,
      width: c.width, height: c.height, bitrate: 4_000_000, framerate: c.fps || 30,
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
    out.audio = {
      type: audioType,
      canPlayType: video.canPlayType(audioType),
      mse: mseSupports(audioType),
      mediaCapabilities: await decodingInfo({
        type: 'media-source',
        audio: { contentType: audioType, channels: String(c.audio_channels), bitrate: 256000, samplerate: 48000 },
      }),
    };
  }
  if (typeof c.codecs.video === 'object') {
    const dv = `video/mp4; codecs="${c.codecs.video.dolby_vision}"`;
    out.dolbyVision = { type: dv, canPlayType: video.canPlayType(dv), mse: mseSupports(dv) };
  }
  return out;
}

// Codec strings with no clip here — nothing encodes them yet — asked about all the same.
const EXTRA_TYPES = [
  'video/mp4; codecs="dvh1.05.06"', 'video/mp4; codecs="dvh1.08.06"', 'video/mp4; codecs="dvav.09.05"',
  'video/mp4; codecs="dav1.10.06"', 'video/mp4; codecs="vvc1.1.L123.CQA.O1+3"', 'video/mp4; codecs="evc1"',
  'audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="ac-4.02.01.01"', 'audio/mp4; codecs="mp4a.40.42"',
  'audio/mp4; codecs="mhm1.0x0D"', 'audio/mp4; codecs="dtsx"', 'audio/mp4; codecs="dtse"', 'audio/mp4; codecs="iamf.001.001.Opus"',
  'audio/mp4; codecs="apac"', 'audio/mp4; codecs="mlpa"', 'audio/flac', 'audio/wav', 'audio/ogg; codecs="opus"',
];

// ---------------------------------------------------------------------------------------------------------------
// What the browser plays

function methodsFor(format, env) {
  // No browser plays DASH on its own; dash.js needs Media Source Extensions.
  if (format.format === 'dash') return [env.dashJs ? 'dash.js' : '-dash.js'];
  if (format.format.startsWith('hls')) {
    return [env.nativeHls ? 'native' : null, env.hlsJs ? 'hls.js' : null].filter(Boolean)
      .concat(env.nativeHls && env.hlsJs ? [] : [env.nativeHls ? '-hls.js' : '-native']);
  }
  return ['file'];
}

let audioProbe = null;

/** A way to tell audio was decoded. WebKit and Chromium count decoded bytes; elsewhere an analyser listens, routed
 *  nowhere, so the element plays unmuted in silence. */
function setUpAudioProbe() {
  if ('webkitAudioDecodedByteCount' in video) {
    video.muted = true;
    audioProbe = { kind: 'bytes' };
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    video.muted = true;
    audioProbe = { kind: 'none' };
    return;
  }
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaElementSource(video).connect(analyser);
  video.muted = false;
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

let hls = null;
let dash = null;

function reset() {
  if (hls) { hls.destroy(); hls = null; }
  if (dash) { dash.reset(); dash = null; }
  video.pause();
  for (const t of [...video.querySelectorAll('track')]) t.remove();
  video.removeAttribute('src');
  video.load();
}

function play(c, format, method) {
  return new Promise((resolve) => {
    reset();
    const started = performance.now();
    const result = {
      case: c.id, format: format.format, method, url: format.url, result: 'stalled',
      width: 0, height: 0, frames: 0, time: 0, audio: c.codecs.audio ? null : undefined,
      subtitles: c.subtitles ? false : undefined, error: null, ms: 0,
    };
    let frameHandle = null;
    let settled = false;
    let heard = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (frameHandle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      result.result = outcome;
      result.width = video.videoWidth;
      result.height = video.videoHeight;
      result.time = Math.round(video.currentTime * 100) / 100;
      const quality = video.getVideoPlaybackQuality?.();
      if (quality) {
        result.totalFrames = quality.totalVideoFrames;
        result.droppedFrames = quality.droppedVideoFrames;
        if (!('requestVideoFrameCallback' in video)) result.frames = quality.totalVideoFrames;
      }
      if (c.codecs.audio) result.audio = heard || audioHeard();
      if (c.subtitles) {
        result.subtitles = [...video.textTracks].some((t) => t.cues && t.cues.length > 0);
      }
      result.ms = Math.round(performance.now() - started);
      resolve(result);
    };

    const onFrame = () => {
      result.frames += 1;
      frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    if ('requestVideoFrameCallback' in video) frameHandle = video.requestVideoFrameCallback(onFrame);

    video.onerror = () => {
      const e = video.error;
      result.error = e ? { code: e.code, message: e.message || '' } : { message: 'error event' };
      finish('failed');
    };
    video.onended = () => finish(passed() ? 'played' : 'failed');
    video.onloadedmetadata = () => {
      for (const t of video.textTracks) t.mode = 'hidden';
    };

    // A clip with no picture passes on its sound: decoded bytes or a signal, or time advancing where neither is known.
    const audioOnly = !c.codecs.video;
    const passed = () => {
      if (audioOnly) return heard || audioHeard() === true || (audioProbe?.kind === 'none' && video.currentTime >= 0.5);
      const frames = 'requestVideoFrameCallback' in video
        ? result.frames : (video.getVideoPlaybackQuality?.().totalVideoFrames || 0);
      return video.videoWidth > 0 && (frames >= FRAMES_TO_PASS || (frames === 0 && video.currentTime >= 1.5));
    };
    const poll = setInterval(() => {
      if (c.codecs.audio && !heard) heard = audioHeard() === true;
      const subsReady = !c.subtitles || [...video.textTracks].some((t) => t.cues && t.cues.length > 0);
      const audioReady = !c.codecs.audio || heard || audioProbe?.kind === 'none';
      if (passed() && (audioOnly || video.currentTime >= 2) && subsReady && audioReady) finish('played');
    }, 250);
    const timer = setTimeout(() => finish(passed() ? 'played' : video.error ? 'failed' : 'stalled'), PLAY_TIMEOUT_MS);

    if (method === 'hls.js') {
      hls = new Hls({ enableWorker: true, subtitleDisplay: false });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          result.error = { hls: data.type, details: data.details, reason: String(data.reason || data.error || '') };
          finish('failed');
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (c.subtitles === 'webvtt') hls.subtitleTrack = 0; });
      hls.loadSource(format.url);
      hls.attachMedia(video);
    } else if (method === 'dash.js') {
      dash = dashjs.MediaPlayer().create();
      dash.updateSettings({ debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE } });
      dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
        result.error = { dash: e.error?.code ?? null, message: String(e.error?.message || e.error || '') };
        finish('failed');
      });
      dash.initialize(video, format.url, true);
    } else {
      if (format.track && method === 'file') {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.srclang = 'en';
        track.src = format.track;
        track.default = true;
        video.appendChild(track);
      }
      video.src = format.url;
    }
    video.play().catch((e) => {
      if (e.name === 'NotAllowedError') {
        result.error = { message: 'autoplay refused: tap Run again' };
        finish('blocked');
      }
      // Anything else surfaces as an error event or a stall.
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The table

function chip(text, cls, title) {
  const span = document.createElement('span');
  span.className = `chip ${cls}`;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

function saysChips(p) {
  const spans = [];
  if (p.canPlayType !== undefined) {
    spans.push(chip(`type ${p.canPlayType || 'no'}`, p.canPlayType ? 'ok' : 'bad', p.type));
  }
  if (p.mse !== undefined && p.mse !== null) spans.push(chip(`MSE ${p.mse ? '✓' : '✗'}`, p.mse ? 'ok' : 'bad'));
  const mc = p.mediaCapabilities?.mediaSource || p.mediaCapabilities?.file;
  if (mc && !mc.error) {
    const extra = mc.supported ? [mc.smooth ? 'smooth' : 'not smooth', mc.powerEfficient ? 'hw' : 'sw'].join(', ') : '';
    spans.push(chip(`MC ${mc.supported ? '✓' : '✗'}`, mc.supported ? 'ok' : 'bad', extra));
  }
  if (p.audio) {
    spans.push(chip(`audio ${p.audio.canPlayType || 'no'}`, p.audio.canPlayType ? 'ok' : 'bad', p.audio.type));
  }
  if (p.dolbyVision) {
    spans.push(chip(`DV ${p.dolbyVision.canPlayType || 'no'}`, p.dolbyVision.canPlayType ? 'ok' : 'bad', p.dolbyVision.type));
  }
  return spans;
}

function playChip(r) {
  const label = r.method === 'file' ? r.format : `${r.format} · ${r.method}`;
  if (r.result === 'unavailable') return chip(`${label} –`, 'na', 'not available in this browser');
  const partly = r.result === 'played' && (r.audio === false || r.subtitles === false);
  const cls = r.result === 'played' ? (partly ? 'part' : 'ok') : 'bad';
  const mark = r.result === 'played' ? (partly ? '~' : '✓') : '✗';
  const detail = [
    `${r.result} in ${r.ms} ms`, `${r.width}×${r.height}`, `${r.frames} frames`,
    r.audio === false ? 'no audio decoded' : r.audio ? 'audio decoded' : '',
    r.subtitles === false ? 'no cues' : r.subtitles ? 'cues loaded' : '',
    r.error ? JSON.stringify(r.error) : '',
  ].filter(Boolean).join(' · ');
  return chip(`${label} ${mark}`, cls, detail);
}

function row(c) {
  let tr = document.getElementById(`row-${c.id}`);
  if (!tr) {
    tr = document.createElement('tr');
    tr.id = `row-${c.id}`;
    tr.innerHTML = '<td class="title"></td><td class="codecs"></td><td class="says"><div class="chips"></div></td>'
      + '<td class="plays"><div class="chips"></div></td>';
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
  const body = $('results').tBodies[0];
  body.replaceChildren();
  let group = null;
  for (const c of cases) {
    if (c.group !== group) {
      group = c.group;
      const g = document.createElement('tr');
      g.className = 'group';
      g.innerHTML = '<td colspan="4"></td>';
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
    label.append(box, ` ${g}`);
    $('groups').appendChild(label);
  }
}

function selectedGroups() {
  return new Set([...$('groups').querySelectorAll('input:checked')].map((i) => i.value));
}

// ---------------------------------------------------------------------------------------------------------------
// Running

async function runProbe() {
  for (const c of cases) {
    const p = await probe(c);
    report.capability[c.id] = p;
    row(c).querySelector('.says .chips').replaceChildren(...saysChips(p));
  }
  report.extraTypes = Object.fromEntries(EXTRA_TYPES.map((t) => [t, { canPlayType: video.canPlayType(t), mse: mseSupports(t) }]));
}

async function runPlayback() {
  if (!audioProbe) setUpAudioProbe();
  if (audioProbe?.ctx?.state === 'suspended') await audioProbe.ctx.resume();
  stopping = false;
  $('run').disabled = true;
  $('stop').hidden = false;
  const groups = selectedGroups();
  const plan = [];
  for (const c of cases) {
    if (!groups.has(c.group)) continue;
    for (const f of c.formats) {
      if (f.unavailable) continue;
      for (const m of methodsFor(f, report.env)) plan.push([c, f, m]);
    }
  }
  report.playback = report.playback.filter((r) => !groups.has(cases.find((c) => c.id === r.case)?.group));
  const progress = $('progress');
  progress.hidden = false;
  progress.max = plan.length;
  let done = 0;
  for (const c of cases) if (groups.has(c.group)) row(c).querySelector('.plays .chips').replaceChildren();
  for (const [c, f, m] of plan) {
    if (stopping) break;
    const cell = row(c).querySelector('.plays .chips');
    let r;
    if (m.startsWith('-')) {
      r = { case: c.id, format: f.format, method: m.slice(1), result: 'unavailable' };
    } else {
      $('now').textContent = `${c.id} · ${f.format} · ${m}`;
      r = await play(c, f, m);
    }
    report.playback.push(r);
    cell.appendChild(playChip(r));
    progress.value = ++done;
    $('status').textContent = `${done} of ${plan.length}`;
  }
  reset();
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
  $('hlsver').textContent = report.env.hlsJsVersion || '';
  const manifest = await (await fetch('cases.json', { cache: 'no-cache' })).json();
  const only = params.get('only');
  cases = manifest.cases.filter((c) => !only || only.split(',').some((p) => c.id.startsWith(p)));
  report.cases = manifest.generated || null;
  buildGroups();
  buildTable();
  $('status').textContent = 'Asking the browser about every codec…';
  await runProbe();
  enableReport();
  $('status').textContent = 'Capability probe done. Tap “Run playback tests” to play every clip.';
  if (params.get('autorun') === '1') runPlayback();
})();
