// Black-box timing harness (works on any build): observes DOM from the page side.
// Measures: countdown duration vs target, memorise (digits painted -> covers painted) vs target,
// input -> feedback latency (pointerdown event.timeStamp -> first frame after the cell changes).
// Usage: node scripts/perf-measure.mjs [baseURL] [throttles=4,6] [out.json]
import { createServer } from 'http';
import { readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
const { chromium } = await import('/tmp/pw/node_modules/playwright-core/index.mjs');
const ROOT = process.env.MB_DIST || new globalThis.URL('../dist', import.meta.url).pathname;
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
const BASE = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : `http://127.0.0.1:${server.address().port}/MonkeyBrains/`;
const THROTTLES = (process.argv[3] || '4,6').split(',').map(Number);
const OUT = process.argv[4];
const MEMOS = [2000, 1000, 500];

const observer = () => {
  const P = window.__harness = { cd: [], memo: [], input: [], long: [] };
  let cdStart = 0, shownAt = 0, state = 'idle', pending = null;
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  addEventListener('pointerdown', e => {
    const c = e.target.closest && e.target.closest('[data-cell]');
    if (c) pending = { cell: c, ts: e.timeStamp, cls: c.className };
  }, true);
  const frame = cb => requestAnimationFrame(() => cb(performance.now()));
  const check = () => {
    const cdp = document.getElementById('cdPanel');
    const cdOff = !cdp || cdp.classList.contains('hidden') || cdp.classList.contains('is-off');
    if (!cdOff && !cdStart && state === 'idle') { cdStart = -1; frame(t => { cdStart = t; }); }
    const digits = document.querySelectorAll('#grid .cell-digit').length;
    const tiles = document.querySelectorAll('#grid .mb2-tile').length;
    if (state === 'idle' && cdOff && digits > 0 && !document.querySelector('#grid .mb2-tile')) {
      state = 'shown';
      frame(t => { shownAt = t; if (cdStart > 0) P.cd.push(t - cdStart); cdStart = 0; });
    } else if (state === 'shown' && tiles > 0) {
      state = 'hidden'; const s = shownAt;
      frame(t => { P.memo.push(t - (shownAt || s)); });
    } else if (state !== 'idle' && digits === 0 && tiles === 0) { state = 'idle'; }
    if (pending && pending.cell.className !== pending.cls) {
      const p = pending; pending = null; frame(t => P.input.push(t - p.ts));
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
};

const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)].toFixed(1); };
const stats = a => ({ n: a.length, mean: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null, p50: pct(a, .5), p95: pct(a, .95), max: a.length ? +Math.max(...a).toFixed(1) : null });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const result = {};
for (const rate of THROTTLES) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  await ctx.addInitScript(observer);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  const memoDev = [], cdDev = [], inputs = [], longs = [];
  for (const memo of MEMOS) {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(m => { localStorage.clear(); localStorage.setItem('mb.setup', JSON.stringify({ skill: '6', memo: m })); localStorage.setItem('mb.countdown', '3'); }, memo);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.locator('#mSeries').dispatchEvent('pointerdown').catch(() => {}); await page.click('#mSeries').catch(() => {});
    await page.waitForSelector('#setup:not(.hidden)');
    await page.click('#sGo');
    for (let a = 0; a < 5; a++) {
      // wait for the auto-hide (no tap during memorise)
      await page.waitForFunction(() => document.querySelectorAll('#grid .mb2-tile').length > 0, null, { timeout: 30000 });
      await page.waitForTimeout(60);
      const layout = await page.evaluate(() => [...window.__mb.layout].sort((a, b) => a[1] - b[1]).map(x => x[0]));
      for (const i of layout) {
        const bb = await page.locator(`[data-cell="${i}"]`).boundingBox();
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForTimeout(40);
      }
      await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 10000 });
      await page.waitForTimeout(150);
      await page.click('#cardPrimary');
    }
    await page.waitForSelector('#results:not(.hidden)', { timeout: 15000 });
    const h = await page.evaluate(() => window.__harness);
    memoDev.push(...h.memo.map(x => x - memo)); cdDev.push(...h.cd.map(x => x - 3000)); inputs.push(...h.input); longs.push(...h.long);
  }
  const app = await page.evaluate(() => window.__perf ? { memoDev: window.__perf.trials.map(t => t.actual - t.target), input: window.__perf.inputs } : null);
  result[`${rate}x`] = {
    memoriseDeviationMs: stats(memoDev), memoriseAbsDeviationMs: stats(memoDev.map(Math.abs)),
    countdownDeviationMs: stats(cdDev), inputToFeedbackMs: stats(inputs),
    longTasks: { n: longs.length, max: longs.length ? +Math.max(...longs).toFixed(0) : 0 },
    appInternal: app && { memoAbsDev: stats(app.memoDev.map(Math.abs)), memoDev: stats(app.memoDev), handlerLatency: stats(app.input.map(x => x.handler)), feedbackLatency: stats(app.input.map(x => x.feedback)) },
  };
  await ctx.close();
}
console.log(JSON.stringify(result, null, 1));
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
await browser.close(); server.close();
