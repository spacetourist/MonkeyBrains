import './style.css';
import { initAudio, sfx, ambient } from './audio';

const B = import.meta.env.BASE_URL;
const $ = (id: string) => document.getElementById(id)!;
const COLS = 5, ROWS = 8, CELLS = COLS * ROWS;
// Levels: digits 4..9 at 2000 ms, then 9 digits with shorter display.
const LEVELS: { n: number; ms: number }[] = [
  ...[4, 5, 6, 7, 8, 9].map(n => ({ n, ms: 2000 })),
  ...[1500, 1000, 700, 500, 350, 210].map(ms => ({ n: 9, ms })),
];
const POSE: Record<string, number> = { idle: 594, focused: 585, success: 772, fail: 574 };

type Phase = 'start' | 'show' | 'hidden' | 'done';
const st = { level: 0, trial: 0, phase: 'start' as Phase, next: 1, layout: new Map<number, number>(),
  t0: 0, tEnd: 0, hideTimer: 0, raf: 0, hist: [] as string[], best: new Map<number, number>() };
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
  d.className = 'mb2-cell'; d.dataset.cell = String(i);
  d.addEventListener('pointerdown', e => { e.preventDefault(); onTap(i, performance.now()); });
  grid.appendChild(d); cells.push(d);
}

function setPose(p: keyof typeof POSE, label: string, red = false) {
  const c = $('chimp') as HTMLImageElement;
  c.src = `${B}assets-v2/chimp/chimp-${p}.webp`; c.style.width = POSE[p] / 3 + 'px';
  const s = $('stateLbl'); s.textContent = label; s.style.color = red ? 'var(--mb2-signal)' : '';
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
  $('tsTime').innerHTML = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}<span class="ms">.${p(d.getMilliseconds(), 3)}</span>`;
}
function bz(err: string | null) {
  const b = $('bzr');
  if (err) { b.className = 'bz err mb2-label'; b.innerHTML = `<span class="mb2-stripes"></span>${err}`; }
  else { b.className = 'bz mb2-label'; b.textContent = 'Scan 60 Hz'; }
}
function tick() { readout(performance.now() - st.t0); st.raf = requestAnimationFrame(tick); }

function startTrial() {
  const L = LEVELS[st.level];
  st.trial++; st.next = 1; st.layout.clear();
  $('resultCard').classList.add('hidden');
  $('trialNo').textContent = String(st.trial).padStart(3, '0');
  $('levelNo').textContent = String(st.level + 1);
  $('nLbl').textContent = `n = ${L.n} · ${L.ms} ms`;
  bz(null); setPose('focused', 'TRIAL'); stamp();
  const pool = [...Array(CELLS).keys()];
  for (let k = 1; k <= L.n; k++) st.layout.set(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], k);
  cells.forEach((c, i) => {
    c.className = 'mb2-cell'; c.innerHTML = '';
    const k = st.layout.get(i);
    if (k) { const im = new Image(); im.src = `${B}assets-v2/svg/digit-${k}.svg`; im.className = 'cell-digit'; im.alt = ''; c.appendChild(im); }
  });
  st.phase = 'show'; renderHist();
  st.t0 = performance.now(); cancelAnimationFrame(st.raf); tick();
  clearTimeout(st.hideTimer);
  st.hideTimer = window.setTimeout(() => { if (st.phase === 'show') cover(); }, L.ms);
}
function cover() {
  st.phase = 'hidden';
  for (const [i] of st.layout) if (!cells[i].classList.contains('cleared')) {
    cells[i].innerHTML = ''; cells[i].classList.add('mb2-tile');
  }
}
function onTap(i: number, t: number) {
  if (st.phase !== 'show' && st.phase !== 'hidden') return;
  const k = st.layout.get(i);
  if (k === undefined) return; // empty cells are ignored
  const n = LEVELS[st.level].n;
  if (k === st.next) {
    if (st.phase === 'show') { clearTimeout(st.hideTimer); cover(); }
    const c = cells[i]; c.className = 'mb2-cell cleared'; c.innerHTML = '';
    st.next++;
    sfx('tap', { index: k });
    if (k === n) finish(true, t);
  } else {
    if (st.phase === 'show') { clearTimeout(st.hideTimer); cover(); }
    cells[i].className = 'mb2-cell mb2-tile is-wrong';
    sfx('wrong');
    finish(false, t, st.next);
  }
}
function finish(ok: boolean, t: number, expected = 0) {
  st.phase = 'done'; cancelAnimationFrame(st.raf);
  const ms = Math.round(t - st.t0); readout(ms); st.tEnd = ms;
  st.hist.push(ok ? '' : 'f'); renderHist();
  const tag = $('cardTag'), msg = $('cardMsg'), p = $('cardPrimary'), s = $('cardSecondary');
  if (ok) {
    const prev = st.best.get(st.level), isBest = prev === undefined || ms < prev;
    if (isBest) st.best.set(st.level, ms);
    setPose('success', 'PASS');
    setTimeout(() => sfx('reward'), 130); setTimeout(() => sfx('chimpHappy'), 480);
    const last = st.level >= LEVELS.length - 1;
    setTimeout(() => sfx(isBest && prev !== undefined ? 'newBest' : 'levelUp'), 1500);
    tag.className = 'tag ok mb2-label'; tag.textContent = 'Trial passed';
    msg.innerHTML = `<span class="ms-big">${ms} ms</span>Level ${st.level + 1} · n = ${LEVELS[st.level].n}${isBest && prev !== undefined ? ' · new best' : ''}`;
    p.textContent = last ? 'Repeat final level' : 'Next level';
    p.onclick = () => { sfx('click'); if (!last) st.level++; startTrial(); };
  } else {
    setPose('fail', 'FAIL', true); bz(`ERR · Expected ${expected}`);
    setTimeout(() => sfx('chimpSulk'), 380);
    // reveal remaining positions
    for (const [i, k] of st.layout) if (k >= expected && !cells[i].classList.contains('is-wrong')) {
      cells[i].classList.remove('mb2-tile'); cells[i].innerHTML = `<img class="cell-digit" src="${B}assets-v2/svg/digit-${k}.svg" alt="" style="opacity:.45">`;
    }
    tag.className = 'tag bad mb2-label'; tag.textContent = 'Trial failed';
    msg.innerHTML = `<span class="ms-big">${ms} ms</span>Expected ${expected}. Level ${st.level + 1}.`;
    p.textContent = 'Retry';
    p.onclick = () => { sfx('click'); startTrial(); };
  }
  s.classList.add('hidden');
  setTimeout(() => { if (st.phase === 'done') $('resultCard').classList.remove('hidden'); }, ok ? 700 : 900);
}

readout(0); renderHist(); stamp(); setPose('idle', 'IDLE');
void initAudio();
$('startBtn').addEventListener('click', () => {
  sfx('click'); ambient(true);
  $('startOverlay').classList.add('hidden'); startTrial();
});
