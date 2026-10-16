import './style.css';
import { initAudio, sfx, ambient, setMuted, setSfxGate } from './audio';

const B = import.meta.env.BASE_URL;
const $ = (id: string) => document.getElementById(id)!;
const COLS = 5, ROWS = 8, CELLS = COLS * ROWS;

/** Championship rounds: 4..9 digits at 2000 ms, then 9 digits with shorter display; last level repeats. */
const LEVELS: { n: number; ms: number }[] = [
  ...[4, 5, 6, 7, 8, 9].map(n => ({ n, ms: 2000 })),
  ...[1500, 1000, 700, 500, 350, 210].map(ms => ({ n: 9, ms })),
];
const HINTS: Record<number, string> = { 4: 'easy', 5: 'easy', 6: 'medium', 7: 'medium', 8: 'hard', 9: 'expert' };
const SKILLS = [4, 5, 6, 7, 8, 9].map(n => ({ id: String(n), label: `${n} digits`, n, hint: HINTS[n] }));
const MEMOS = [5000, 3000, 2000, 1000, 500];
const SERIES_LEN = 5;
const POSE: Record<string, number> = { idle: 594, focused: 585, success: 772, fail: 574 };
const LS = { series: 'mb.board.series.v1', champ: 'mb.board.champ.v1', name: 'mb.lastName', sound: 'mb.sound', setup: 'mb.setup', cd: 'mb.countdown' };
const CDS = [3, 2, 1, 0];

type Phase = 'menu' | 'countdown' | 'arming' | 'show' | 'hidden' | 'done';
type Mode = 'series' | 'champ';
interface Attempt { ok: boolean; ms: number }
interface SeriesEntry { suspect?: boolean; name: string; skill: string; n: number; memo: number; ok: number; avg: number | null; best: number | null; score: number; at: number }
/** total = sum over cleared rounds of the round time (digits first shown -> last correct tap, i.e. the LED timer), ms. */
interface ChampEntry { suspect?: boolean; name: string; rounds: number; digits: number; total?: number; avg: number | null; at: number }
/** Sanity floor (reporting only, never rejects): a result faster than ~80 ms per digit is implausible for a human. */
const SUSPECT_MS_PER_DIGIT = 80;
function isSuspect(board: Mode, e: any): boolean {
  if (board === 'series') return e.avg != null && e.avg / e.n < SUSPECT_MS_PER_DIGIT;
  const t = champTotal(e); if (t == null || !e.rounds) return false;
  let digits = 0; for (let r = 0; r < e.rounds; r++) digits += 4 + r; // round r shows 4+r digits
  return t / digits < SUSPECT_MS_PER_DIGIT;
}
(window as any).__mbSanity = () => {
  const out: Record<string, { total: number; flagged: number }> = {};
  for (const b of ['series', 'champ'] as Mode[]) { const all = loadBoard<any>(b); out[b] = { total: all.length, flagged: all.filter(e => isSuspect(b, e)).length }; }
  return out;
};
/** Total for an entry; entries saved before `total` existed are derived from avg x rounds (avg was rounded, so +-rounds/2 ms). */
function champTotal(e: ChampEntry): number | null {
  if (typeof e.total === 'number') return e.total;
  if (typeof e.avg === 'number' && e.rounds > 0) return e.avg * e.rounds;
  return null;
}

const st = {
  mode: 'series' as Mode, phase: 'menu' as Phase, trialId: 0, trial: 0, next: 1,
  n: 6, memo: 2000, skill: '6', round: 0,
  layout: new Map<number, number>(), digitCells: [] as number[],
  t0: 0, timers: new Set<number>(), raf: 0,
  hist: [] as string[], attempts: [] as Attempt[], champTimes: [] as number[],
  lastEntryAt: 0, lastBoard: 'series' as Mode,
  cd: 3, bf: { n: 6, memo: 2000 },
};
(window as any).__mb = st;
// Never play any sound while the digits are showing.
setSfxGate(() => st.phase === 'show');

// ---------- perf instrumentation (always collected, cheap; overlay with ?perf=1) ----------
const PERF_ON = new URLSearchParams(location.search).has('perf');
const perf = {
  trials: [] as { target: number; actual: number; cdTarget: number; cdActual: number }[],
  inputs: [] as { handler: number; feedback: number }[],
  long: [] as number[],
};
(window as any).__perf = perf;
// fixed ring for input samples during a trial: no allocation in the hot path
const IN_N = 64, inHandler = new Float64Array(IN_N), inFeedback = new Float64Array(IN_N);
let inCount = 0;
try { new PerformanceObserver(l => { for (const e of l.getEntries()) perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
let perfEl: HTMLElement | null = null;
if (PERF_ON) {
  perfEl = document.createElement('pre'); perfEl.id = 'perfOverlay'; document.body.appendChild(perfEl);
}
function flushPerf() {
  // copy ring into perf.inputs after a trial (outside the hot path)
  for (let i = 0; i < Math.min(inCount, IN_N); i++) perf.inputs.push({ handler: inHandler[i], feedback: inFeedback[i] });
  inCount = 0;
  if (!perfEl) return;
  const tr = perf.trials, last = tr[tr.length - 1];
  const dev = tr.map(t => Math.abs(t.actual - t.target)).sort((x, y) => x - y);
  const fb = perf.inputs.map(x => x.feedback).sort((x, y) => x - y);
  const p95 = (a: number[]) => a.length ? a[Math.min(a.length - 1, Math.ceil(.95 * a.length) - 1)].toFixed(1) : '-';
  perfEl.textContent = [
    `frame ${frameMs.toFixed(1)}ms  trials ${tr.length}`,
    last ? `memo  sched ${last.target}  actual ${last.actual.toFixed(1)}  Δ ${(last.actual - last.target).toFixed(1)}` : 'memo  -',
    last && last.cdTarget ? `cd    sched ${last.cdTarget}  actual ${last.cdActual.toFixed(1)}` : 'cd    -',
    `memo |Δ| p95 ${p95(dev)}ms  input→frame p95 ${p95(fb)}ms`,
    `long tasks ${perf.long.length}${perf.long.length ? ' max ' + Math.max(...perf.long).toFixed(0) + 'ms' : ''}`,
  ].join('\n');
}

// ---------- frame clock: every trial-critical deadline runs inside requestAnimationFrame ----------
/** Deadlines are absolute performance.now()/rAF times; a job runs in the first frame whose start is within
 *  half a frame of its deadline, so visible durations are frame-quantised with |error| <= frame/2. */
interface Job { at: number; id: number; fn: (ts: number) => void }
const jobs: Job[] = [];
let looping = false, lastTs = 0, frameMs = 1000 / 60;
function frame(ts: number) {
  if (lastTs) { const d = ts - lastTs; if (d > 4 && d < 40) frameMs += (d - frameMs) * 0.1; }
  lastTs = ts;
  for (let i = 0; i < jobs.length;) {
    const j = jobs[i];
    if (j.id !== st.trialId) { jobs.splice(i, 1); continue; }
    if (ts + frameMs / 2 >= j.at) { jobs.splice(i, 1); j.fn(ts); } else i++;
  }
  const live = st.phase === 'show' || st.phase === 'hidden';
  if (live) readout(ts - st.t0);
  if (jobs.length || live) requestAnimationFrame(frame); else { looping = false; lastTs = 0; }
}
function wake() { if (!looping) { looping = true; requestAnimationFrame(frame); } }
/** Run fn in the frame nearest to absolute time `at` (0 = next frame). Tied to the current trialId. */
function atFrame(at: number, fn: (ts: number) => void) { jobs.push({ at, id: st.trialId, fn }); wake(); }

/** Non-critical delayed work (sfx after a trial, showing the sheet). Tied to trialId. */
function later(fn: () => void, ms: number) {
  const id = st.trialId;
  const h = window.setTimeout(() => { st.timers.delete(h); if (st.trialId === id) fn(); }, ms);
  st.timers.add(h);
}
function cancelTimers() {
  for (const h of st.timers) clearTimeout(h);
  st.timers.clear(); jobs.length = 0;
}

// ---------- input: pointerdown everywhere (no click delay), keyboard click as fallback ----------
function press(el: Element, fn: (e: Event) => void) {
  el.addEventListener('pointerdown', e => { const pe = e as PointerEvent; if (pe.button > 0) return; e.preventDefault(); fn(e); });
  el.addEventListener('click', e => { if ((e as MouseEvent).detail === 0) fn(e); }); // keyboard / synthetic only
}

// ---------- layout ----------
function fit() {
  const app = $('app'), lab = $('lab');
  const s = Math.min(app.clientWidth / 390, app.clientHeight / 844);
  lab.style.transform = `translateX(-50%) scale(${s})`;
}
addEventListener('resize', fit); fit();
$('verLabel').textContent = 'v' + __VERSION__;

const grid = $('grid');
const cells: HTMLDivElement[] = [];
for (let i = 0; i < CELLS; i++) {
  const d = document.createElement('div');
  d.className = 'mb2-cell'; d.dataset.cell = String(i);
  grid.appendChild(d); cells.push(d);
}
// one delegated listener; reaction time from the event's own timestamp
grid.addEventListener('pointerdown', e => {
  const c = (e.target as HTMLElement).closest('[data-cell]') as HTMLElement | null;
  if (!c) return; e.preventDefault();
  onTap(+c.dataset.cell!, e.timeStamp);
});

// ---------- assets / paint safety ----------
const digitUrl = (k: number) => `${B}assets-v2/svg/digit-${k}.svg`;
const digitCache = new Map<number, HTMLImageElement>();
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image(); im.decoding = 'sync';
    im.onload = () => { const done = () => res(im); im.decode ? im.decode().then(done, done) : done(); };
    im.onerror = () => rej(new Error('load failed: ' + src)); im.src = src;
  });
}
let preload: Promise<void> | null = null;
function preloadAll(): Promise<void> {
  preload ??= Promise.all([
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(async k => { digitCache.set(k, await loadImage(digitUrl(k))); }),
    ...Object.keys(POSE).map(p => loadImage(`${B}assets-v2/chimp/chimp-${p}.webp`).catch(() => null)),
    ...['tile-cover', 'tile-cover-wrong', 'grid-cell'].map(n => loadImage(`${B}assets-v2/svg/${n}.svg`).catch(() => null)),
    document.fonts?.ready ?? Promise.resolve(),
  ]).then(() => undefined);
  return preload;
}
function digitImg(k: number, opacity = 1) {
  const src = digitCache.get(k);
  const im = src ? (src.cloneNode(true) as HTMLImageElement) : new Image();
  if (!src) im.src = digitUrl(k);
  im.className = 'cell-digit'; im.alt = ''; im.decoding = 'sync';
  if (opacity < 1) im.style.opacity = String(opacity);
  return im;
}

// ---------- HUD ----------
function setPose(p: keyof typeof POSE, label: string, red = false) {
  const c = $('chimp') as HTMLImageElement;
  c.src = `${B}assets-v2/chimp/chimp-${p}.webp`; c.style.width = POSE[p] / 3 + 'px';
  const s = $('stateLbl'); s.textContent = label; s.style.color = red ? 'var(--mb2-signal)' : '';
}
// LED readout: 5 persistent segment spans; only changed digits are touched (no per-frame DOM churn)
/** The LED window (timer-plate.svg x 8..192 minus the MS label) fits 6 segments; max shown = 999999 ms. */
const SEG_N = 6, SEG_MAX = 10 ** SEG_N - 1, SEG_MIN_DIGITS = 4;
const segs: HTMLSpanElement[] = [];
const segVal: number[] = new Array(SEG_N).fill(-2);
for (let i = 0; i < SEG_N; i++) { const sp = document.createElement('span'); sp.className = 'mb2-seg'; sp.dataset.d = ' '; segs.push(sp); }
$('readout').replaceChildren(...segs);
const SEG_CH = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
function readout(ms: number) {
  // display-only cap at the real LED maximum; stored/derived times are never clamped
  let v = Math.min(SEG_MAX, Math.max(0, Math.round(ms)));
  for (let i = SEG_N - 1; i >= 0; i--) {
    // at least 4 digits lit (0072); higher slots stay unlit until the value needs them
    const lit = v > 0 || i >= SEG_N - SEG_MIN_DIGITS;
    const d = lit ? v % 10 : -1; v = (v - (d < 0 ? 0 : d)) / 10;
    if (segVal[i] !== d) { segVal[i] = d; segs[i].dataset.d = d < 0 ? ' ' : SEG_CH[d]; }
  }
}
function renderHist(live: boolean) {
  // scoped to the current run only (reset in startSeries/startChamp, never persisted)
  const series = st.mode === 'series', cap = series ? SERIES_LEN : 10;
  const h = st.hist.slice(-(live ? cap - 1 : cap)).concat(live ? ['now'] : []);
  if (series) while (h.length < cap) h.push('p'); else while (h.length < cap) h.unshift('p');
  $('histLbl').textContent = series ? 'This series' : 'This run';
  $('hist').classList.toggle('is-series', series);
  $('hist').innerHTML = h.map(c => `<b class="${c}"></b>`).join('');
}
function stamp() {
  const d = new Date(), p = (n: number, l = 2) => String(n).padStart(l, '0');
  $('tsDate').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  $('tsTime').innerHTML = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}<span class="ms">.${p(d.getMilliseconds(), 3)}</span>`;
}
function bz(err: string | null) {
  const b = $('bzr');
  if (err) { b.className = 'bz err mb2-label'; b.innerHTML = `<span class="mb2-stripes"></span>${err}`; }
  else { b.className = 'bz mb2-label'; b.textContent = 'Scan 60 Hz'; }
}
function clearGrid() { for (const c of cells) { if (c.className !== 'mb2-cell') c.className = 'mb2-cell'; if (c.firstChild) c.replaceChildren(); } st.layout.clear(); st.digitCells.length = 0; }

// ---------- panels ----------
const PANELS = ['menu', 'setup', 'results', 'boards'];
/** The countdown panel is never display:none'd; it fades by opacity only (compositor), so revealing the
 *  pre-rendered grid underneath costs no layout. */
const cdPanel = $('cdPanel');
function cdVisible(on: boolean) { cdPanel.classList.toggle('is-off', !on); }
function show(panel: string | null) {
  for (const p of PANELS) $(p).classList.toggle('hidden', p !== panel);
  $('resultCard').classList.add('hidden');
  if (panel) cdVisible(false);
}
function toMenu() {
  cancelTimers(); st.trialId++; st.phase = 'menu';
  clearGrid(); readout(0); bz(null); setPose('idle', 'IDLE');
  show('menu');
}

// ---------- trial core (paint-safe, trialId-gated, frame-accurate) ----------
let onTrialDone: (ok: boolean, ms: number, expected: number) => void = () => {};
const memoFor = () => st.mode === 'series' ? st.memo : LEVELS[Math.min(st.round, LEVELS.length - 1)].ms;

function hud(label: string) {
  st.trial++;
  $('trialNo').textContent = String(st.trial).padStart(3, '0');
  $('levelNo').textContent = label;
  $('nLbl').textContent = `n = ${st.n} · ${memoFor()} ms`;
  bz(null); setPose('focused', 'TRIAL'); stamp(); readout(0); renderHist(true);
  $('resultCard').classList.add('hidden');
}

/** Place all n digits in one synchronous pass (pre-decoded clones). Called behind the countdown. */
function placeDigits() {
  clearGrid();
  const pool: number[] = []; for (let i = 0; i < CELLS; i++) pool.push(i);
  for (let k = 1; k <= st.n; k++) {
    const idx = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    st.layout.set(idx, k); st.digitCells.push(idx); cells[idx].appendChild(digitImg(k));
  }
  void grid.offsetHeight; // settle layout now, behind the countdown, not in the reveal frame
}

/** Countdown with absolute, frame-aligned deadlines; digits are pre-rendered under the panel during the
 *  last second, and the reveal frame's rAF timestamp starts both the memorise window and the ms timer. */
async function beginTrial() {
  const id = ++st.trialId; st.next = 1; st.phase = 'countdown';
  await preloadAll();
  if (st.trialId !== id) return;
  clearGrid();
  const cd = st.cd;
  if (cd === 0) {
    show(null);
    atFrame(0, ts => { placeDigits(); reveal(ts, 0, 0); });
    return;
  }
  $('cdTrial').textContent = st.mode === 'series'
    ? `Trial ${String(st.attempts.length + 1).padStart(2, '0')}/${String(SERIES_LEN).padStart(2, '0')}`
    : `Round ${String(st.round + 1).padStart(2, '0')} · ${st.n} digits`;
  $('countdown').textContent = String(cd);
  show(null); cdVisible(true);
  atFrame(0, ts0 => {                       // first frame the countdown is on screen
    sfx('countdownTick');
    for (let i = 1; i < cd; i++) atFrame(ts0 + i * 1000, () => { $('countdown').textContent = String(cd - i); sfx('countdownTick'); });
    atFrame(ts0 + cd * 1000 - 600, () => placeDigits());   // pre-render under the panel
    atFrame(ts0 + cd * 1000, ts => { sfx('countdownGo'); cdVisible(false); reveal(ts, cd * 1000, ts - ts0); });
  });
}
/** ts = rAF timestamp of the frame in which the digits become visible. */
function reveal(ts: number, cdTarget: number, cdActual: number) {
  st.phase = 'show'; st.t0 = ts;
  const target = memoFor();
  atFrame(ts + target, t1 => {
    if (st.phase === 'show') { cover(); perf.trials.push({ target, actual: t1 - ts, cdTarget, cdActual });
    flushPerf(); }
  });
}
function cover() {
  st.phase = 'hidden';
  for (const i of st.digitCells) {
    const c = cells[i];
    if (c.classList.contains('cleared') || c.classList.contains('is-wrong')) continue;
    if (c.firstChild) c.replaceChildren(); c.classList.add('mb2-tile');
  }
}
function onTap(i: number, t: number) {
  if (st.phase !== 'show' && st.phase !== 'hidden') return;
  const k = st.layout.get(i);
  if (k === undefined) return;
  const slot = inCount++ % IN_N;
  inHandler[slot] = performance.now() - t;
  requestAnimationFrame(() => { inFeedback[slot] = performance.now() - t; });
  if (st.phase === 'show') cover();
  if (k === st.next) {
    cells[i].className = 'mb2-cell cleared'; if (cells[i].firstChild) cells[i].replaceChildren();
    st.next++; sfx('tap', { index: k });
    if (k === st.n) endTrial(true, t, 0);
  } else {
    cells[i].className = 'mb2-cell mb2-tile is-wrong'; sfx('wrong');
    endTrial(false, t, st.next);
  }
}
function endTrial(ok: boolean, t: number, expected: number) {
  cancelTimers();
  st.phase = 'done';
  const ms = Math.round(t - st.t0); readout(ms);
  // heavier, allocating work runs after the feedback frame, never in the tap handler
  const id = st.trialId;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (st.trialId !== id) return;
    st.hist.push(ok ? '' : 'f'); renderHist(false);
    if (ok) setPose('success', 'PASS');
    else {
      setPose('fail', 'FAIL', true); bz(`ERR · Expected ${expected}`);
      for (const [i, k] of st.layout) if (k >= expected && !cells[i].classList.contains('is-wrong')) {
        cells[i].classList.remove('mb2-tile'); cells[i].replaceChildren(digitImg(k, 0.45));
      }
    }
    flushPerf();
  }));
  if (ok) { later(() => sfx('reward'), 130); later(() => sfx('chimpHappy'), 480); }
  else later(() => sfx('chimpSulk'), 380);
  onTrialDone(ok, ms, expected);
}
/** Between-trial bottom sheet. Shown only after the trial ended; primary tap debounced + trialId-gated. */
let cardPrimary: (() => void) | null = null, cardMenu: (() => void) | null = null;
press($('cardPrimary'), () => cardPrimary?.());
press($('cardSecondary'), () => cardMenu?.());
function card(ok: boolean, ms: number, sub: string, primary: string, onPrimary: () => void, delay: number) {
  const id = st.trialId;
  const P = $('cardPrimary') as HTMLButtonElement;
  $('cardTag').innerHTML = ok
    ? `<span class="pass">PASS</span><span>${ms}<span class="ms"> ms</span></span>`
    : `<span class="mb2-chip is-fail">FAIL</span><span>${ms}<span class="ms"> ms</span></span>`;
  $('cardMsg').textContent = sub; P.textContent = primary; P.disabled = false;
  let used = false;
  cardPrimary = () => {
    if (used || st.trialId !== id || st.phase !== 'done' || $('resultCard').classList.contains('hidden')) return;
    used = true; P.disabled = true; sfx('click');
    $('resultCard').classList.add('hidden'); onPrimary();
  };
  cardMenu = () => { if (used) return; used = true; sfx('click'); toMenu(); };
  later(() => { if (st.phase === 'done') $('resultCard').classList.remove('hidden'); }, delay);
}

// ---------- SERIES ----------
const memoLabel = (m: number) => m >= 1000 ? `${m / 1000} s` : `${m / 1000} s`;
const skillOf = (id: string) => SKILLS.find(s => s.id === id)!;
function loadSetup() {
  try { const s = JSON.parse(localStorage.getItem(LS.setup) || '{}'); if (skillOf(s.skill)) st.skill = s.skill; if (MEMOS.includes(s.memo)) st.memo = s.memo; } catch {}
}
function renderSetup() {
  $('skillSeg').innerHTML = SKILLS.map(s => `<button type="button" class="mb2-pill${s.id === st.skill ? ' is-on' : ''}" data-skill="${s.id}">${s.n}<small>${s.hint}</small></button>`).join('');
  $('memoSeg').innerHTML = MEMOS.map(m => `<button type="button" class="mb2-pill${m === st.memo ? ' is-on' : ''}" data-memo="${m}">${m / 1000}s</button>`).join('');
  ($('memoBar') as HTMLElement).style.width = `${((MEMOS.indexOf(st.memo) + 1) / MEMOS.length) * 100}%`;
  $('expo').textContent = `Exposure ${(st.memo / 1000).toFixed(3)} s · ${skillOf(st.skill).n} digits`;
}
press($('skillSeg'), e => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; sfx('click'); st.skill = b.dataset.skill!; saveSetup(); renderSetup(); });
press($('memoSeg'), e => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; sfx('click'); st.memo = +b.dataset.memo!; saveSetup(); renderSetup(); });
function renderCd() {
  document.querySelectorAll<HTMLElement>('[data-cd-pills]').forEach(el => {
    el.innerHTML = CDS.map(c => `<button type="button" class="mb2-pill${c === st.cd ? ' is-on' : ''}" data-cd="${c}">${c ? c + 's' : 'Off'}</button>`).join('');
  });
}
document.querySelectorAll<HTMLElement>('[data-cd-pills]').forEach(el => press(el, e => {
  const b = (e.target as HTMLElement).closest('button'); if (!b) return;
  st.cd = +b.dataset.cd!; localStorage.setItem(LS.cd, String(st.cd)); sfx('click'); renderCd();
}));
function saveSetup() { localStorage.setItem(LS.setup, JSON.stringify({ skill: st.skill, memo: st.memo })); }

function startSeries() {
  st.hist = [];
  st.mode = 'series'; st.n = skillOf(st.skill).n; st.bf = { n: st.n, memo: st.memo }; st.attempts = [];
  show(null); nextAttempt();
}
function nextAttempt() {
  hud(`${st.attempts.length + 1}/${SERIES_LEN}`);
  void beginTrial();
  onTrialDone = (ok, ms, expected) => {
    st.attempts.push({ ok, ms });
    const last = st.attempts.length >= SERIES_LEN;
    const k = st.attempts.length;
    card(ok, ms, `Attempt ${k}/${SERIES_LEN} · ${st.n} digits${ok ? '' : ` · expected ${expected}`} · ${st.attempts.filter(a => a.ok).length} correct`,
      last ? 'See results' : 'Next attempt', () => last ? seriesResults() : nextAttempt(), ok ? 600 : 800);
  };
}
function seriesScore(n: number, memo: number, att: Attempt[]) {
  // per correct attempt: 100 per digit + speed bonus (up to 300), scaled by memorise difficulty
  const f = Math.sqrt(2000 / memo);
  return Math.round(att.filter(a => a.ok).reduce((s, a) => s + n * 100 + Math.max(0, 3000 - a.ms) / 10, 0) * f);
}
function seriesResults() {
  const okA = st.attempts.filter(a => a.ok);
  const avg = okA.length ? Math.round(okA.reduce((s, a) => s + a.ms, 0) / okA.length) : null;
  const best = okA.length ? Math.min(...okA.map(a => a.ms)) : null;
  const entry: SeriesEntry = { name: '', skill: st.skill, n: st.n, memo: st.memo, ok: okA.length, avg, best,
    score: seriesScore(st.n, st.memo, st.attempts), at: Date.now() };
  if (isSuspect('series', entry)) entry.suspect = true;
  showResults({
    top: `Series · ${st.n} digits · memorise ${memoLabel(st.memo)}`,
    pose: okA.length >= 3 ? 'success' : 'fail', key: 'Score', title: `${okA.length} / ${SERIES_LEN}`,
    stats: [['Avg', sec(avg)], ['Fastest', sec(best)], ['Points', String(entry.score)]],
    list: st.attempts.map((a, i) => [`#${String(i + 1).padStart(2, '0')}`, a.ok, a.ok ? sec(a.ms) : '—']),
    board: 'series', entry, again: startSeries,
  });
}

// ---------- CHAMPIONSHIP ----------
function startChamp() {
  st.hist = [];
  st.mode = 'champ'; st.round = 0; st.champTimes = [];
  show(null); nextRound();
}
function nextRound() {
  st.n = LEVELS[Math.min(st.round, LEVELS.length - 1)].n;
  hud(String(st.round + 1));
  void beginTrial();
  onTrialDone = (ok, ms, expected) => {
    if (ok) {
      st.champTimes.push(ms); st.round++;
      card(true, ms, `Round ${st.round} · ${st.n} digits`, 'Next round', nextRound, 600);
    } else {
      card(false, ms, `Round ${st.round + 1} · ${st.n} digits · expected ${expected} · game over`, 'See results', champResults, 800);
    }
  };
}
function champResults() {
  const t = st.champTimes, total = t.reduce((s, x) => s + x, 0);
  const avg = t.length ? Math.round(total / t.length) : null;
  const digits = t.length ? LEVELS[Math.min(t.length - 1, LEVELS.length - 1)].n : 0;
  const entry: ChampEntry = { name: '', rounds: t.length, digits, total, avg, at: Date.now() };
  if (isSuspect('champ', entry)) entry.suspect = true;
  showResults({
    top: `Championship · ${t.length} round${t.length === 1 ? '' : 's'} cleared`, pose: t.length >= 3 ? 'success' : 'fail',
    key: 'Digits reached', title: String(digits || 0),
    stats: [['Total time', sec(t.length ? total : null)], ['Avg / round', sec(avg)]],
    list: [...t.map((ms, i) => [`R${String(i + 1).padStart(2, '0')}`, true, `${LEVELS[Math.min(i, LEVELS.length - 1)].n}d · ${sec(ms)}`]),
      [`R${String(t.length + 1).padStart(2, '0')}`, false, `${LEVELS[Math.min(t.length, LEVELS.length - 1)].n}d · —`]],
    board: 'champ', entry, again: startChamp,
  });
}

// ---------- results + leaderboards ----------
function loadBoard<T>(m: Mode): T[] { try { return JSON.parse(localStorage.getItem(LS[m]) || '[]'); } catch { return []; } }
function saveBoard(m: Mode, b: unknown[]) { localStorage.setItem(LS[m], JSON.stringify(b)); }
const nz = (x: number | null) => x == null ? Infinity : x;
function cmp(m: Mode) {
  return m === 'series'
    ? (a: SeriesEntry, b: SeriesEntry) => b.ok - a.ok || nz(a.avg) - nz(b.avg) || a.at - b.at
    : (a: ChampEntry, b: ChampEntry) => b.rounds - a.rounds || nz(champTotal(a)) - nz(champTotal(b)) || a.at - b.at;
}
/** Series entries are ranked per digits+memorise combo (countdown is not part of the key). */
const sameKey = (m: Mode, a: any, b: { n: number; memo: number }) => m !== 'series' || (a.n === b.n && a.memo === b.memo);
function boardView(m: Mode, f = st.bf): any[] { return loadBoard<any>(m).filter(e => sameKey(m, e, f)).sort(cmp(m) as any); }
function qualifies(m: Mode, e: any) {
  if ((m === 'series' ? e.ok : e.rounds) === 0) return false;
  const b = boardView(m, e);
  if (b.length < 10) return true;
  return (cmp(m) as any)(e, b[b.length - 1]) < 0;
}
const sec = (ms: number | null) => ms == null ? '—' : `${(ms / 1000).toFixed(3)}s`;
interface Res { top: string; pose: keyof typeof POSE; key: string; title: string; stats: string[][]; list: (string | boolean)[][]; board: Mode; entry: any; again: () => void }
let pending: { board: Mode; entry: any } | null = null;
let resH = { save: () => {}, again: () => {}, menu: () => {}, full: () => {} };
press($('rRank'), e => { if ((e.target as HTMLElement).closest('#rFull')) resH.full(); });
press($('rSave'), () => resH.save()); press($('rAgain'), () => resH.again());
press($('rMenu'), () => resH.menu()); press($('rBack'), () => resH.menu());
/** v0.3.9 rank block (GD v04 SPEC §1): position computed before saving, against that config's board. */
function renderRank(board: Mode, entry: any, q: boolean) {
  const b = boardView(board, entry);
  const all = q ? [...b, entry].sort(cmp(board) as any).slice(0, 10) : [...b, entry];
  const pos = all.indexOf(entry); // index in ranked list; unranked -> last
  let lo = Math.max(0, pos - 1), hi = lo + 3;
  if (hi > all.length) { hi = all.length; lo = Math.max(0, hi - 3); }
  const head = board === 'series' ? `Your rank · ${entry.n} digits · ${entry.memo / 1000}s` : 'Your rank · Championship';
  const cell = (e: any) => board === 'series'
    ? `<span class="r">${e.ok}/5</span><span class="r">${sec(e.avg)}</span>`
    : `<span class="c">${e.digits}</span><span class="r">${sec(champTotal(e))}</span>`;
  const rows = all.slice(lo, hi).map((e, k) => {
    const i = lo + k, you = e === entry;
    const rk = you && !q ? '#—' : `#${String(i + 1).padStart(2, '0')}`;
    return `<div class="mb2-row${you ? ' is-you' : ' is-nb'}${you && !q ? ' is-unranked' : ''}"><span class="rk">${rk}</span><span>${you ? 'YOU' : esc(e.name)}</span>${cell(e)}</div>`;
  }).join('');
  const note = q ? '' : `<div class="mb2-rank-note">Not in the top 10 · #10 is ${b.length ? sec(board === 'series' ? b[b.length - 1].avg : champTotal(b[b.length - 1])) : '—'}</div>`;
  const zero = (board === 'series' ? entry.ok : entry.rounds) === 0;
  $('rRank').innerHTML = `<div class="mb2-rank-head">${head}</div><div class="mb2-rows">${rows}</div>` +
    (zero ? `<div class="mb2-rank-note">No completed ${board === 'series' ? 'attempts' : 'rounds'} · not ranked</div>` : note) +
    `<button type="button" class="mb2-rank-link" id="rFull">Full board ›</button>`;
}
function showResults(r: Res) {
  cancelTimers(); st.trialId++; st.phase = 'menu';
  clearGrid(); setPose(r.pose, r.pose === 'success' ? 'PASS' : 'FAIL', r.pose === 'fail');
  $('rTop').textContent = r.top; $('rKey').textContent = r.key; $('rTitle').textContent = r.title;
  ($('rChimp') as HTMLImageElement).src = `${B}assets-v2/chimp/chimp-${r.pose}.webp`;
  $('rStats').innerHTML = r.stats.map(([k, v]) => `<div class="mb2-small">${k}</div><b>${v}</b>`).join('');
  $('rList').innerHTML = r.list.map(([a, ok, c]) =>
    `<div class="mb2-row"><span>${a}</span><span class="c"><span class="mb2-chip${ok ? ' is-pass' : ' is-fail'}">${ok ? 'Pass' : 'Fail'}</span></span><span class="r">${c}</span></div>`).join('');
  const q = qualifies(r.board, r.entry);
  pending = q ? { board: r.board, entry: r.entry } : null;
  renderRank(r.board, r.entry, q);
  $('rSave').classList.toggle('hidden', !q);
  $('rAgain').className = `mb2-btn ${q ? 'is-ghost' : 'is-primary'}`;
  resH = {
    save: () => { sfx('click'); postAgain = r.again; showBoards(r.board); },
    full: () => { sfx('click'); postAgain = r.again; if (r.board === 'series') st.bf = { n: r.entry.n, memo: r.entry.memo }; showBoards(r.board); },
    again: () => { sfx('click'); pending = null; r.again(); },
    menu: () => { sfx('click'); pending = null; toMenu(); },
  };
  show('results');
  if (r.pose === 'success') sfx(q ? 'newBest' : 'levelUp');
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const nameIn = $('nameIn') as HTMLInputElement;
function renderSlots() {
  const v = nameIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  if (nameIn.value !== v) nameIn.value = v;
  document.querySelectorAll<HTMLElement>('.mb2-name-slot').forEach((el, i) => {
    el.textContent = v[i] ?? (i === v.length ? '_' : ''); el.classList.toggle('is-cur', i === v.length);
  });
  if (nameClear) (nameClear as HTMLButtonElement).disabled = !v.length;
}
// Prefilled initials are "ghosted": first typed char replaces all, Backspace clears all.
// Android soft keyboards send keyCode 229 keydowns, so the input event is the source of truth.
let namePre = false;
const nameBox = nameIn.parentElement as HTMLElement;
function setPre(on: boolean) { namePre = on; nameBox.classList.toggle('is-pre', on); }
function clearName() { nameIn.value = ''; setPre(false); renderSlots(); }
nameIn.addEventListener('focus', () => { nameIn.select(); });
nameIn.addEventListener('beforeinput', (e: InputEvent) => {
  if (!namePre) return;
  const t = e.inputType || '';
  if (t.startsWith('delete')) { e.preventDefault(); clearName(); }
  else if (t.startsWith('insert') && e.data) { e.preventDefault(); nameIn.value = e.data; setPre(false); renderSlots(); }
});
nameIn.addEventListener('input', (e: Event) => {
  if (namePre) { // fallback when beforeinput was not cancellable (some IMEs)
    const ie = e as InputEvent, t = ie.inputType || '';
    if (t.startsWith('delete')) nameIn.value = '';
    else if (ie.data) nameIn.value = ie.data;
    setPre(false);
  }
  renderSlots();
});
nameIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { $('nameSave').click(); return; }
  if (namePre && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); clearName(); }
});
const nameClear = $('nameClear');
nameClear.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); clearName(); nameIn.focus(); });
nameClear.addEventListener('click', e => { e.preventDefault(); if (e.detail === 0) { clearName(); nameIn.focus(); } });
press($('nameSave'), () => {
  if (!pending) return;
  const name = (nameIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'AAA').slice(0, 3).padEnd(3, '-');
  localStorage.setItem(LS.name, name);
  const { board, entry } = pending; pending = null;
  entry.name = name;
  const all = loadBoard<any>(board), mine = [...all.filter(e => sameKey(board, e, entry)), entry].sort(cmp(board) as any).slice(0, 10);
  saveBoard(board, [...all.filter(e => !sameKey(board, e, entry)), ...mine]);
  st.lastEntryAt = entry.at; sfx('click'); showBoards(board);
});
/** set when the board is reached after a game: Retry replays the same mode + settings */
let postAgain: (() => void) | null = null;
function showBoards(tab: Mode) {
  $('bRetry').classList.toggle('hidden', !postAgain); $('bFoot').classList.toggle('is-solo', !postAgain);
  st.lastBoard = tab;
  $('tSeries').classList.toggle('is-active', tab === 'series'); $('tChamp').classList.toggle('is-active', tab === 'champ');
  const series = tab === 'series';
  $('bFilter').classList.toggle('hidden', !series);
  if (series) {
    $('fDigits').innerHTML = SKILLS.map(k => `<button type="button" class="mb2-pill${k.n === st.bf.n ? ' is-on' : ''}" data-fn="${k.n}">${k.n}</button>`).join('');
    $('fMemo').innerHTML = MEMOS.map(m => `<button type="button" class="mb2-pill${m === st.bf.memo ? ' is-on' : ''}" data-fm="${m}">${m / 1000}s</button>`).join('');
    $('bHead').textContent = `${st.bf.n} digits · ${st.bf.memo / 1000}s`;
  }
  const b = boardView(tab);
  // inline name card when a pending run qualifies for this board
  const p = pending && pending.board === tab && sameKey(tab, pending.entry, st.bf) ? pending : null;
  $('nameBox').classList.toggle('hidden', !p);
  if (p) {
    const rank = [...b, p.entry].sort(cmp(tab) as any).indexOf(p.entry) + 1;
    $('nameRank').textContent = `New high score · #${String(rank).padStart(2, '0')}`;
    nameIn.value = (localStorage.getItem(LS.name) || '').slice(0, 3); setPre(!!nameIn.value); renderSlots();
  }
  const rk = (i: number) => `<span class="rk">#${String(i + 1).padStart(2, '0')}</span>`;
  const cls = (e: any) => `mb2-row${e.at === st.lastEntryAt ? ' is-new' : ''}`;
  let html: string;
  if (tab === 'series') html = `<div class="mb2-row is-head"><span>Rank</span><span>Name</span><span class="r">Score</span><span class="r">Time</span></div>` +
    b.map((e: SeriesEntry, i: number) => `<div class="${cls(e)}">${rk(i)}<span>${esc(e.name)}</span><span class="r">${e.ok}/5</span><span class="r">${sec(e.avg)}</span></div>`).join('');
  else html = `<div class="mb2-row is-head"><span>Rank</span><span>Name</span><span class="c">Digits</span><span class="c">Rounds</span><span class="r">Total</span></div>` +
    b.map((e: ChampEntry, i: number) => `<div class="${cls(e)}">${rk(i)}<span>${esc(e.name)}</span><span class="c">${e.digits}</span><span class="c">${e.rounds}</span><span class="r">${sec(champTotal(e))}</span></div>`).join('');
  if (!b.length) html += `<div class="mb2-empty">No entries yet</div>`;
  $('boardBody').innerHTML = html;
  show('boards');
}

// ---------- menu ----------
let soundOn = localStorage.getItem(LS.sound) !== 'off';
function applySound() { setMuted(!soundOn); $('mSound').setAttribute('aria-pressed', String(soundOn)); $('mSoundLbl').textContent = `Sound ${soundOn ? 'on' : 'off'}`; }
press($('mSound'), () => { soundOn = !soundOn; localStorage.setItem(LS.sound, soundOn ? 'on' : 'off'); applySound(); sfx('click'); });
press($('mSeries'), () => { sfx('click'); ambient(true); renderSetup(); show('setup'); });
press($('sGo'), () => { sfx('click'); startSeries(); });
press($('sBack'), () => { sfx('click'); toMenu(); });
press($('mChamp'), () => { sfx('click'); ambient(true); startChamp(); });
press($('mBoards'), () => { sfx('click'); postAgain = null; showBoards(st.lastBoard); });
press($('bRetry'), () => { const f = postAgain; if (!f) return; sfx('click'); pending = null; postAgain = null; ambient(true); f(); });
press($('bMenu2'), () => { sfx('click'); pending = null; postAgain = null; toMenu(); });
press($('tSeries'), () => showBoards('series'));
press($('tChamp'), () => showBoards('champ'));
press($('bFilter'), e => {
  const b = (e.target as HTMLElement).closest('button'); if (!b) return;
  if (b.dataset.fn) st.bf = { ...st.bf, n: +b.dataset.fn }; if (b.dataset.fm) st.bf = { ...st.bf, memo: +b.dataset.fm };
  sfx('click'); showBoards('series');
});
press($('bMenu'), () => { sfx('click'); pending = null; toMenu(); });

{ const c = Number(localStorage.getItem(LS.cd) ?? 3); st.cd = CDS.includes(c) ? c : 3; }
loadSetup(); st.bf = { n: skillOf(st.skill).n, memo: st.memo }; renderCd(); applySound(); readout(0); renderHist(false); stamp(); setPose('idle', 'IDLE'); show('menu');
void initAudio(); void preloadAll();
