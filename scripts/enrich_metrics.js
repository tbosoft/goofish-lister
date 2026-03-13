#!/usr/bin/env node
/**
 * Enrich candidate items with metrics from item pages (wantCount, viewCount).
 * Uses a persistent, headed profile to avoid Goofish anti-bot blocks.
 *
 * Input: a candidates JSON produced by search_candidates.js
 * Output: outputs/enriched-*.json
 *
 * Usage:
 *   GOOFISH_USER_DATA_DIR=~/.openclaw/goofish-profile node scripts/enrich_metrics.js --in outputs/candidates-xxx.json --max 20
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { buildMeta } = require('./lib/output_meta');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v ?? def;
}

function parseFirstIntNear(lines, re) {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

(async () => {
  const inPath = arg('--in');
  const max = parseInt(arg('--max', '20'), 10);
  if (!inPath) {
    console.error('Missing --in <candidates.json>');
    process.exit(2);
  }

  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));
  const items = (raw.items || []).slice(0, max);

  const userDataDir = process.env.GOOFISH_USER_DATA_DIR || path.join(os.homedir(), '.openclaw', 'goofish-profile');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 720 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const enriched = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      const txt = await page.evaluate(() => document.body.innerText);
      const lines = txt.split(/\n/).map((l) => l.trim()).filter(Boolean);

      // Common patterns seen on item pages: "15人想要" and "618浏览".
      const wantCount = parseFirstIntNear(lines, /^(\d+)\s*人想要$/);
      const viewCount = parseFirstIntNear(lines, /^(\d+)\s*浏览$/);

      enriched.push({
        ...it,
        wantCount,
        viewCount,
        wantViewRatio: wantCount != null && viewCount ? wantCount / viewCount : null,
        metricFetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      enriched.push({
        ...it,
        wantCount: null,
        viewCount: null,
        wantViewRatio: null,
        metricError: String(e?.message || e),
        metricFetchedAt: new Date().toISOString(),
      });
    }
  }

  await ctx.close();

  const outDir = path.join(process.cwd(), 'outputs');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `enriched-${stamp}.json`);
  const out = {
    ...raw,
    enrichedAt: new Date().toISOString(),
    enrichedCount: enriched.length,
    items: enriched,
    meta: buildMeta({
      script: 'skills/goofish-lister/scripts/enrich_metrics.js',
      inputs: {
        in: inPath,
        max,
        // Only record whether a persistent profile dir was provided; do not record the path.
        persistentProfile: Boolean(process.env.GOOFISH_USER_DATA_DIR),
      },
      counts: {
        inputCount: (raw.items || []).length,
        enrichedCount: enriched.length,
      },
    }),
  };
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
