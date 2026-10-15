// mbaudio.js — Monkey Brains audio v01. Plain Web Audio, ES module, no deps. See AUDIO.md.
// TIMING RULE: audio never feeds the game timer. sfx() is sync, cheap, returns null when not ready.
const BUS_DEFAULTS = { master: 1.0, sfx: 1.0, ui: 0.8, ambience: 0.22 };
const TRIM_DB = { tap: -2, click: -1, wrong: 0, reward: 0, chimpHappy: -1, chimpSulk: -1, levelUp: 0, newBest: 0 };
const BUS_OF = { click: 'ui' };
const GROUP_OF = { chimpHappy: 'chimp', chimpSulk: 'chimp', levelUp: 'cue', newBest: 'cue', wrong: 'wrong' };
const SMOOTH = 0.015;
const db2 = (d) => Math.pow(10, d / 20);

let S = null; // state

export function pickFormat() {
  try {
    const a = document.createElement('audio');
    return a.canPlayType('audio/ogg; codecs="opus"') ? 'ogg' : 'm4a';
  } catch { return 'm4a'; }
}

function makeLimiter(ctx, useComp) {
  if (useComp) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -2; c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.002; c.release.value = 0.1;
    return c;
  }
  // zero-latency WaveShaper ceiling: linear to -3 dBFS, soft knee to -1 dBFS ceiling
  const ws = ctx.createWaveShaper(), n = 8192, curve = new Float32Array(n);
  const T = db2(-3), C = db2(-1), K = C - T;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    const y = ax <= T ? ax : T + K * Math.tanh((ax - T) / K);
    curve[i] = Math.sign(x) * y;
  }
  ws.curve = curve; ws.oversample = 'none';
  return ws;
}

// find the 2 kHz sync marker by cross-correlation; returns offset in source-rate samples (fractional)
function findMarker(buf, mk) {
  const sr = buf.sampleRate, ratio = sr / mk.sampleRate, d = buf.getChannelData(0);
  const n = Math.max(8, Math.round(mk.length * ratio));
  const tpl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    tpl[i] = mk.amp * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))) * Math.sin(2 * Math.PI * mk.freq * (t - (mk.length - 1) / 2) / mk.sampleRate);
  }
  let e = 0; for (let i = 0; i < n; i++) e += tpl[i] * tpl[i];
  const expect = Math.round(mk.start * ratio), R = Math.round(240 * ratio);
  let best = -Infinity, bi = expect; const sc = [];
  for (let s = Math.max(0, expect - R); s <= Math.min(d.length - n, expect + R); s++) {
    let c = 0; for (let i = 0; i < n; i++) c += d[s + i] * tpl[i];
    sc[s] = c; if (c > best) { best = c; bi = s; }
  }
  // parabolic sub-sample refinement
  let frac = 0; const a = sc[bi - 1], b = sc[bi], c = sc[bi + 1];
  if (a !== undefined && c !== undefined) { const den = a - 2 * b + c; if (den) frac = 0.5 * (a - c) / den; }
  const score = e ? best / e : 0;
  if (score < 0.5) return { offsetSec: 0, score, ok: false };
  return { offsetSec: (bi + frac - expect) / sr, score, ok: true };
}

async function loadBuf(ctx, url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const ab = await r.arrayBuffer();
  return await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
}

export async function init({ base = './', format, context, compressorLimiter = false } = {}) {
  if (S) dispose();
  const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
  const ctx = context || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const st = { ctx, own: !context, buses: {}, vols: { ...BUS_DEFAULTS }, muted: false, groups: {}, amb: null, diag: { ok: false } };
  S = st;
  st.limiter = makeLimiter(ctx, compressorLimiter); st.limiter.connect(ctx.destination);
  st.buses.master = ctx.createGain(); st.buses.master.connect(st.limiter);
  for (const b of ['sfx', 'ui', 'ambience']) { st.buses[b] = ctx.createGain(); st.buses[b].gain.value = st.vols[b]; st.buses[b].connect(st.buses.master); }
  st.buses.master.gain.value = st.vols.master;
  try {
    if (!base.endsWith('/')) base += '/';
    const meta = await (await fetch(base + 'mb_sfx.json')).json();
    st.meta = meta;
    let fmt = format || pickFormat(), sfxB, ambB;
    try {
      [sfxB, ambB] = await Promise.all([loadBuf(ctx, base + meta.files.sfx[fmt]), loadBuf(ctx, base + meta.files.amb[fmt])]);
    } catch (e) {
      if (fmt !== 'ogg') throw e;
      fmt = 'm4a'; st.diag.opusFallback = String(e);
      [sfxB, ambB] = await Promise.all([loadBuf(ctx, base + meta.files.sfx.m4a), loadBuf(ctx, base + meta.files.amb.m4a)]);
    }
    if (S !== st) return st.diag; // disposed meanwhile
    st.sfxBuf = sfxB; st.ambBuf = ambB; st.format = fmt;
    const m = findMarker(sfxB, meta.marker);
    const msr = meta.sampleRate;
    st.sprites = {};
    for (const [k, v] of Object.entries(meta.sprites)) st.sprites[k] = { off: v.start / msr + m.offsetSec, dur: v.length / msr };
    if (meta.ambience) st.loop = { start: meta.ambience.loopStart / msr, end: meta.ambience.loopEnd / msr };
    st.diag = Object.assign(st.diag, { ok: true, format: fmt, sampleRate: ctx.sampleRate, markerOffsetSamples: m.offsetSec * msr,
      markerScore: m.score, markerFound: m.ok, initMs: (typeof performance !== 'undefined') ? performance.now() - t0 : null,
      limiter: compressorLimiter ? 'compressor' : 'waveshaper' });
  } catch (e) {
    st.diag = Object.assign(st.diag, { ok: false, error: String(e) });
  }
  return st.diag;
}

export function unlock() {
  if (!S) return Promise.resolve();
  const ctx = S.ctx;
  try { const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch {}
  return (ctx.state === 'suspended' && !S.paused && ctx.resume) ? ctx.resume().catch(() => {}) : Promise.resolve();
}

export function armUnlock(target = (typeof document !== 'undefined' ? document : null)) {
  if (!target) return () => {};
  const evs = ['pointerdown', 'touchend', 'keydown'];
  const h = () => { unlock(); if (S && S.ctx.state === 'running') off(); };
  const off = () => evs.forEach((e) => target.removeEventListener(e, h, true));
  evs.forEach((e) => target.addEventListener(e, h, true));
  return off;
}

export function sfx(name, { index, gainDb = 0, when } = {}) {
  if (!S || !S.sfxBuf || S.ctx.state === 'closed') return null;
  if (S.own && S.ctx.state !== 'running') return null;
  let key = name;
  if (name === 'tap') key = 'tap_' + Math.min(9, Math.max(1, (index | 0) || 1));
  const sp = S.sprites[key]; if (!sp) return null;
  const ctx = S.ctx, t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = S.sfxBuf; g.gain.value = db2((TRIM_DB[name] ?? 0) + gainDb);
  src.connect(g); g.connect(S.buses[BUS_OF[name] || 'sfx']);
  src.start(t, sp.off, sp.dur);
  const grp = GROUP_OF[name];
  if (grp) {
    const prev = S.groups[grp];
    if (prev) { try { prev.g.gain.setTargetAtTime(0, t, 0.004); prev.src.stop(t + 0.03); } catch {} }
    const rec = { src, g }; S.groups[grp] = rec;
    src.onended = () => { if (S && S.groups[grp] === rec) delete S.groups[grp]; };
  }
  return src;
}

export function ambienceStart(fadeSec = 1.5, when) {
  if (!S || !S.ambBuf || S.amb) return;
  const ctx = S.ctx, t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = S.ambBuf; src.loop = true;
  if (S.loop) { src.loopStart = S.loop.start; src.loopEnd = S.loop.end; }
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + Math.max(0.01, fadeSec));
  src.connect(g); g.connect(S.buses.ambience);
  src.start(t, S.loop ? S.loop.start : 0);
  S.amb = { src, g };
}

export function ambienceStop(fadeSec = 0.6, when) {
  if (!S || !S.amb) return;
  const ctx = S.ctx, t = Math.max(when ?? ctx.currentTime, ctx.currentTime), { src, g } = S.amb;
  const f = Math.max(0.01, fadeSec);
  g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + f);
  try { src.stop(t + f + 0.02); } catch {}
  S.amb = null;
}

export function setPaused(p) {
  if (!S || !S.ctx.suspend) return Promise.resolve();
  S.paused = !!p;
  return (p ? S.ctx.suspend() : S.ctx.resume()).catch(() => {});
}

function applyGain(bus, when) {
  const node = S.buses[bus]; const ctx = S.ctx, t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
  const v = bus === 'master' && S.muted ? 0 : S.vols[bus];
  node.gain.cancelScheduledValues(t); node.gain.setTargetAtTime(v, t, SMOOTH / 3);
}

export function setVolume(bus, v, when) {
  if (!S || !(bus in S.vols)) return;
  S.vols[bus] = Math.min(1, Math.max(0, +v || 0)); applyGain(bus, when);
}
export function getVolume(bus) { return S ? S.vols[bus] : BUS_DEFAULTS[bus]; }
export function setMuted(m) { if (!S) return; S.muted = !!m; applyGain('master'); }
export function diagnostics() { return S ? { ...S.diag, state: S.ctx.state, muted: S.muted, volumes: { ...S.vols } } : { ok: false, error: 'not initialised' }; }
export function context() { return S ? S.ctx : null; }

export function dispose() {
  if (!S) return;
  const st = S; S = null;
  try { st.amb && st.amb.src.stop(); } catch {}
  for (const g of Object.values(st.groups)) { try { g.src.stop(); } catch {} }
  try { st.limiter.disconnect(); } catch {}
  if (st.own && st.ctx.close) st.ctx.close().catch(() => {});
}
