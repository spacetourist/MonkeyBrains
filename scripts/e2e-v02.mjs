// e2e for v0.2: menu, full series (1 miss), championship ending on miss, leaderboard persistence across reload.
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
const { chromium } = await import('/tmp/pw/node_modules/playwright-core/index.mjs');
const ROOT = new globalThis.URL('../dist', import.meta.url).pathname;
const SHOTS = new globalThis.URL('../shots/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.json': 'application/json', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/MonkeyBrains/, '') || '/';
  if (p === '/') p = '/index.html';
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = process.argv[2] || `http://127.0.0.1:${server.address().port}/MonkeyBrains/`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [], fails = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
const check = (c, msg) => { if (!c) fails.push(msg); };
const shot = n => page.screenshot({ path: `${SHOTS}${n}-412.png` });
const mb = f => page.evaluate(f);

let PACE = null; // [min,max] ms between digit taps, human-like, used for runs whose shots show times
async function tapDigit(k) {
  if (PACE && k > 1) await page.waitForTimeout(PACE[0] + Math.random() * (PACE[1] - PACE[0]));
  const i = await page.evaluate(k => { for (const [c, v] of window.__mb.layout) if (v === k) return c; return -1; }, k);
  const bb = await page.locator(`[data-cell="${i}"]`).boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
}
/** Play one trial; miss=true taps 1 then 3. Asserts digits painted before timer. */
async function play(miss) {
  await page.waitForFunction(() => window.__mb.phase === 'show', null, { timeout: 15000 });
  const pre = await mb(() => ({ n: window.__mb.n, vis: [...document.querySelectorAll('#grid .cell-digit')].filter(i => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0).length }));
  check(pre.vis === pre.n, `painted ${pre.vis} != n ${pre.n}`);
  await tapDigit(1);
  if (miss) await tapDigit(3); else for (let k = 2; k <= pre.n; k++) await tapDigit(k);
  await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 5000 });
  return pre.n;
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
check((await page.textContent('#verLabel')) === 'v0.3.9', 'version label');
await shot('v02-menu'); await shot('v03-menu');

// sound toggle
check(await page.locator('#menu [data-cd="3"].is-on').count() === 1, 'countdown default 3s');
await page.waitForFunction(() => window.__mbAudio && (window.__mbAudio.ok || window.__mbAudio.error));
await page.click('#mSound'); check((await mb(() => window.__mbDiag()?.muted)) === true, 'mbaudio muted');
check((await page.textContent('#mSoundLbl')) === 'Sound off' && (await page.getAttribute('#mSound', 'aria-pressed')) === 'false', 'sound off');
await page.click('#mSound'); check((await page.textContent('#mSoundLbl')) === 'Sound on' && (await mb(() => window.__mbDiag()?.muted)) === false, 'sound on');

// ---- SERIES: 6 digits, 3 s ----
await page.click('#mSeries');
check(await page.locator('#skillSeg button').count() === 6, 'six skill buttons');
await page.click('[data-skill="6"]'); await page.click('[data-memo="3000"]');
await shot('v02-series-setup'); await shot('v03-series-setup');
await page.evaluate(() => { window.__sfxLog.length = 0; });
await page.click('#sGo');
check((await page.getAttribute('[data-skill="6"]', 'class')).includes('is-on'), 'default 6 picked');
await page.waitForFunction(() => window.__mb.phase === 'countdown');
await page.waitForTimeout(150); await shot('v02-countdown');
await page.waitForFunction(() => window.__mb.phase === 'show', null, { timeout: 15000 });
const cdl = await mb(() => window.__sfxLog.map(x => x.name).filter(n => n.startsWith('countdown')));
check(JSON.stringify(cdl) === JSON.stringify(['countdownTick','countdownTick','countdownTick','countdownGo']), 'countdown cues ' + cdl);
const played = await mb(() => window.__mbPlayLog.filter(x => x.name.startsWith('countdown')).map(x => x.name + ':' + x.played));
check(JSON.stringify(played) === JSON.stringify(['countdownTick:true','countdownTick:true','countdownTick:true','countdownGo:true']), 'mbaudio played countdown ' + played);
const sp = await mb(() => window.__mbDiag && window.__mbDiag());
check(sp && sp.ok && sp.markerFound, 'mbaudio init ok ' + JSON.stringify(sp));
for (let a = 1; a <= 5; a++) {
  const n = await play(a === 3);
  check(n === 6, `series n=${n}`);
  const hs = await mb(() => ({ l: document.querySelector('#histLbl').textContent, c: [...document.querySelectorAll('#hist b')].map(b => b.className) }));
  const want = ['', '', 'f', '', ''].slice(0, a).concat(Array(5 - a).fill('p'));
  check(hs.l === 'This series' && JSON.stringify(hs.c) === JSON.stringify(want), `hist a${a} ${JSON.stringify(hs)}`);
  if (a === 3) { await page.waitForTimeout(250); await shot('v035-hist-series'); }
  await page.click('#cardPrimary');
}
await page.waitForSelector('#results:not(.hidden)');
const sr = await mb(() => ({ title: document.querySelector('#rTitle').textContent, list: document.querySelectorAll('#rList > div').length, att: window.__mb.attempts }));
check(await mb(() => JSON.parse(localStorage.getItem('mb.board.series.v1') || '[]').length) === 0, 'not saved yet');
check((await mb(() => window.__sfxLog.filter(x => x.blocked).length)) === 0, 'no sfx attempted while digits show');
// nothing actually played inside any memorise window: compare play times against perf trial windows is coarse, so check gate + phase log
check((await mb(() => window.__mbPlayLog.filter(x => x.played).length)) > 10, 'sounds actually played');
check(sr.title === '4 / 5', 'series title ' + sr.title);
check(sr.list === 5 && sr.att.length === 5 && sr.att[2].ok === false, 'attempt list');
await page.waitForTimeout(250); await shot('v02-series-results');
check(await page.isVisible('#rSave'), 'series qualifies');
await page.click('#rSave'); await page.waitForSelector('#nameBox:not(.hidden)');
await page.fill('#nameIn', 'cal'); await page.waitForTimeout(100); await shot('v02-leaderboard-entry');
await page.click('#nameSave');
check(await page.isHidden('#nameBox'), 'name card closes');
check(await page.locator('#boardBody .is-new').count() === 1, 'series new highlighted');
check((await mb(() => JSON.parse(localStorage.getItem('mb.board.series.v1'))[0].n)) === 6, 'series entry records digits');
check((await page.textContent('#bHead')) === '6 digits · 3s', 'board header ' + await page.textContent('#bHead'));
await page.click('[data-fn="4"]'); check((await page.textContent('#boardBody')).includes('No entries'), 'filter 4 digits empty');
await page.click('[data-fn="6"]'); check((await page.textContent('#boardBody')).includes('CAL'), 'filter back to 6·3s');
await shot('v03-leaderboard');
// countdown Off from the menu settings row (persisted), speeds up the championship
await page.click('#bMenu'); await page.click('#menu [data-cd="0"]');

// ---- CHAMPIONSHIP: clear 3, miss round 4 ----
await page.click('#mChamp');
const ns = [];
for (let r = 1; r <= 4; r++) { ns.push(await play(r === 4)); await page.click('#cardPrimary'); }
check(JSON.stringify(ns) === '[4,5,6,7]', 'champ digits ' + ns);
check(await mb(() => document.querySelector('#histLbl').textContent + '|' + [...document.querySelectorAll('#hist b')].map(b => b.className).join(',')) === 'This run|p,p,p,p,p,p,,,,f', 'champ hist scoped to run');
await page.waitForSelector('#results:not(.hidden)');
check((await page.textContent('#rTitle')) === '6', 'champ digits reached ' + await page.textContent('#rTitle'));
await page.waitForTimeout(250); await shot('v02-champ-results');
await page.click('#rSave'); await page.waitForSelector('#nameBox:not(.hidden)');
check((await page.inputValue('#nameIn')) === 'CAL', 'name remembered');
await page.click('#nameSave');
await page.click('#tSeries'); await page.click('#tChamp');
check(await page.locator('#boardBody .is-new').count() === 1, 'champ new highlighted');
await shot('v02-leaderboard');

// ---- persistence across reload ----
await page.reload({ waitUntil: 'networkidle' });
await page.click('#mBoards'); await page.click('#tSeries');
const s1 = await page.textContent('#boardBody');
check(/CAL\s*4\/5/.test(s1) && (await page.textContent('#bHead')) === '6 digits · 3s', 'series persisted: ' + s1);
check(await page.locator('#menu [data-cd="0"].is-on').count() === 1, 'countdown Off persisted');
await page.click('#tChamp');
const c1 = await page.textContent('#boardBody');
check(/CAL\s*6\s*3/.test(c1), 'champ persisted: ' + c1);
check((await mb(() => JSON.parse(localStorage.getItem('mb.board.champ.v1'))[0].rounds)) === 3, 'champ rounds stored');
// v0.3.4: champ board shows TOTAL time; ranking = rounds desc, then total asc; legacy entries derive total = avg x rounds
const champ0 = await mb(() => JSON.parse(localStorage.getItem('mb.board.champ.v1'))[0]);
check(typeof champ0.total === 'number' && champ0.total > 0, 'champ total stored');
check(c1.includes((champ0.total / 1000).toFixed(3) + 's'), 'board shows total ' + c1);
await page.evaluate(() => {
  const b = JSON.parse(localStorage.getItem('mb.board.champ.v1'));
  b.push({ name: 'OLD', rounds: 3, digits: 6, avg: 1000, at: 1 });               // legacy, no total -> 3.000s
  b.push({ name: 'TIE', rounds: 3, digits: 6, total: 1, avg: 0, at: 2 });          // same rounds, lower total -> #01
  b.push({ name: 'TOP', rounds: 4, digits: 7, total: 99999, avg: 25000, at: 3 });   // more rounds beats any total
  b.push({ name: 'NUL', rounds: 1, digits: 4, avg: null, at: 4 });                  // nothing to derive -> dash
  localStorage.setItem('mb.board.champ.v1', JSON.stringify(b));
});
await page.reload({ waitUntil: 'networkidle' }); await page.click('#mBoards'); await page.click('#tChamp');
const rows = await page.$$eval('#boardBody .mb2-row:not(.is-head)', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
check(rows[0].includes('TOP') && rows[1].includes('TIE') && rows[2].includes('CAL') && rows[3].includes('OLD') && rows[4].includes('NUL'), 'champ order ' + JSON.stringify(rows));
check(rows[3].includes('3.000s') && rows[4].endsWith('—'), 'legacy total derived / dash ' + JSON.stringify(rows));
check((await page.textContent('#boardBody .is-head')).includes('Total'), 'total header');
// ---- elapsed above 9999 ms: LED (6 slots), sheet, results and board are not clamped ----
await page.click('#bMenu'); await page.click('#menu [data-cd="0"]'); await page.click('#mChamp');
await page.waitForFunction(() => window.__mb.phase === 'show', null, { timeout: 15000 });
check((await page.locator('#readout .mb2-seg').count()) === 6, 'LED has 6 slots');
await tapDigit(1);
await mb(() => { window.__mb.t0 -= 123000; });           // pretend 123 s have elapsed
await page.waitForTimeout(80);
const ledLive = await mb(() => [...document.querySelectorAll('#readout .mb2-seg')].map(s => s.dataset.d).join(''));
await shot('v034-led-big'); check(/^12\d{4}$/.test(ledLive), 'LED keeps counting past 9999: ' + ledLive);
for (let k = 2; k <= 4; k++) await tapDigit(k);
await page.waitForSelector('#resultCard:not(.hidden)');
const bigMs = await mb(() => window.__mb.champTimes[0]);
const ledEnd = await mb(() => [...document.querySelectorAll('#readout .mb2-seg')].map(s => s.dataset.d).join(''));
check(bigMs > 123000 && ledEnd === String(bigMs), `LED final ${ledEnd} vs ${bigMs}`);
check((await page.textContent('#cardTag')).includes(String(bigMs)), 'sheet shows full ms');
await page.click('#cardPrimary'); await play(true); await page.click('#cardPrimary');
await page.waitForSelector('#results:not(.hidden)');
check((await page.textContent('#rStats')).includes((bigMs / 1000).toFixed(3) + 's'), 'results total not clamped');
await page.click('#rSave'); await page.click('#nameSave');
check((await mb(() => JSON.parse(localStorage.getItem('mb.board.champ.v1')).find(e => e.total > 100000)?.total)) === bigMs, 'stored total not clamped');
check((await page.textContent('#boardBody')).includes((bigMs / 1000).toFixed(3) + 's'), 'board total not clamped');
await page.screenshot({ path: `${SHOTS}v034-champ-board-412.png` });
// ---- v0.3.5: post-game footer Menu ----
check(await page.isVisible('#bRetry') && await page.isVisible('#bMenu2'), 'post-game footer shown');
await page.click('#bMenu2'); check(await page.isVisible('#menu'), 'footer Menu lands on menu');
await page.click('#mBoards');
check(await page.isHidden('#bRetry') && await page.isVisible('#bMenu2'), 'menu-opened board: Menu only');
await page.click('#bMenu2');

// ---- v0.3.5: series 5 digits @1s, name entry prefill/replace/clear/backspace, Retry ----
// v0.3.9: seed neighbours on 5 digits · 1s so the rank block has rows above/below
await mb(() => { const b = JSON.parse(localStorage.getItem('mb.board.series.v1') || '[]');
  const mk = (name, ok, avg, at) => ({ name, skill: '5', n: 5, memo: 1000, ok, avg, best: avg - 200, score: 0, at });
  b.push(mk('ACE', 5, 900, 11), mk('BOB', 5, 1150, 12), mk('DEE', 5, 2400, 13), mk('EVE', 4, 1000, 14));
  localStorage.setItem('mb.board.series.v1', JSON.stringify(b)); });
await page.click('#mSeries'); await page.click('[data-skill="5"]'); await page.click('[data-memo="1000"]'); await page.click('#sGo');
await page.waitForFunction(() => window.__mb.phase === 'show', null, { timeout: 15000 });
check(await mb(() => [...document.querySelectorAll('#hist b')].map(b => b.className).join(',')) === 'now,p,p,p,p', 'hist reset for new series');
PACE = [250, 400];
for (let a = 1; a <= 5; a++) { await play(false); await page.click('#cardPrimary'); }
PACE = null;
await page.waitForSelector('#results:not(.hidden)');
await page.waitForTimeout(400);
const rk = () => mb(() => ({ head: document.querySelector('.mb2-rank-head').textContent, rows: [...document.querySelectorAll('#rRank .mb2-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()), you: document.querySelector('#rRank .is-you .rk')?.textContent, note: document.querySelector('.mb2-rank-note')?.textContent || '' }));
const rr = await rk();
check(rr.head === 'Your rank · 5 digits · 1s' && rr.you === '#03' && rr.rows.length === 3 && rr.rows[0].startsWith('#02 BOB') && rr.rows[2].startsWith('#04 DEE') && !rr.note, 'ranked block ' + JSON.stringify(rr));
check(!(await mb(() => JSON.parse(localStorage.getItem('mb.board.series.v1')).some(e => e.name === '' ))), 'rank shown before saving');
const oneLine = () => mb(() => { const b = document.querySelector('#rSave'), lh = parseFloat(getComputedStyle(b).lineHeight) || 30; return { h: b.getBoundingClientRect().height, sw: b.scrollWidth, cw: b.clientWidth, txt: b.textContent, rects: document.createRange && (() => { const r = document.createRange(); r.selectNodeContents(b); return r.getClientRects().length; })() }; });
let ol = await oneLine(); check(ol.txt === 'Save score' && ol.rects === 1 && ol.sw <= ol.cw && ol.h === 56, 'save one line 412 ' + JSON.stringify(ol));
await shot('v039-results-ranked');
await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(200);
ol = await oneLine(); check(ol.rects === 1 && ol.sw <= ol.cw, 'save one line 360 ' + JSON.stringify(ol));
await page.screenshot({ path: `${SHOTS}v039-results-ranked-360.png` });
await page.setViewportSize({ width: 412, height: 915 }); await page.waitForTimeout(150);
await page.click('#rSave'); await page.waitForSelector('#nameBox:not(.hidden)');
const nm = () => mb(() => ({ v: nameIn.value, pre: nameIn.parentElement.classList.contains('is-pre'), slots: [...document.querySelectorAll('.mb2-name-slot')].map(e => e.textContent).join(''), foc: document.activeElement?.id }));
let ns1 = await nm(); check(ns1.v === 'CAL' && ns1.pre, 'prefill ghosted ' + JSON.stringify(ns1));
await page.waitForTimeout(150); await shot('v038-name-entry');
const cl = await mb(() => { const b = document.querySelector('#nameClear'), r = b.getBoundingClientRect(), sl = document.querySelector('.slots').getBoundingClientRect(), cs = getComputedStyle(b);
  return { w: r.width, h: r.height, gap: Math.round(r.left - sl.right), dis: b.disabled, txt: b.textContent.trim(), border: cs.borderColor }; });
check(cl.w === 100 && cl.h === 48 && cl.gap === 12 && !cl.dis && /clear/i.test(cl.txt) && cl.border === 'rgb(246, 246, 246)', 'CLEAR key ' + JSON.stringify(cl));
await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(150);
const fit = await mb(() => { const c = document.querySelector('#nameBox').getBoundingClientRect(); return [...document.querySelectorAll('#nameBox .slots, #nameClear, #nameSave')].every(e => { const r = e.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right; }); });
check(fit, 'name card fits at 360'); await page.screenshot({ path: `${SHOTS}v037-name-entry-360.png` });
await page.setViewportSize({ width: 412, height: 915 }); await page.waitForTimeout(150);
await page.focus('#nameIn'); await page.keyboard.press('Backspace');
ns1 = await nm(); check(ns1.v === '' && !ns1.pre, 'backspace on prefill clears all ' + JSON.stringify(ns1));
await page.click('#tChamp'); await page.click('#tSeries');           // re-render -> prefilled again
await page.focus('#nameIn'); await page.keyboard.type('q');
ns1 = await nm(); check(ns1.v === 'Q' && !ns1.pre, 'first char replaces prefill ' + JSON.stringify(ns1));
await page.keyboard.type('rs'); ns1 = await nm(); check(ns1.v === 'QRS', 'type more ' + ns1.v);
await page.keyboard.press('Backspace'); ns1 = await nm(); check(ns1.v === 'QR', 'normal backspace ' + ns1.v);
const cb = await page.locator('#nameClear').boundingBox(); check(cb.width === 100 && cb.height === 48, 'clear 100x48');
await page.click('#nameClear'); ns1 = await nm(); check(ns1.v === '' && ns1.foc === 'nameIn', 'clear button clears, keeps focus ' + JSON.stringify(ns1));
check(await mb(() => document.querySelector('#nameClear').disabled), 'empty: CLEAR disabled');
await page.waitForTimeout(100); await shot('v037-name-empty');
// soft-keyboard style: input event without a useful keydown (Android keyCode 229)
await page.click('#tChamp'); await page.click('#tSeries');
await mb(() => { const e = new InputEvent('beforeinput', { inputType: 'insertText', data: 'k', cancelable: true }); if (nameIn.dispatchEvent(e)) { nameIn.value += 'k'; nameIn.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'k' })); } });
ns1 = await nm(); check(ns1.v === 'K', 'IME insert replaces prefill ' + ns1.v);
await page.focus('#nameIn'); await page.keyboard.press('End'); await page.keyboard.type('ay'); check((await nm()).v === 'KAY', 'typed KAY ' + JSON.stringify(await nm())); await page.click('#nameSave');
{ const bt = await page.textContent('#boardBody'); check(bt.includes('KAY'), 'saved KAY: ' + bt); }
check(await page.isVisible('#bRetry'), 'Retry after game');
await page.mouse.move(206, 400); await page.mouse.wheel(0, 400); await page.waitForTimeout(100);
check(await page.isVisible('#boards'), 'scroll over board triggers nothing');
await page.waitForTimeout(150); await shot('v036-postgame-board');
const kay = await mb(() => JSON.parse(localStorage.getItem('mb.board.series.v1')).find(e => e.name === 'KAY'));
check(kay.avg > 1000 && !kay.suspect, 'paced run is realistic, not flagged ' + kay.avg);
const san = await mb(() => window.__mbSanity()); console.error('sanity', JSON.stringify(san));
check(san.series.flagged >= 1 && san.series.flagged < san.series.total, 'sanity floor flags bot runs only ' + JSON.stringify(san));
check(await mb(() => getComputedStyle(document.querySelector('#boardBody .is-new')).outlineStyle) === 'none', 'new row has no outline');
await page.click('[data-fn="9"]'); await page.click('[data-fm="500"]');
check(await mb(() => document.querySelector('#boardBody .is-head') && getComputedStyle(document.querySelector('.mb2-empty')).textTransform) === 'uppercase', 'empty state under header');
await page.waitForTimeout(100); await shot('v036-board-empty');
await page.click('#bRetry');
await page.waitForFunction(() => window.__mb.phase === 'show', null, { timeout: 15000 });
const rc = await mb(() => ({ m: window.__mb.mode, n: window.__mb.n, memo: window.__mb.memo, h: [...document.querySelectorAll('#hist b')].map(b => b.className).join(',') }));
check(rc.m === 'series' && rc.n === 5 && rc.memo === 1000 && rc.h === 'now,p,p,p,p', 'Retry same config ' + JSON.stringify(rc));

// ---- v0.3.9: unranked run (10 perfect entries on 4 digits · 2s, we play 4/5) ----
await page.reload({ waitUntil: 'networkidle' });
await mb(() => { const b = JSON.parse(localStorage.getItem('mb.board.series.v1') || '[]');
  for (let i = 0; i < 10; i++) b.push({ name: 'P' + String(i).padStart(2, '0'), skill: '4', n: 4, memo: 2000, ok: 5, avg: 1200 + i * 100, best: 1000, score: 0, at: 100 + i });
  localStorage.setItem('mb.board.series.v1', JSON.stringify(b)); });
await page.click('#mSeries'); await page.click('[data-skill="4"]'); await page.click('[data-memo="2000"]'); await page.click('#sGo');
PACE = [250, 400];
for (let a = 1; a <= 5; a++) { await play(a === 2); await page.click('#cardPrimary'); }
PACE = null;
await page.waitForSelector('#results:not(.hidden)'); await page.waitForTimeout(400);
const ur = await rk();
check(ur.you === '#—' && ur.rows.length === 3 && ur.rows[1].startsWith('#10') && /not in the top 10/i.test(ur.note) && await page.isHidden('#rSave'), 'unranked block ' + JSON.stringify(ur));
await shot('v039-results-unranked');
await page.click('#rFull'); check(await page.isVisible('#boards') && (await page.textContent('#bHead')) === '4 digits · 2s', 'FULL BOARD opens that config');
await page.evaluate(() => 0);
const ok = !fails.length && !errs.length;
console.log(JSON.stringify({ ok, fails, errs, series: sr.att }, null, 1));
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
