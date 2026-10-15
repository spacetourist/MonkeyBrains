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
check((await page.textContent('#verLabel')) === 'v0.2.1', 'version label');
await shot('v02-menu');

// sound toggle
await page.click('#mSound'); check((await page.textContent('#mSoundLbl')) === 'Sound off' && (await page.getAttribute('#mSound', 'aria-pressed')) === 'false', 'sound off');
await page.click('#mSound'); check((await page.textContent('#mSoundLbl')) === 'Sound on', 'sound on');

// ---- SERIES: 6 digits, 3 s ----
await page.click('#mSeries');
check(await page.locator('#skillSeg button').count() === 6, 'six skill buttons');
await page.click('[data-skill="6"]'); await page.click('[data-memo="3000"]');
await shot('v02-series-setup');
await page.click('#sGo');
check((await page.getAttribute('[data-skill="6"]', 'class')).includes('is-on'), 'default 6 picked');
await page.waitForFunction(() => window.__mb.phase === 'countdown');
await page.waitForTimeout(150); await shot('v02-countdown');
for (let a = 1; a <= 5; a++) {
  const n = await play(a === 3);
  check(n === 6, `series n=${n}`);
  await page.click('#cardPrimary');
}
await page.waitForSelector('#results:not(.hidden)');
const sr = await mb(() => ({ title: document.querySelector('#rTitle').textContent, list: document.querySelectorAll('#rList > div').length, att: window.__mb.attempts }));
check(await mb(() => JSON.parse(localStorage.getItem('mb.board.series.v1') || '[]').length) === 0, 'not saved yet');
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

// ---- CHAMPIONSHIP: clear 3, miss round 4 ----
await page.click('#bMenu'); await page.click('#mChamp');
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
check(/CAL\s*6·3s\s*4\/5/.test(s1), 'series persisted: ' + s1);
await page.click('#tChamp');
const c1 = await page.textContent('#boardBody');
check(/CAL\s*6\s*3/.test(c1), 'champ persisted: ' + c1);
check((await mb(() => JSON.parse(localStorage.getItem('mb.board.champ.v1'))[0].rounds)) === 3, 'champ rounds stored');

const ok = !fails.length && !errs.length;
console.log(JSON.stringify({ ok, fails, errs, series: sr.att }, null, 1));
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
