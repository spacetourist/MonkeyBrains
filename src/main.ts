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
interface SeriesEntry { name: string; skill: string; n: number; memo: number; ok: number; avg: number | null; best: number | null; score: number; at: number }
interface ChampEntry { name: string; rounds: number; digits: number; total: number; avg: number | null; at: number }

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

// ---------- timers tied to the current trial ----------
function later(fn: () => void, ms: number) {
  const id = st.trialId;
  const h = window.setTimeout(() => { st.timers.delete(h); if (st.trialId === id) fn(); }, ms);
  st.timers.add(h);
}
function cancelTimers() {
  for (const h of st.timers) clearTimeout(h);
  st.timers.clear(); cancelAnimationFrame(st.raf); st.raf = 0;
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
  d.addEventListener('pointerdown', e => { e.preventDefault(); onTap(i, performance.now()); });
  grid.appendChild(d); cells.push(d);
}

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
    document.fonts?.ready ?? Promise.resolve(),
  ]).then(() => undefined);
  return preload;
}
const afterPaint = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
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
function readout(ms: number) {
  const v = Math.min(9999, Math.max(0, Math.round(ms)));
  $('readout').innerHTML = [...(' ' + String(v).padStart(4, '0'))].map(ch => `<span class="mb2-seg" data-d="${ch}"></span>`).join('');
}
function renderHist(live: boolean) {
  const h = st.hist.slice(-(live ? 9 : 10)).concat(live ? ['now'] : []);
  while (h.length < 10) h.unshift('p');
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
function tick() { readout(performance.now() - st.t0); st.raf = requestAnimationFrame(tick); }
function clearGrid() { cells.forEach(c => { c.className = 'mb2-cell'; c.innerHTML = ''; }); st.layout.clear(); st.digitCells = []; }

// ---------- panels ----------
const PANELS = ['menu', 'setup', 'cdPanel', 'results', 'boards'];
function show(panel: string | null) {
  for (const p of PANELS) $(p).classList.toggle('hidden', p !== panel);
  $('resultCard').classList.add('hidden');
}
function toMenu() {
  cancelTimers(); st.trialId++; st.phase = 'menu';
  clearGrid(); readout(0); bz(null); setPose('idle', 'IDLE');
  show('menu');
}

// ---------- trial core (paint-safe, trialId-gated) ----------
let onTrialDone: (ok: boolean, ms: number, expected: number) => void = () => {};
const memoFor = () => st.mode === 'series' ? st.memo : LEVELS[Math.min(st.round, LEVELS.length - 1)].ms;

function hud(label: string) {
  st.trial++;
  $('trialNo').textContent = String(st.trial).padStart(3, '0');
  $('levelNo').textContent = label;
  $('nLbl').textContent = `n = ${st.n} · ${memoFor()} ms`;
  bz(null); setPose('focused', 'TRIAL'); stamp(); readout(0); renderHist(true);
}

/** Countdown (full-screen panel, 3/2/1 s or off), then run the trial. One tick per remaining second, then Go. */
function countdownThen(fn: () => void) {
  st.phase = 'countdown'; clearGrid();
  if (st.cd === 0) { fn(); return; }
  $('cdTrial').textContent = st.mode === 'series'
    ? `Trial ${String(st.attempts.length + 1).padStart(2, '0')}/${String(SERIES_LEN).padStart(2, '0')}`
    : `Round ${String(st.round + 1).padStart(2, '0')} · ${st.n} digits`;
  show('cdPanel');
  const step = (k: number) => {
    if (k === 0) { sfx('countdownGo'); show(null); fn(); return; }
    $('countdown').textContent = String(k); sfx('countdownTick');
    later(() => step(k - 1), 1000);
  };
  step(st.cd);
}

async function runTrial() {
  cancelTimers();
  const id = ++st.trialId;
  st.next = 1; st.phase = 'arming';
  $('resultCard').classList.add('hidden');
  await preloadAll();
  if (st.trialId !== id) return;
  // place all n digits in one synchronous pass
  clearGrid();
  const pool = [...Array(CELLS).keys()];
  for (let k = 1; k <= st.n; k++) {
    const idx = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    st.layout.set(idx, k); st.digitCells.push(idx); cells[idx].appendChild(digitImg(k));
  }
  await afterPaint();
  if (st.trialId !== id) return;
  st.phase = 'show'; st.t0 = performance.now(); tick();
  later(() => { if (st.phase === 'show') cover(); }, memoFor());
}
function cover() {
  st.phase = 'hidden';
  for (const i of st.digitCells) {
    const c = cells[i];
    if (c.classList.contains('cleared') || c.classList.contains('is-wrong')) continue;
    c.innerHTML = ''; c.classList.add('mb2-tile');
  }
}
function onTap(i: number, t: number) {
  if (st.phase !== 'show' && st.phase !== 'hidden') return;
  const k = st.layout.get(i);
  if (k === undefined) return;
  if (st.phase === 'show') cover();
  if (k === st.next) {
    cells[i].className = 'mb2-cell cleared'; cells[i].innerHTML = '';
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
  st.hist.push(ok ? '' : 'f'); renderHist(false);
  if (ok) {
    setPose('success', 'PASS');
    later(() => sfx('reward'), 130); later(() => sfx('chimpHappy'), 480);
  } else {
    setPose('fail', 'FAIL', true); bz(`ERR · Expected ${expected}`);
    later(() => sfx('chimpSulk'), 380);
    for (const [i, k] of st.layout) if (k >= expected && !cells[i].classList.contains('is-wrong')) {
      cells[i].classList.remove('mb2-tile'); cells[i].innerHTML = ''; cells[i].appendChild(digitImg(k, 0.45));
    }
  }
  onTrialDone(ok, ms, expected);
}
/** Between-trial bottom sheet. Shown only after the trial ended; primary tap debounced + trialId-gated. */
function card(ok: boolean, ms: number, sub: string, primary: string, onPrimary: () => void, delay: number) {
  const id = st.trialId;
  const P = $('cardPrimary') as HTMLButtonElement, S = $('cardSecondary') as HTMLButtonElement;
  $('cardTag').innerHTML = ok
    ? `<span class="pass">PASS</span><span>${ms}<span class="ms"> ms</span></span>`
    : `<span class="mb2-chip is-fail">FAIL</span><span>${ms}<span class="ms"> ms</span></span>`;
  $('cardMsg').textContent = sub; P.textContent = primary; P.disabled = false;
  let used = false;
  P.onclick = () => {
    if (used || st.trialId !== id || st.phase !== 'done') return;
    used = true; P.disabled = true; sfx('click');
    $('resultCard').classList.add('hidden'); onPrimary();
  };
  S.onclick = () => { if (used) return; used = true; sfx('click'); toMenu(); };
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
$('skillSeg').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; sfx('click'); st.skill = b.dataset.skill!; saveSetup(); renderSetup(); });
$('memoSeg').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; sfx('click'); st.memo = +b.dataset.memo!; saveSetup(); renderSetup(); });
function renderCd() {
  document.querySelectorAll<HTMLElement>('[data-cd-pills]').forEach(el => {
    el.innerHTML = CDS.map(c => `<button type="button" class="mb2-pill${c === st.cd ? ' is-on' : ''}" data-cd="${c}">${c ? c + 's' : 'Off'}</button>`).join('');
  });
}
document.querySelectorAll<HTMLElement>('[data-cd-pills]').forEach(el => el.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button'); if (!b) return;
  st.cd = +b.dataset.cd!; localStorage.setItem(LS.cd, String(st.cd)); sfx('click'); renderCd();
}));
function saveSetup() { localStorage.setItem(LS.setup, JSON.stringify({ skill: st.skill, memo: st.memo })); }

function startSeries() {
  st.mode = 'series'; st.n = skillOf(st.skill).n; st.bf = { n: st.n, memo: st.memo }; st.attempts = [];
  show(null); nextAttempt();
}
function nextAttempt() {
  hud(`${st.attempts.length + 1}/${SERIES_LEN}`);
  st.trialId++;
  countdownThen(() => void runTrial());
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
  st.mode = 'champ'; st.round = 0; st.champTimes = [];
  show(null); nextRound();
}
function nextRound() {
  st.n = LEVELS[Math.min(st.round, LEVELS.length - 1)].n;
  hud(String(st.round + 1));
  st.trialId++;
  countdownThen(() => void runTrial());
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
  showResults({
    top: `Championship · ${t.length} round${t.length === 1 ? '' : 's'} cleared`, pose: t.length >= 3 ? 'success' : 'fail',
    key: 'Digits reached', title: String(digits || 0),
    stats: [['Total', sec(t.length ? total : null)], ['Avg', sec(avg)]],
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
    : (a: ChampEntry, b: ChampEntry) => b.rounds - a.rounds || nz(a.avg) - nz(b.avg) || a.at - b.at;
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
  $('rSave').classList.toggle('hidden', !q);
  $('rAgain').className = `mb2-btn ${q ? 'is-ghost' : 'is-primary'}`;
  ($('rSave') as HTMLButtonElement).onclick = () => { sfx('click'); showBoards(r.board); };
  ($('rAgain') as HTMLButtonElement).onclick = () => { sfx('click'); pending = null; r.again(); };
  ($('rMenu') as HTMLButtonElement).onclick = ($('rBack') as HTMLButtonElement).onclick = () => { sfx('click'); pending = null; toMenu(); };
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
}
nameIn.addEventListener('input', renderSlots);
nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('nameSave').click(); });
$('nameSave').addEventListener('click', () => {
  if (!pending) return;
  const name = (nameIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'AAA').slice(0, 3).padEnd(3, '-');
  localStorage.setItem(LS.name, name);
  const { board, entry } = pending; pending = null;
  entry.name = name;
  const all = loadBoard<any>(board), mine = [...all.filter(e => sameKey(board, e, entry)), entry].sort(cmp(board) as any).slice(0, 10);
  saveBoard(board, [...all.filter(e => !sameKey(board, e, entry)), ...mine]);
  st.lastEntryAt = entry.at; sfx('click'); showBoards(board);
});
function showBoards(tab: Mode) {
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
    nameIn.value = (localStorage.getItem(LS.name) || '').slice(0, 3); renderSlots();
  }
  const rk = (i: number) => `<span class="rk">#${String(i + 1).padStart(2, '0')}</span>`;
  const cls = (e: any) => `mb2-row${e.at === st.lastEntryAt ? ' is-new' : ''}`;
  let html: string;
  if (!b.length) html = `<div class="mb2-empty">No entries yet</div>`;
  else if (tab === 'series') html = `<div class="mb2-row is-head"><span>Rank</span><span>Name</span><span class="r">Score</span><span class="r">Time</span></div>` +
    b.map((e: SeriesEntry, i: number) => `<div class="${cls(e)}">${rk(i)}<span>${esc(e.name)}</span><span class="r">${e.ok}/5</span><span class="r">${sec(e.avg)}</span></div>`).join('');
  else html = `<div class="mb2-row is-head"><span>Rank</span><span>Name</span><span class="c">Digits</span><span class="r">Rounds</span><span class="r">Time</span></div>` +
    b.map((e: ChampEntry, i: number) => `<div class="${cls(e)}">${rk(i)}<span>${esc(e.name)}</span><span class="c">${e.digits}</span><span class="r">${e.rounds}</span><span class="r">${sec(e.avg)}</span></div>`).join('');
  $('boardBody').innerHTML = html;
  show('boards');
}

// ---------- menu ----------
let soundOn = localStorage.getItem(LS.sound) !== 'off';
function applySound() { setMuted(!soundOn); $('mSound').setAttribute('aria-pressed', String(soundOn)); $('mSoundLbl').textContent = `Sound ${soundOn ? 'on' : 'off'}`; }
$('mSound').addEventListener('click', () => { soundOn = !soundOn; localStorage.setItem(LS.sound, soundOn ? 'on' : 'off'); applySound(); sfx('click'); });
$('mSeries').addEventListener('click', () => { sfx('click'); ambient(true); renderSetup(); show('setup'); });
$('sGo').addEventListener('click', () => { sfx('click'); startSeries(); });
$('sBack').addEventListener('click', () => { sfx('click'); toMenu(); });
$('mChamp').addEventListener('click', () => { sfx('click'); ambient(true); startChamp(); });
$('mBoards').addEventListener('click', () => { sfx('click'); showBoards(st.lastBoard); });
$('tSeries').addEventListener('click', () => showBoards('series'));
$('tChamp').addEventListener('click', () => showBoards('champ'));
$('bFilter').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button'); if (!b) return;
  if (b.dataset.fn) st.bf = { ...st.bf, n: +b.dataset.fn }; if (b.dataset.fm) st.bf = { ...st.bf, memo: +b.dataset.fm };
  sfx('click'); showBoards('series');
});
$('bMenu').addEventListener('click', () => { sfx('click'); pending = null; toMenu(); });

{ const c = Number(localStorage.getItem(LS.cd) ?? 3); st.cd = CDS.includes(c) ? c : 3; }
loadSetup(); st.bf = { n: skillOf(st.skill).n, memo: st.memo }; renderCd(); applySound(); readout(0); renderHist(false); stamp(); setPose('idle', 'IDLE'); show('menu');
void initAudio(); void preloadAll();
