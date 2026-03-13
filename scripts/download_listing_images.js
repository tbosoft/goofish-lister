#!/usr/bin/env node
/**
 * download_listing_images.js
 *
 * Extractor for images
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function must(cond, msg) {
  if (!cond) {
    console.error(`ERROR: ${msg}`);
    process.exit(2);
  }
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv);

  const itemUrl = args.url || args._[0];
  const outDir = args.out || 'outputs/downloaded-images';
  const userDataDir = args.profile || process.env.GOOFISH_USER_DATA_DIR || path.join(process.env.HOME || '', '.openclaw/goofish-profile');

  must(itemUrl && /^https:\/\/(www\.)?goofish\.com\//.test(itemUrl), 'Provide a goofish item URL via --url or as the first argument.');

  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // Navigate
  await page.goto(itemUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Try to extract image URLs from common patterns.
  // Goofish DOM can change; so we use a broad heuristic:
  // - <img src="..."> under a carousel/gallery
  // - CSS background-image urls
  const imageUrls = await page.evaluate(() => {
    const urls = new Set();

    // img tags
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      const dataSrc = img.getAttribute('data-src') || '';
      [src, dataSrc].forEach((u) => {
        if (!u) return;
        if (u.startsWith('http')) urls.add(u);
      });
    });

    // background-image
    document.querySelectorAll('*').forEach((el) => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage || '';
      const m = bg.match(/url\(["']?(http[^"')]+)["']?\)/i);
      if (m && m[1]) urls.add(m[1]);
    });

    return Array.from(urls);
  });

  // Filter to likely product images (best-effort)
  const filtered = imageUrls
    .filter((u) => /.(jpg|jpeg|png|webp)(\?|$)/i.test(u))
    .slice(0, Number(args.max || 12));

  console.log(JSON.stringify({ itemUrl, found: imageUrls.length, selected: filtered.length }, null, 2));

  // Download via Node fetch (keeps cookies out; many images are public CDN). If blocked, user can still manually save.
  for (let i = 0; i < filtered.length; i++) {
    const url = filtered[i];
    const ext = (url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)?.[1] || 'jpg').toLowerCase();
    const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${sha1(url).slice(0, 10)}.${ext}`);

    if (fs.existsSync(file)) {
      console.log(`skip existing: ${file}`);
      continue;
    }

    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      console.log(`saved: ${file}`);
    } catch (e) {
      console.log(`failed: ${url} -> ${String(e)}`);
    }
  }

  console.log(`done. outDir=${outDir}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
