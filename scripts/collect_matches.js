#!/usr/bin/env node
/**
 * Collect N Goofish items that satisfy:
 *   price > minPrice AND (wantCount/viewCount) > minRatio
 *
 * Workflow:
 *  1) Load a candidates JSON produced by search_candidates.js
 *  2) Visit item pages using a persistent (headed) Chrome profile
 *  3) Parse wantCount, viewCount, price
 *  4) Stop once we have target matches
 *
 * Usage:
 *   GOOFISH_USER_DATA_DIR=~/.openclaw/goofish-profile \
 *     node scripts/collect_matches.js --in outputs/candidates-xxx.json --target 30 --minPrice 10 --minRatio 0.05
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v ?? def;
}

function num(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseMetricsFromText(txt) {
  const want = txt.match(/(\d+)\s*人想要/);
  const view = txt.match(/(\d+)\s*浏览/);

  // Price: take the first "¥ <num>" occurrence.
  const price = txt.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);

  return {
    wantCount: want ? parseInt(want[1], 10) : null,
    viewCount: view ? parseInt(view[1], 10) : null,
    price: price ? parseFloat(price[1]) : null,
  };
}

(async () => {
  const inPath = arg('--in');
  const target = parseInt(arg('--target', '30'), 10);
  const minPrice = parseFloat(arg('--minPrice', '10'));
  const minRatio = parseFloat(arg('--minRatio', '0.05'));

  if (!inPath) {
    console.error('Missing --in <candidates.json>');
    process.exit(2);
  }

  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));
  const candidates = raw.items || [];

  const userDataDir = process.env.GOOFISH_USER_DATA_DIR || path.join(os.homedir(), '.openclaw', 'goofish-profile');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const matches = [];
  const visited = [];

  for (let i = 0; i < candidates.length; i++) {
    if (matches.length >= target) break;

    const c = candidates[i];
    visited.push(c.url);

    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);

      const txt = await page.evaluate(() => document.body.innerText);

      // If a login dialog is present, stop early.
      if (/短信登录|密码登录|请先登录|去登录/.test(txt)) {
        throw new Error('Login required or login dialog detected');
      }

      const { wantCount, viewCount, price } = parseMetricsFromText(txt);
      const ratio = wantCount != null && viewCount ? wantCount / viewCount : null;

      const p = num(price);
      const r = num(ratio);

      if (p != null && r != null && p > minPrice && r > minRatio) {
        matches.push({
          url: c.url,
          candidateText: c.text,
          price: p,
          wantCount,
          viewCount,
          wantViewRatio: r,
          matchedAt: new Date().toISOString(),
        });
        // Light pacing to reduce risk.
        await page.waitForTimeout(1200);
      } else {
        await page.waitForTimeout(600);
      }
    } catch (e) {
      // ignore and continue
      await page.waitForTimeout(800);
    }
  }

  await ctx.close();

  // Sort by ratio descending for convenience.
  matches.sort((a, b) => (b.wantViewRatio ?? 0) - (a.wantViewRatio ?? 0));

  const outDir = path.join(process.cwd(), 'outputs');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `matches-${stamp}.json`);

  const out = {
    query: raw.query,
    sourceSearchUrl: raw.url,
    constraints: { minPrice, minRatio, target },
    candidatesCount: candidates.length,
    visitedCount: visited.length,
    matchCount: matches.length,
    matches,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
