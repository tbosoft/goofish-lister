#!/usr/bin/env node
/**
 * Rank candidates (enriched/matches/filtered) offline with explainable scoring.
 *
 * Input:
 * - outputs/enriched-*.json  (items array)
 * - outputs/filtered-*.json  (items array)
 * - outputs/matches-*.json   (matches array)
 *
 * Output: outputs/ranked-*.json
 * - Preserves original item fields
 * - Adds: score (0-100), reasons[], rank
 *
 * Usage:
 *   node skills/goofish-lister/scripts/rank_candidates.js --in outputs/enriched-xxx.json --top 20
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

function parseMaybeNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parsePriceFromText(text) {
  if (!text) return null;
  const m = String(text).match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function scoreItem(it, opts) {
  const reasons = [];

  // Baseline so items without metrics still get some ordering.
  let score = 10;

  const text = it.text ?? it.candidateText ?? '';
  const price = parseMaybeNumber(it.price) ?? parsePriceFromText(text);
  const want = parseMaybeNumber(it.wantCount);
  const view = parseMaybeNumber(it.viewCount);
  const ratio = parseMaybeNumber(it.wantViewRatio);

  // 1) Ratio signal (dominant)
  if (ratio != null) {
    // Map ratio to 0..1 with a soft cap. 0.20 is considered "excellent".
    const rNorm = clamp01(ratio / (opts.ratioCap || 0.2));
    const points = 50 * rNorm;
    score += points;

    if (ratio >= 0.1) reasons.push('ratio>=0.10');
    else if (ratio >= 0.05) reasons.push('ratio>=0.05');
    else if (ratio > 0) reasons.push('ratio>0');
  } else {
    reasons.push('noRatio');
  }

  // 2) Want count (secondary)
  if (want != null) {
    // Log-like scaling: 0..30 points.
    const wNorm = clamp01(Math.log10(1 + want) / Math.log10(1 + (opts.wantCap || 500)));
    score += 30 * wNorm;
    if (want >= 100) reasons.push('want>=100');
    else if (want >= 20) reasons.push('want>=20');
    else if (want > 0) reasons.push('want>0');
  } else {
    reasons.push('noWant');
  }

  // 3) View count (weak penalty if extremely low and ratio is present)
  if (view != null && ratio != null) {
    if (view < 50) {
      score -= 5;
      reasons.push('lowViews');
    }
  }

  // 4) Price preference (optional)
  if (price != null) {
    if (opts.minPrice != null && price < opts.minPrice) {
      score -= 8;
      reasons.push('priceBelowMin');
    }
    if (opts.maxPrice != null && price > opts.maxPrice) {
      score -= 8;
      reasons.push('priceAboveMax');
    }

    // Mild preference for cheaper within band.
    if (opts.minPrice != null && opts.maxPrice != null && price >= opts.minPrice && price <= opts.maxPrice) {
      const band = opts.maxPrice - opts.minPrice;
      if (band > 0) {
        const cheaper = clamp01((opts.maxPrice - price) / band);
        score += 5 * cheaper;
        reasons.push('priceInRange');
      }
    }
  } else {
    reasons.push('noPrice');
  }

  // 5) Keyword bonus (optional)
  if (opts.keywords && opts.keywords.length) {
    const hay = String(text).toLowerCase();
    let hits = 0;
    for (const kw of opts.keywords) {
      if (!kw) continue;
      if (hay.includes(kw.toLowerCase())) hits++;
    }
    if (hits) {
      score += Math.min(10, hits * 3);
      reasons.push(`keywordHits:${hits}`);
    } else {
      reasons.push('noKeywordHit');
    }
  }

  // Keep in 0..100
  score = Math.max(0, Math.min(100, score));

  return { score, reasons, derived: { price, want, view, ratio } };
}

async function main() {
  const inPath = arg('--in');
  const outPathArg = arg('--out');
  const top = parseInt(arg('--top', '0'), 10) || 0;

  const minPrice = parseMaybeNumber(arg('--minPrice'));
  const maxPrice = parseMaybeNumber(arg('--maxPrice'));
  const kw = arg('--keywords') || arg('--kw');
  const keywords = kw ? String(kw).split(',').map((s) => s.trim()).filter(Boolean) : [];

  if (!inPath) {
    console.error('Missing --in <enriched|filtered|matches.json>');
    process.exit(2);
  }

  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));

  // Support both shapes:
  // - { items: [...] }
  // - { matches: [...] }
  let list = [];
  let sourceField = null;
  if (Array.isArray(raw.items)) {
    list = raw.items;
    sourceField = 'items';
  } else if (Array.isArray(raw.matches)) {
    list = raw.matches;
    sourceField = 'matches';
  } else {
    console.error('Input JSON must contain an array field: items[] or matches[]');
    process.exit(2);
  }

  const opts = {
    ratioCap: 0.2,
    wantCap: 500,
    minPrice,
    maxPrice,
    keywords,
  };

  const ranked = list.map((it) => {
    const { score, reasons, derived } = scoreItem(it, opts);
    // Keep original fields intact; only add ranking fields.
    return {
      ...it,
      // Fill commonly missing price into output for downstream use.
      price: it.price ?? derived.price ?? it.price,
      score,
      reasons,
    };
  });

  ranked.sort((a, b) => {
    const ds = (b.score ?? 0) - (a.score ?? 0);
    if (ds) return ds;
    const dr = (parseMaybeNumber(b.wantViewRatio) ?? 0) - (parseMaybeNumber(a.wantViewRatio) ?? 0);
    if (dr) return dr;
    const dw = (parseMaybeNumber(b.wantCount) ?? 0) - (parseMaybeNumber(a.wantCount) ?? 0);
    if (dw) return dw;
    const dp = (parseMaybeNumber(a.price) ?? Infinity) - (parseMaybeNumber(b.price) ?? Infinity);
    if (dp) return dp;
    return String(a.url || '').localeCompare(String(b.url || ''));
  });

  const sliced = top > 0 ? ranked.slice(0, top) : ranked;
  const withRank = sliced.map((it, i) => ({ ...it, rank: i + 1 }));

  const outDir = path.join(process.cwd(), 'outputs');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = outPathArg || path.join(outDir, `ranked-${stamp}.json`);

  const out = {
    // Keep some high-level provenance fields if present.
    query: raw.query,
    source: raw.url || raw.source || raw.sourceSearchUrl,
    rankedAt: new Date().toISOString(),
    sourceField,
    count: withRank.length,
    items: withRank,
    meta: buildMeta({
      script: 'skills/goofish-lister/scripts/rank_candidates.js',
      inputs: {
        in: inPath,
        out: outPathArg || null,
        top: top || null,
        minPrice: minPrice ?? null,
        maxPrice: maxPrice ?? null,
        keywords: keywords.length ? keywords : null,
      },
      counts: {
        inputCount: list.length,
        outputCount: withRank.length,
      },
    }),
  };

  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
