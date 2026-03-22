#!/usr/bin/env node
/**
 * Extract listing assets (title/description/bodyText/images) from a Goofish item page.
 *
 * SAFETY / RIGHTS GATE:
 * - Must pass --i-own-rights AND --rights-file <path> (file must exist)
 *
 * Usage:
 *   GOOFISH_USER_DATA_DIR=~/.openclaw/goofish-profile \
 *   node skills/goofish-lister/scripts/extract_listing_assets.js \
 *     --url "https://www.goofish.com/item?id=..." \
 *     --i-own-rights --rights-file skills/goofish-lister/references/rights.md
 *
 * Dry run (no browser):
 *   node skills/goofish-lister/scripts/extract_listing_assets.js --url "..." --dry-run \
 *     --i-own-rights --rights-file skills/goofish-lister/references/rights.md
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const { chromium } = require('playwright');
const { buildMeta } = require('./lib/output_meta');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v ?? def;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function isLikelyImageUrl(u) {
  if (!u) return false;
  const s = String(u).trim();
  if (!s) return false;
  if (s.startsWith('data:')) return false;
  // Some Goofish images may not have classic extensions; allow common extensions and also URLs with query.
  // But reject URLs that look like tracking pixels or svg sprites without a real image hint.
  const lower = s.toLowerCase();
  const hasExt = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(lower);
  const hasImgHint = /(img|image|photo|pic|jpeg|jpg|png|webp)/i.test(lower);
  return hasExt || hasImgHint;
}

function truncateText(s, maxLen) {
  if (s == null) return null;
  const str = String(s);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated ${str.length - maxLen} chars]`;
}

(async () => {
  const url = arg('--url') || arg('-u');
  const outArg = arg('--out');
  const maxImages = parseInt(arg('--max-images', '30'), 10);
  const dryRun = hasFlag('--dry-run');
  const downloadImages = hasFlag('--download-images');
  const imagesDirArg = arg('--images-dir');
  const maxImageBytes = parseInt(arg('--max-image-bytes', String(15 * 1024 * 1024)), 10);
  const maxTotalBytes = parseInt(arg('--max-total-bytes', String(200 * 1024 * 1024)), 10);
  const beautifyImages = hasFlag('--beautify-images');
  const border = parseInt(arg('--border', '40'), 10);
  const processedDirArg = arg('--processed-dir');
  const jpgQuality = parseInt(arg('--jpg-quality', '92'), 10);

  if (!url) {
    console.error('Missing --url <itemUrl>');
    process.exit(2);
  }

  // Resolve short URLs (m.tb.cn, etc.) to full Goofish URLs via HTTP redirect.
  let resolvedUrl = url;
  const shortUrlPatterns = [/m\.tb\.cn/i, /tb\.cn/i, /taobao\.com\/.*spread/i];
  if (shortUrlPatterns.some((re) => re.test(url))) {
    console.log(`Resolving short URL: ${url}`);
    try {
      const resp = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const finalUrl = resp.url;
      if (finalUrl && finalUrl !== url) {
        console.log(`Resolved to: ${finalUrl}`);
        resolvedUrl = finalUrl;
      }
    } catch (e) {
      console.log(`WARN: Could not resolve short URL via fetch, will let browser handle redirect: ${e.message}`);
    }
  }

  const outDir = path.join(process.cwd(), 'outputs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultOutPath = path.join(outDir, `listing-assets-${stamp}.json`);
  const outPath = outArg || defaultOutPath;

  const defaultImagesDir = path.join(outDir, `listing-assets-${stamp}-images`);
  const imagesDir = imagesDirArg || defaultImagesDir;
  const processedDir = processedDirArg || `${imagesDir}-processed`;

  const meta = buildMeta({
    script: 'skills/goofish-lister/scripts/extract_listing_assets.js',
    inputs: {
      url,
      out: outArg || null,
      maxImages,
      dryRun,
      downloadImages,
      imagesDir: imagesDirArg || null,
      maxImageBytes,
      maxTotalBytes,
      beautifyImages,
      border,
      processedDir: processedDirArg || null,
      jpgQuality,
      // Only record whether a persistent profile dir was provided; do not record the path.
      persistentProfile: Boolean(process.env.GOOFISH_USER_DATA_DIR),
    },
    counts: {},
  });

  if (dryRun) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    console.log(outPath);
    console.log(JSON.stringify(meta, null, 2));
    process.exit(0);
  }

  function sha16(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
  }

  function extFromContentType(ct) {
    const t = String(ct || '').toLowerCase().split(';')[0].trim();
    if (t === 'image/jpeg' || t === 'image/jpg') return '.jpg';
    if (t === 'image/png') return '.png';
    if (t === 'image/webp') return '.webp';
    if (t === 'image/gif') return '.gif';
    return null;
  }

  function extFromUrl(u) {
    try {
      const parsed = new URL(u);
      const p = parsed.pathname || '';
      const m = p.match(/\.(png|jpe?g|webp|gif|bmp)$/i);
      if (m) {
        const ext = m[0].toLowerCase();
        return ext === '.jpeg' ? '.jpg' : ext;
      }
    } catch {
      // ignore
    }
    return null;
  }

  if (beautifyImages && !downloadImages) {
    console.error('Refusing to run: --beautify-images requires --download-images.');
    process.exit(2);
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  if (downloadImages) {
    await fs.mkdir(imagesDir, { recursive: true });
  }
  if (downloadImages && beautifyImages) {
    await fs.mkdir(processedDir, { recursive: true });
  }

  const userDataDir = process.env.GOOFISH_USER_DATA_DIR || path.join(os.homedir(), '.openclaw', 'goofish-profile');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  // Goofish requires network idle or specific selector loading to properly fetch dynamic details
  await page.goto(resolvedUrl, { waitUntil: 'networkidle', timeout: 60000 });

  // If the URL was a short link that required JS redirect, wait for it to land on goofish.com.
  if (resolvedUrl !== url || !page.url().includes('goofish.com')) {
    try {
      await page.waitForURL(/goofish\.com/, { timeout: 15000 });
      console.log(`Landed on: ${page.url()}`);
    } catch {
      console.log(`WARN: Page did not redirect to goofish.com (current: ${page.url()}). Proceeding anyway.`);
    }
  }
  
  // Wait longer, or specifically for images to load, since Goofish is heavily dynamic React.
  try {
     // Wait for the main item container to be visible (class might change but usually there's a gallery or description block)
     await page.waitForSelector('img[src*="alicdn"]', { timeout: 10000 });
  } catch(e) {
     console.log('WARN: Did not find main product image tags within timeout.');
  }

  await page.waitForTimeout(3000);
  try {
     // Optional: Scroll down to trigger lazy loading
     await page.evaluate(() => window.scrollBy(0, 500));
     await page.waitForTimeout(2000);
     await page.evaluate(() => window.scrollBy(0, 500));
     await page.waitForTimeout(2000);
  } catch(e) {}


  const extracted = await page.evaluate((maxImagesInner) => {
    function normUrl(u) {
      if (!u) return null;
      return String(u).trim();
    }

    function collectBackgroundUrls(styleText) {
      const urls = [];
      if (!styleText) return urls;
      const re = /url\((?:"|')?([^"')]+)(?:"|')?\)/g;
      let m;
      while ((m = re.exec(styleText))) {
        urls.push(m[1]);
      }
      return urls;
    }

    function inViewport(rect) {
      if (!rect) return false;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      // Any intersection with viewport
      return rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh;
    }

    function safeNum(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }

    const title = document.title || null;

    // Best-effort description extraction:
    // - Prefer meta description / og:description
    // - Fall back to largest text block in the page.
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || null;
    const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || null;

    // Specific Goofish description selectors (narrowest first)
    const gfDesc = document.querySelector('.desc--GaIUKUQY')?.innerText ||
                   // Try any element whose class starts with "desc--" (hashed class)
                   (() => {
                     const candidates = document.querySelectorAll('[class*="desc--"]');
                     for (const el of candidates) {
                       const txt = (el.innerText || '').trim();
                       // Only accept if it looks like a real description (>20 chars, not a single word)
                       if (txt.length > 20 && txt.includes('\n') || txt.length > 50) return txt;
                     }
                     return null;
                   })() ||
                   null;

    const bodyText = (document.body?.innerText || '').replace(/\s+\n/g, '\n').trim();

    let description = gfDesc || ogDesc || metaDesc;
    if (!description) {
      // Fallback: pick a chunk from bodyText.
      description = bodyText ? bodyText.slice(0, 800) : null;
    }

    // Images: collect metrics to filter out icons/UI.
    const imgCandidates = [];
    const seen = new Set();

    function pushImgCandidate(u, alt, source, imgEl) {
      const url = normUrl(u);
      if (!url) return;
      if (seen.has(url)) return;
      seen.add(url);

      const rect = imgEl?.getBoundingClientRect ? imgEl.getBoundingClientRect() : null;
      const style = imgEl ? window.getComputedStyle(imgEl) : null;
      const hidden = !imgEl || style?.display === 'none' || style?.visibility === 'hidden' || imgEl.getAttribute('aria-hidden') === 'true';

      const naturalWidth = safeNum(imgEl?.naturalWidth);
      const naturalHeight = safeNum(imgEl?.naturalHeight);
      const clientWidth = safeNum(imgEl?.clientWidth);
      const clientHeight = safeNum(imgEl?.clientHeight);

      const rectW = rect ? safeNum(rect.width) : 0;
      const rectH = rect ? safeNum(rect.height) : 0;
      const area = rectW * rectH;

      imgCandidates.push({
        url,
        alt: alt || null,
        source: source || null,
        naturalWidth,
        naturalHeight,
        clientWidth,
        clientHeight,
        rectW,
        rectH,
        area,
        inViewport: rect ? inViewport(rect) : false,
        hidden,
      });
    }

    // Precise extraction: try finding the main window first
    const mainWindow = document.querySelector('[class*="item-main-window"]');
    if (mainWindow) {
      const mainImages = Array.from(mainWindow.querySelectorAll('img'));
      for (const img of mainImages) {
        pushImgCandidate(img.currentSrc || img.src || img.getAttribute('data-src'), img.alt, 'mainWindow.img', img);
      }
    }

    // Extra check for carousel if main window didn't yield enough/any
    const carousel = document.querySelector('[class*="carousel"]');
    if (carousel) {
      const carouselImages = Array.from(carousel.querySelectorAll('img'));
      for (const img of carouselImages) {
        pushImgCandidate(img.currentSrc || img.src || img.getAttribute('data-src'), img.alt, 'carousel.img', img);
      }
    }

    // Only if we found VERY FEW images should we fallback to full document.images
    if (imgCandidates.length < 2) {
      for (const img of Array.from(document.images || [])) {
        pushImgCandidate(img.currentSrc, img.alt, 'img.currentSrc', img);
        pushImgCandidate(img.src, img.alt, 'img.src', img);
        pushImgCandidate(img.getAttribute('data-src'), img.alt, 'img[data-src]', img);
      }
    }

    // Filter large images first.
    const large = imgCandidates.filter((c) => {
      if (c.hidden) return false;
      const largeNatural = c.naturalWidth >= 300 && c.naturalHeight >= 300;
      const largeRect = c.area >= 300 * 300;
      return largeNatural || largeRect;
    });

    // Sort by visible area first, then natural size.
    large.sort((a, b) => {
      const da = (b.area || 0) - (a.area || 0);
      if (da) return da;
      const dn = (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight);
      if (dn) return dn;
      // Prefer in-viewport
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      return 0;
    });

    const images = [];
    for (const c of large) {
      images.push({
        url: c.url,
        alt: c.alt,
        source: c.source,
        width: c.naturalWidth || null,
        height: c.naturalHeight || null,
        rectW: c.rectW || null,
        rectH: c.rectH || null,
        area: c.area || null,
      });
      if (images.length >= maxImagesInner) break;
    }

    // Background images: lower priority; only fill if not enough.
    if (images.length < maxImagesInner) {
      const nodes = Array.from(document.querySelectorAll('*'));
      const bgSeen = new Set(images.map((x) => x.url));
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        const bg = style?.backgroundImage;
        if (!bg || bg === 'none') continue;
        for (const u of collectBackgroundUrls(bg)) {
          const uu = normUrl(u);
          if (!uu) continue;
          if (bgSeen.has(uu)) continue;
          bgSeen.add(uu);
          // No size metrics for CSS backgrounds here.
          images.push({ url: uu, alt: null, source: 'css.backgroundImage', width: null, height: null, rectW: null, rectH: null, area: null });
          if (images.length >= maxImagesInner) break;
        }
        if (images.length >= maxImagesInner) break;
      }
    }

    return {
      title,
      description,
      bodyText,
      images,
    };
  }, maxImages);

  // Post-filter + de-dupe again (defense in depth)
  const filteredImages = [];
  const seen2 = new Set();
  for (const im of extracted.images || []) {
    const u = im?.url ? String(im.url).trim() : '';
    if (!u || u.startsWith('data:')) continue;
    // Filter out obvious noise: no extension/hint and very short URLs
    const lower = u.toLowerCase();
    const hasExt = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(lower);
    const hasImgHint = /(img|image|photo|pic|jpeg|jpg|png|webp)/i.test(lower);
    if (!(hasExt || hasImgHint)) continue;
    if (seen2.has(u)) continue;
    seen2.add(u);
    filteredImages.push({
      url: u,
      alt: im.alt ?? null,
      source: im.source ?? null,
      width: im.width ?? null,
      height: im.height ?? null,
      rectW: im.rectW ?? null,
      rectH: im.rectH ?? null,
      area: im.area ?? null,
      localPath: null,
      downloadStatus: downloadImages ? 'skipped' : 'skipped',
      downloadError: downloadImages ? 'not-downloaded-yet' : null,
      processedPath: null,
      processedStatus: beautifyImages ? 'skipped' : 'skipped',
      processedError: beautifyImages ? 'not-processed-yet' : null,
      processedBytes: null,
    });
    if (filteredImages.length >= maxImages) break;
  }

  // Download images if requested.
  let imagesDownloaded = 0;
  let imagesSkipped = 0;
  let imagesFailed = 0;
  let bytesDownloaded = 0;

  // Beautify (processed JPGs with white border)
  let processedOk = 0;
  let processedFailed = 0;
  let processedBytes = 0;

  // Prepare request context once (inherits storage state / cookies from the persistent context).
  const requestContext = ctx.request;

  if (downloadImages) {
    for (const im of filteredImages) {
      if (bytesDownloaded >= maxTotalBytes) {
        im.downloadStatus = 'skipped';
        im.downloadError = 'max-total-bytes-reached';
        imagesSkipped++;
        continue;
      }

      const imgUrl = im.url;
      const baseName = sha16(imgUrl);

      try {
        // Use Playwright request to inherit context (cookies / headers if needed).
        const resp = await requestContext.get(imgUrl, { timeout: 60000 });
        if (!resp.ok()) {
          im.downloadStatus = 'failed';
          im.downloadError = `http-${resp.status()}`;
          imagesFailed++;
          continue;
        }

        const headers = resp.headers();
        const contentType = headers['content-type'] || headers['Content-Type'];

        // Prefer size from headers; fall back to body size.
        const contentLengthHeader = headers['content-length'] || headers['Content-Length'];
        const declaredLen = contentLengthHeader ? parseInt(String(contentLengthHeader), 10) : null;
        if (declaredLen != null && Number.isFinite(declaredLen) && declaredLen > maxImageBytes) {
          im.downloadStatus = 'skipped';
          im.downloadError = `max-image-bytes(${declaredLen})`;
          imagesSkipped++;
          continue;
        }

        const buf = await resp.body();
        if (buf.length > maxImageBytes) {
          im.downloadStatus = 'skipped';
          im.downloadError = `max-image-bytes(${buf.length})`;
          imagesSkipped++;
          continue;
        }

        if (bytesDownloaded + buf.length > maxTotalBytes) {
          im.downloadStatus = 'skipped';
          im.downloadError = 'max-total-bytes-would-exceed';
          imagesSkipped++;
          continue;
        }

        const ext = extFromContentType(contentType) || extFromUrl(imgUrl) || '.jpg';
        const fileName = `${baseName}${ext}`;
        const filePath = path.join(imagesDir, fileName);

        await fs.writeFile(filePath, buf);

        im.localPath = filePath;
        im.downloadStatus = 'ok';
        im.downloadError = null;
        imagesDownloaded++;
        bytesDownloaded += buf.length;

        if (beautifyImages) {
          try {
            const outJpgPath = path.join(processedDir, `${baseName}.jpg`);

            const img = sharp(buf, { failOn: 'none' });
            const meta0 = await img.metadata();
            const jpgBuf = await img
              .rotate() // honor EXIF orientation when present
              .extend({
                top: border,
                bottom: border,
                left: border,
                right: border,
                background: '#ffffff',
              })
              .jpeg({ quality: jpgQuality })
              .toBuffer();

            await fs.writeFile(outJpgPath, jpgBuf);

            im.processedPath = outJpgPath;
            im.processedStatus = 'ok';
            im.processedError = null;
            im.processedBytes = jpgBuf.length;
            processedOk++;
            processedBytes += jpgBuf.length;

            // If width/height missing (e.g., some CSS bg added), fill from sharp metadata.
            if (!im.width && meta0?.width) im.width = meta0.width;
            if (!im.height && meta0?.height) im.height = meta0.height;
          } catch (e2) {
            im.processedStatus = 'failed';
            im.processedError = String(e2?.message || e2);
            im.processedBytes = null;
            processedFailed++;
          }
        } else {
          im.processedStatus = 'skipped';
          im.processedError = null;
        }
      } catch (e) {
        im.downloadStatus = 'failed';
        im.downloadError = String(e?.message || e);
        imagesFailed++;

        if (beautifyImages) {
          im.processedStatus = 'skipped';
          im.processedError = 'download-failed';
        } else {
          im.processedStatus = 'skipped';
          im.processedError = null;
        }
      }
    }
  } else {
    // If not downloading, treat as skipped without error.
    for (const im of filteredImages) {
      im.downloadStatus = 'skipped';
      im.downloadError = null;
      imagesSkipped++;
      im.processedStatus = 'skipped';
      im.processedError = null;
    }
  }

  // Use the final page URL (after any redirects) as the canonical URL.
  const finalUrl = page.url();

  const out = {
    url: finalUrl,
    fetchedAt: new Date().toISOString(),
    title: extracted.title || null,
    description: extracted.description || null,
    bodyText: truncateText(extracted.bodyText || '', 20000),
    images: filteredImages,
    processedDir: downloadImages && beautifyImages ? processedDir : null,
    meta: buildMeta({
      script: 'skills/goofish-lister/scripts/extract_listing_assets.js',
      inputs: {
        url,
        resolvedUrl: resolvedUrl !== url ? resolvedUrl : undefined,
        out: outArg || null,
        maxImages,
        dryRun: false,
        downloadImages,
        imagesDir: downloadImages ? imagesDir : null,
        maxImageBytes,
        maxTotalBytes,
        beautifyImages,
        border,
        processedDir: downloadImages && beautifyImages ? processedDir : null,
        jpgQuality,
        persistentProfile: Boolean(process.env.GOOFISH_USER_DATA_DIR),
      },
      counts: {
        images: filteredImages.length,
        imagesDownloaded,
        imagesSkipped,
        imagesFailed,
        bytesDownloaded,
        processedOk,
        processedFailed,
        processedBytes,
      },
    }),
  };

  await ctx.close();

  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
