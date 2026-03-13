#!/usr/bin/env node
/**
 * Search Goofish candidates by keyword via Playwright.
 *
 * Output: JSON to outputs/candidates-*.json
 *
 * Usage:
 *   node scripts/search_candidates.js --q "iPhone 15" --limit 30
 */

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { buildMeta } = require('./lib/output_meta');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v ?? def;
}

(async () => {
  const q = arg('--q') || arg('-q');
  const limit = parseInt(arg('--limit', '30'), 10);
  const scrollPages = parseInt(arg('--scroll', '12'), 10);
  const maxPages = parseInt(arg('--pages', '1'), 10);
  if (!q) {
    console.error('Missing --q "keyword"');
    process.exit(2);
  }

  const url = `https://www.goofish.com/search?q=${encodeURIComponent(q)}`;

  // NOTE: Headless access is often blocked by Goofish ("非法访问").
  // Prefer a persistent, headed context with a real profile (see login_once.js).
  const userDataDir = process.env.GOOFISH_USER_DATA_DIR;
  let context;
  if (userDataDir) {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chrome',
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } else {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      channel: 'chrome',
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Give the page time to render.
  await page.waitForTimeout(2500);

  // Try a few common patterns for item links.
  const selectors = [
    'a[href*="/item?id="]',
    'a[href^="https://www.goofish.com/item?id="]',
    'a[href^="/item?id="]',
  ];

  // Collect items while scrolling. Goofish search results are often virtualized,
  // so collecting only once at the end may cap at ~30.
  const seen = new Map(); // url -> {url,text}

  async function collectOnce() {
    for (const sel of selectors) {
      try {
        const got = await page.$$eval(sel, (as) => {
          const uniq = new Map();
          for (const a of as) {
            const href = a.getAttribute('href') || '';
            if (!href.includes('item?id=')) continue;
            const abs = href.startsWith('http') ? href : `https://www.goofish.com${href}`;
            const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
            if (!uniq.has(abs)) uniq.set(abs, { url: abs, text });
          }
          return [...uniq.values()];
        });
        for (const it of got) {
          if (!seen.has(it.url)) seen.set(it.url, it);
        }
      } catch {
        // ignore
      }
    }
  }

  async function goToPage(n) {
    if (n <= 1) return;
    // There is a footer pagination with an input: "到第 <input> 页 确定"
    // We'll fill the page number and click the "确定" button in that footer.
    const footer = page.locator('div.search-footer-page-container--e02TuanR');
    const pageInput = footer.locator('input');
    const okBtn = footer.getByRole('button', { name: '确定' });

    if ((await footer.count()) && (await pageInput.count())) {
      await pageInput.first().fill(String(n));
      await okBtn.click({ timeout: 30000 });
      await page.waitForTimeout(1800);
    }
  }

  for (let p = 1; p <= maxPages; p++) {
    if (p > 1) await goToPage(p);

    // Give the page time to render.
    await page.waitForTimeout(1500);

    // Initial collect
    await collectOnce();

    // Scroll and collect
    for (let i = 0; i < scrollPages; i++) {
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(900);
      await collectOnce();
    }
  }

  const items = [...seen.values()];

  // If still empty, capture a diagnostic snapshot to help debug rendering/anti-bot.
  if (!items.length) {
    const diagDir = path.join(process.cwd(), 'outputs');
    await fs.mkdir(diagDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(diagDir, `diag-${stamp}.png`), fullPage: true });
    const html = await page.content();
    await fs.writeFile(path.join(diagDir, `diag-${stamp}.html`), html, 'utf8');
  }

  const sliced = items.slice(0, limit);

  const out = {
    query: q,
    url,
    fetchedAt: new Date().toISOString(),
    totalExtracted: items.length,
    count: sliced.length,
    items: sliced,
    meta: buildMeta({
      script: 'skills/goofish-lister/scripts/search_candidates.js',
      inputs: {
        q,
        limit,
        scroll: scrollPages,
        pages: maxPages,
        // Only record whether a persistent profile dir was provided; do not record the path.
        persistentProfile: Boolean(process.env.GOOFISH_USER_DATA_DIR),
      },
      counts: {
        totalExtracted: items.length,
        count: sliced.length,
      },
    }),
  };

  const outDir = path.join(process.cwd(), 'outputs');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `candidates-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');

  console.log(outPath);
  await context.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
