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

async function tapDigit(k) {
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
check((await page.textContent('#verLabel')) === 'v0.3.4', 'version label');
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

const ok = !fails.length && !errs.length;
console.log(JSON.stringify({ ok, fails, errs, series: sr.att }, null, 1));
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
