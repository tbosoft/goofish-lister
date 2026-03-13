#!/usr/bin/env node
/**
 * Filter enriched candidates by price and want/view ratio.
 *
 * Input: enriched JSON (items include wantCount/viewCount/wantViewRatio)
 * Output: outputs/filtered-*.json
 *
 * Usage:
 *   node scripts/filter_candidates.js --in outputs/enriched-xxx.json --minPrice 10 --minRatio 0.05
 */

const fs = require('fs/promises');
const path = require('path');
const { buildMeta } = require('./lib/output_meta');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v ?? def;
}

function parsePriceFromText(text) {
  // Try to find first ¥ number in the text.
  const m = text.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  return parseFloat(m[1]);
}

(async () => {
  const inPath = arg('--in');
  const minPrice = parseFloat(arg('--minPrice', '0'));
  const minRatio = parseFloat(arg('--minRatio', '0'));
  if (!inPath) {
    console.error('Missing --in <enriched.json>');
    process.exit(2);
  }

  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));

  const kept = [];
  for (const it of raw.items || []) {
    const price = it.price ?? parsePriceFromText(it.text || '');
    const ratio = it.wantViewRatio;
    if (price == null || ratio == null) continue;
    if (price > minPrice && ratio > minRatio) {
      kept.push({ ...it, price });
    }
  }

  kept.sort((a, b) => (b.wantViewRatio ?? 0) - (a.wantViewRatio ?? 0));

  const outDir = path.join(process.cwd(), 'outputs');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `filtered-${stamp}.json`);
  const out = {
    query: raw.query,
    source: raw.url,
    filteredAt: new Date().toISOString(),
    minPrice,
    minRatio,
    count: kept.length,
    items: kept,
    meta: buildMeta({
      script: 'skills/goofish-lister/scripts/filter_candidates.js',
      inputs: {
        in: inPath,
        minPrice,
        minRatio,
      },
      counts: {
        inputCount: (raw.items || []).length,
        outputCount: kept.length,
      },
    }),
  };
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
