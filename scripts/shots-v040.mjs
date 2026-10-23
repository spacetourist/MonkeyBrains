// v0.4.0 landing shots + no-scroll check. Usage: node scripts/shots-v040.mjs [baseURL]
// Seeds the GD mock's data (live-lab.html SEED_*) relative to a frozen clock 2026-10-23T09:18:07.
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
const { chromium } = await import('/tmp/pw/node_modules/playwright-core/index.mjs');
const ROOT = process.env.MB_DIST || new globalThis.URL('../dist', import.meta.url).pathname;
const SHOTS = new globalThis.URL('../shots/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
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
const NOW = new Date('2026-10-23T09:18:07').getTime(), H = 3600e3, D = 24 * H, M = 60e3;
const SERIES = [
  { name: 'JO', skill: '5', n: 5, memo: 1000, ok: 5, avg: 1012, best: 874, score: 0, at: NOW - 2 * H - 14 * M },
  { name: 'MAX', skill: '7', n: 7, memo: 2000, ok: 4, avg: 1488, best: 1203, score: 0, at: NOW - 5 * H },
  { name: 'SAM', skill: '9', n: 9, memo: 500, ok: 3, avg: 1904, best: 1655, score: 0, at: NOW - 26 * H },
  { name: 'RAE', skill: '5', n: 5, memo: 1000, ok: 5, avg: 951, best: 802, score: 0, at: NOW - 30 * H },
  { name: 'BEN', skill: '5', n: 5, memo: 1000, ok: 5, avg: 1100, best: 933, score: 0, at: NOW - 44 * H },
  { name: 'LIZ', skill: '5', n: 5, memo: 1000, ok: 4, avg: 1030, best: 880, score: 0, at: NOW - 50 * H },
];
const CHAMP = [
  { name: 'KAY', rounds: 11, digits: 9, total: 18402, avg: 1673, at: NOW - 3 * D - 4 * H },
  { name: 'ODE', rounds: 10, digits: 9, total: 16880, avg: 1688, at: NOW - 9 * H },
  { name: 'JO', rounds: 8, digits: 9, total: 13020, avg: 1627, at: NOW - 4 * D },
];
const CASES = [ // name, w, h, seeded, reduced
  ['v040-360x740-now', 360, 740, true, false], ['v040-390x844-now', 390, 844, true, false], ['v040-430x932-now', 430, 932, true, false],
  ['v040-390x844-empty', 390, 844, false, false], ['v040-390x844-reduced', 390, 844, true, true],
];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const out = [];
for (const [name, w, h, seeded, red] of CASES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, reducedMotion: red ? 'reduce' : 'no-preference', isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(([s, c]) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.clear();
    if (s) { localStorage.setItem('mb.board.series.v1', JSON.stringify(s)); localStorage.setItem('mb.board.champ.v1', JSON.stringify(c)); } } }, seeded ? [SERIES, CHAMP] : [null, null]);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(2400);
  await page.evaluate(() => document.querySelectorAll('.ll-dot').forEach(d => d.getAnimations().forEach(a => { a.currentTime = 100; })));
  // freeze the crown glint/spark mid-sweep like GD's render.py (GLINT_MS 1850)
  if (!red) await page.evaluate(() => document.querySelectorAll('.ll-glint,.ll-spark').forEach(e => e.getAnimations().forEach(a => { a.pause(); a.currentTime = 1850; })));
  const glintMask = await page.evaluate(() => getComputedStyle(document.querySelector('.ll-glint')).maskImage);
  const m = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, menuSH: document.getElementById('menu').scrollHeight, menuCH: document.getElementById('menu').clientHeight, ih: innerHeight,
    cam: Math.round(document.querySelector('.ll-cam-wrap').getBoundingClientRect().height), ctaTop: Math.round(document.getElementById('mChamp').getBoundingClientRect().top),
    titleSW: document.querySelector('.ll-title').scrollWidth, titleCW: document.querySelector('.ll-title').clientWidth, rows: document.querySelectorAll('.ll-row').length }));
  m.noScroll = m.sh === m.ih && m.menuSH <= m.menuCH; m.glintMask = glintMask; m.hero = await page.getAttribute('#llHero', 'src');
  await page.screenshot({ path: `${SHOTS}${name}.png` });
  out.push({ name, ...m }); await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
process.exit(out.every(o => o.noScroll) ? 0 : 1);
