import './style.css';
import { initAudio, sfx, ambient } from './audio';

const B = import.meta.env.BASE_URL;
const $ = (id: string) => document.getElementById(id)!;
const COLS = 5, ROWS = 8, CELLS = COLS * ROWS;
const LEVELS: { n: number; ms: number }[] = [
  ...[4, 5, 6, 7, 8, 9].map(n => ({ n, ms: 2000 })),
  ...[1500, 1000, 700, 500, 350, 210].map(ms => ({ n: 9, ms })),
];
const POSE: Record<string, number> = { idle: 594, focused: 585, success: 772, fail: 574 };

/** Phases: arming = digits placed, waiting for paint; show/hidden = live trial; done = result. */
type Phase = 'start' | 'arming' | 'show' | 'hidden' | 'done';

const st = {
  level: 0, trial: 0, trialId: 0, phase: 'start' as Phase, next: 1,
  layout: new Map<number, number>(),
  /** Cell indices that received a digit this trial — cover() uses only these. */
  digitCells: [] as number[],
  t0: 0, tEnd: 0, hideTimer: 0, cardTimer: 0, raf: 0,
  hist: [] as string[], best: new Map<number, number>(),
};
(window as any).__mb = st;

$('verLabel').textContent = 'v' + __VERSION__;

function fit() {
  const app = $('app'), lab = $('lab');
  const s = Math.min(app.clientWidth / 390, app.clientHeight / 844);
  lab.style.transform = `translateX(-50%) scale(${s})`;
}
addEventListener('resize', fit); fit();

const grid = $('grid');
const cells: HTMLDivElement[] = [];
for (let i = 0; i < CELLS; i++) {
  const d = document.createElement('div');
  d.className = 'mb2-cell';
  d.dataset.cell = String(i);
  d.addEventListener('pointerdown', e => { e.preventDefault(); onTap(i, performance.now()); });
  grid.appendChild(d);
  cells.push(d);
}

/** Preloaded digit SVGs (decode complete). Cloned into cells so paint is sync. */
const digitUrl = (k: number) => `${B}assets-v2/svg/digit-${k}.svg`;
const digitCache = new Map<number, HTMLImageElement>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = 'sync';
    im.onload = () => {
      const done = () => resolve(im);
      if (im.decode) im.decode().then(done, done);
      else done();
    };
    im.onerror = () => reject(new Error('load failed: ' + src));
    im.src = src;
  });
}

async function preloadDigits(): Promise<void> {
  await Promise.all(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(async k => {
      const im = await loadImage(digitUrl(k));
      digitCache.set(k, im);
    }),
  );
}

function waitFonts(): Promise<void> {
  if (document.fonts?.ready) return document.fonts.ready.then(() => undefined);
  return Promise.resolve();
}

/** Two animation frames so the browser has committed a paint of the digits. */
function afterPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function setPose(p: keyof typeof POSE, label: string, red = false) {
  const c = $('chimp') as HTMLImageElement;
  c.src = `${B}assets-v2/chimp/chimp-${p}.webp`;
  c.style.width = POSE[p] / 3 + 'px';
  const s = $('stateLbl');
  s.textContent = label;
  s.style.color = red ? 'var(--mb2-signal)' : '';
}

function readout(ms: number) {
  const v = Math.min(9999, Math.max(0, Math.round(ms)));
  const str = ' ' + String(v).padStart(4, '0');
  $('readout').innerHTML = [...str].map(ch => `<span class="mb2-seg" data-d="${ch}"></span>`).join('');
}

function renderHist() {
  const h = st.hist.slice(-9).concat(st.phase === 'done' ? [] : ['now']);
  while (h.length < 10) h.unshift('p');
  $('hist').innerHTML = h.slice(-10).map(c => `<b class="${c}"></b>`).join('');
}

function stamp() {
  const d = new Date(), p = (n: number, l = 2) => String(n).padStart(l, '0');
  $('tsDate').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  $('tsTime').innerHTML =
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}<span class="ms">.${p(d.getMilliseconds(), 3)}</span>`;
}

function bz(err: string | null) {
  const b = $('bzr');
  if (err) {
    b.className = 'bz err mb2-label';
    b.innerHTML = `<span class="mb2-stripes"></span>${err}`;
  } else {
    b.className = 'bz mb2-label';
    b.textContent = 'Scan 60 Hz';
  }
}

function tick() {
  readout(performance.now() - st.t0);
  st.raf = requestAnimationFrame(tick);
}

/** Cancel every trial-scoped timer / raf. Call before starting a new trial. */
function cancelTrialTimers() {
  clearTimeout(st.hideTimer);
  clearTimeout(st.cardTimer);
  cancelAnimationFrame(st.raf);
  st.hideTimer = 0;
  st.cardTimer = 0;
  st.raf = 0;
}

/**
 * Place all n digits in one synchronous pass using preloaded Image clones.
 * No async image loads during the trial.
 */
function placeDigits(n: number): void {
  st.layout.clear();
  st.digitCells = [];
  const pool = [...Array(CELLS).keys()];
  for (let k = 1; k <= n; k++) {
    const idx = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    st.layout.set(idx, k);
    st.digitCells.push(idx);
  }
  cells.forEach((c, i) => {
    c.className = 'mb2-cell';
    c.innerHTML = '';
    const k = st.layout.get(i);
    if (k != null) {
      const src = digitCache.get(k);
      const im = src ? (src.cloneNode(true) as HTMLImageElement) : new Image();
      if (!(src)) im.src = digitUrl(k);
      im.className = 'cell-digit';
      im.alt = '';
      im.decoding = 'sync';
      c.appendChild(im);
    }
  });
}

/** Cover exactly the digits placed this trial (st.digitCells), nothing else. */
function cover() {
  st.phase = 'hidden';
  for (const i of st.digitCells) {
    const c = cells[i];
    if (c.classList.contains('cleared') || c.classList.contains('is-wrong')) continue;
    c.innerHTML = '';
    c.classList.add('mb2-tile');
  }
}

function onTap(i: number, t: number) {
  // Ignore taps until digits have painted and timers have started.
  if (st.phase !== 'show' && st.phase !== 'hidden') return;
  const k = st.layout.get(i);
  if (k === undefined) return;
  const n = LEVELS[st.level].n;
  if (k === st.next) {
    if (st.phase === 'show') {
      clearTimeout(st.hideTimer);
      st.hideTimer = 0;
      cover();
    }
    const c = cells[i];
    c.className = 'mb2-cell cleared';
    c.innerHTML = '';
    st.next++;
    sfx('tap', { index: k });
    if (k === n) finish(true, t);
  } else {
    if (st.phase === 'show') {
      clearTimeout(st.hideTimer);
      st.hideTimer = 0;
      cover();
    }
    cells[i].className = 'mb2-cell mb2-tile is-wrong';
    sfx('wrong');
    finish(false, t, st.next);
  }
}

function finish(ok: boolean, t: number, expected = 0) {
  const id = st.trialId;
  st.phase = 'done';
  cancelAnimationFrame(st.raf);
  st.raf = 0;
  const ms = Math.round(t - st.t0);
  readout(ms);
  st.tEnd = ms;
  st.hist.push(ok ? '' : 'f');
  renderHist();
  const tag = $('cardTag'), msg = $('cardMsg'), p = $('cardPrimary'), s = $('cardSecondary');
  if (ok) {
    const prev = st.best.get(st.level);
    const isBest = prev === undefined || ms < prev;
    if (isBest) st.best.set(st.level, ms);
    setPose('success', 'PASS');
    const last = st.level >= LEVELS.length - 1;
    // SFX delays are fire-and-forget; they don't touch DOM/layout.
    setTimeout(() => { if (st.trialId === id) sfx('reward'); }, 130);
    setTimeout(() => { if (st.trialId === id) sfx('chimpHappy'); }, 480);
    setTimeout(() => {
      if (st.trialId === id) sfx(isBest && prev !== undefined ? 'newBest' : 'levelUp');
    }, 1500);
    tag.className = 'tag ok mb2-label';
    tag.textContent = 'Trial passed';
    msg.innerHTML =
      `<span class="ms-big">${ms} ms</span>Level ${st.level + 1} · n = ${LEVELS[st.level].n}` +
      (isBest && prev !== undefined ? ' · new best' : '');
    p.textContent = last ? 'Repeat final level' : 'Next level';
    p.onclick = () => {
      sfx('click');
      if (!last) st.level++;
      void startTrial();
    };
  } else {
    setPose('fail', 'FAIL', true);
    bz(`ERR · Expected ${expected}`);
    setTimeout(() => { if (st.trialId === id) sfx('chimpSulk'); }, 380);
    for (const [i, k] of st.layout) {
      if (k >= expected && !cells[i].classList.contains('is-wrong')) {
        cells[i].classList.remove('mb2-tile');
        const src = digitCache.get(k);
        const im = src ? (src.cloneNode(true) as HTMLImageElement) : new Image();
        if (!src) im.src = digitUrl(k);
        im.className = 'cell-digit';
        im.alt = '';
        im.style.opacity = '0.45';
        cells[i].innerHTML = '';
        cells[i].appendChild(im);
      }
    }
    tag.className = 'tag bad mb2-label';
    tag.textContent = 'Trial failed';
    msg.innerHTML = `<span class="ms-big">${ms} ms</span>Expected ${expected}. Level ${st.level + 1}.`;
    p.textContent = 'Retry';
    p.onclick = () => {
      sfx('click');
      void startTrial();
    };
  }
  s.classList.add('hidden');
  clearTimeout(st.cardTimer);
  st.cardTimer = window.setTimeout(() => {
    if (st.trialId === id && st.phase === 'done') $('resultCard').classList.remove('hidden');
  }, ok ? 700 : 900);
}

async function startTrial() {
  cancelTrialTimers();
  const id = ++st.trialId;
  const L = LEVELS[st.level];
  st.trial++;
  st.next = 1;
  st.phase = 'arming'; // taps ignored
  $('resultCard').classList.add('hidden');
  $('trialNo').textContent = String(st.trial).padStart(3, '0');
  $('levelNo').textContent = String(st.level + 1);
  $('nLbl').textContent = `n = ${L.n} · ${L.ms} ms`;
  bz(null);
  setPose('focused', 'TRIAL');
  stamp();
  readout(0);
  renderHist();

  // Ensure assets are ready (no-op after first trial once preloaded).
  if (digitCache.size < 9) await preloadDigits();
  if (st.trialId !== id) return; // superseded by a newer startTrial

  placeDigits(L.n); // one synchronous DOM pass

  await afterPaint();
  if (st.trialId !== id) return;

  // Timers only start once every digit is placed and painted.
  st.phase = 'show';
  st.t0 = performance.now();
  tick();
  st.hideTimer = window.setTimeout(() => {
    if (st.trialId === id && st.phase === 'show') cover();
  }, L.ms);
}

readout(0);
renderHist();
stamp();
setPose('idle', 'IDLE');

void (async () => {
  await Promise.all([initAudio(), waitFonts(), preloadDigits()]);
})();

$('startBtn').addEventListener('pointerdown', () => {
  sfx('click');
  ambient(true);
  $('startOverlay').classList.add('hidden');
  void startTrial();
});
