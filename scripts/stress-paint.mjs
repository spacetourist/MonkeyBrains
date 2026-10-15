/**
 * Stress: 30+ rapid trials with CPU throttle.
 * Asserts n digits painted before timer starts; no cells added after hide.
 */
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';

const { chromium } = await import('/tmp/pw/node_modules/playwright-core/index.mjs');

const ROOT = new globalThis.URL('../dist', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.json': 'application/json', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path.startsWith('/MonkeyBrains')) path = path.slice('/MonkeyBrains'.length) || '/';
  if (path === '/') path = '/index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/MonkeyBrains/`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__mb);
await page.click('#startBtn');

const N_TRIALS = 36;
const failures = [];

async function tapDigit(k) {
  const i = await page.evaluate(k => {
    for (const [cell, v] of window.__mb.layout) if (v === k) return cell;
    return -1;
  }, k);
  if (i < 0) throw new Error('digit ' + k + ' not in layout');
  const bb = await page.locator(`[data-cell="${i}"]`).boundingBox();
  if (!bb) throw new Error('no bbox for cell ' + i);
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
}

for (let t = 0; t < N_TRIALS; t++) {
  await page.waitForFunction(() => window.__mb.phase === 'show', null, { timeout: 15000 });

  const pre = await page.evaluate(() => {
    const st = window.__mb;
    const n = st.layout.size;
    const digits = [...document.querySelectorAll('#grid .cell-digit')];
    const visible = digits.filter(im => {
      const r = im.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && im.complete && im.naturalWidth > 0;
    }).length;
    return { n, digitCells: st.digitCells.length, visible, phase: st.phase, t0: st.t0 };
  });

  if (pre.phase !== 'show') failures.push(`t${t}: phase ${pre.phase}`);
  if (pre.n !== pre.digitCells) failures.push(`t${t}: layout ${pre.n} != digitCells ${pre.digitCells}`);
  if (pre.visible !== pre.n) failures.push(`t${t}: visible ${pre.visible} != n ${pre.n}`);
  if (!(pre.t0 > 0)) failures.push(`t${t}: t0 not started`);

  const cellSetAtShow = await page.evaluate(() => [...window.__mb.digitCells].sort((a, b) => a - b));
  const doWrong = t % 7 === 3;

  if (doWrong) {
    await tapDigit(1);
    await page.waitForFunction(() => window.__mb.phase === 'hidden' || window.__mb.phase === 'done');
    const afterHide = await page.evaluate(() => [...window.__mb.digitCells].sort((a, b) => a - b));
    if (JSON.stringify(afterHide) !== JSON.stringify(cellSetAtShow)) {
      failures.push(`t${t}: digitCells changed after hide`);
    }
    await tapDigit(3);
    await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 5000 });
    await page.click('#cardPrimary');
  } else {
    const n = pre.n;
    await tapDigit(1);
    const afterHide = await page.evaluate(() => {
      const st = window.__mb;
      const now = [...st.digitCells].sort((a, b) => a - b);
      const unexpectedDigits = [];
      for (const i of st.digitCells) {
        const c = document.querySelector(`[data-cell="${i}"]`);
        if (c.classList.contains('cleared')) continue;
        if (!c.classList.contains('mb2-tile') && c.querySelector('.cell-digit')) unexpectedDigits.push(i);
      }
      return { now, unexpectedDigits };
    });
    if (JSON.stringify(afterHide.now) !== JSON.stringify(cellSetAtShow)) {
      failures.push(`t${t}: digitCells mutated after hide`);
    }
    if (afterHide.unexpectedDigits.length) {
      failures.push(`t${t}: digits after hide on ${afterHide.unexpectedDigits}`);
    }
    for (let k = 2; k <= n; k++) await tapDigit(k);
    await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 5000 });
    await page.click('#cardPrimary');
  }
}

const ok = failures.length === 0 && errs.length === 0;
console.log(JSON.stringify({ trials: N_TRIALS, failures, errs, ok }, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
