#!/usr/bin/env node
/**
 * Generate a listing draft (offline) from extract_listing_assets output.
 *
 * No external model calls. No browser automation.
 *
 * Usage:
 *   node skills/goofish-lister/scripts/generate_draft.js --in outputs/listing-assets-xxx.json --category "笔记资料"
 */

const fs = require('fs/promises');
const path = require('path');
const { buildMeta } = require('./lib/output_meta');
const { sanitizeGoofishText } = require('./lib/goofish_text');

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

function roundPrice(price, roundMode) {
  if (!Number.isFinite(price)) return null;
  if (roundMode === 'yuan') return Math.round(price);
  if (roundMode === 'jiao') return Math.round(price * 10) / 10;
  // default: fen
  return Math.round(price * 100) / 100;
}

function cleanTitle(title) {
  if (!title) return '';
  let t = String(title).trim();
  // Common suffixes
  t = t.replace(/[_\-\|\s]*闲鱼\s*$/u, '');
  t = t.replace(/[_\-\|\s]*_?闲鱼\s*$/u, '');
  t = t.replace(/\s*\(.*?闲鱼\)?\s*$/u, '');
  // Trim trailing separators
  t = t.replace(/[\s_\-|]+$/g, '').trim();
  return t;
}

function extractOriginalPrice(bodyText) {
  const text = String(bodyText || '');

  // Pattern 1: "¥ 8.00" (can appear broken into lines; tolerate whitespace/newlines)
  // We'll just match within the full text.
  const yen = text.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
  const yenPrice = yen ? parseMaybeNumber(yen[1]) : null;

  // Pattern 2: "直接买 ￥9.90"
  const direct = text.match(/直接买\s*￥\s*([0-9]+(?:\.[0-9]+)?)/);
  const directPrice = direct ? parseMaybeNumber(direct[1]) : null;

  // Prefer ¥ main price if present; otherwise fall back.
  if (yenPrice != null) return { price: yenPrice, source: 'yen' };
  if (directPrice != null) return { price: directPrice, source: 'directBuy' };

  return { price: null, source: null };
}

function normalizeLines(bodyText) {
  return String(bodyText || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function stripEmojiTokens(s) {
  let out = sanitizeGoofishText(s, { stripBracketTokens: true });

  // Trailing artifacts sometimes appear as a lone digit appended after punctuation, e.g. "同学！6"
  out = out.replace(/([!！。\.])\s*\d{1,2}\s*$/u, '$1');

  return out.trim();
}

function takeCoreSectionLines(bodyText, listingTitle) {
  const lines = normalizeLines(bodyText);
  const t = cleanTitle(listingTitle);

  // Start near the title line if possible.
  let start = 0;
  if (t) {
    const idx = lines.findIndex((l) => l.includes(t) || t.includes(l));
    if (idx !== -1) start = idx;
  }

  // If title match failed (start == 0), try to skip past known header patterns.
  // Goofish pages typically have: search bar -> seller info -> price -> stats -> description
  if (start === 0 && lines.length > 5) {
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      // Description usually starts after the browsing count or price line
      if (/^\d+浏览$/.test(lines[i]) || /^\d+人想要$/.test(lines[i])) {
        start = i + 1;
      }
    }
  }

  // End before recommendations/footer.
  let end = lines.length;
  const endMarkers = ['为你推荐', '发闲置', '消息', '商品码', '客服', '回顶部', '© Goofish.com', '闲鱼社区', '统一社会信用代码', '增值电信业务', '你可能还想找', '相关推荐', '猜你喜欢'];
  for (let i = start; i < lines.length; i++) {
    if (endMarkers.some((m) => lines[i].includes(m))) {
      end = i;
      break;
    }
  }

  // Slice and remove obvious UI actions (exact match).
  const uiNoiseExact = ['展开', '聊一聊', '立即购买', '收藏', '举报', '担保交易', '搜索', '网页版', '闲鱼号', '关注'];
  // Patterns that indicate noise lines (partial/regex match).
  const uiNoisePatterns = [
    /^搜索/,                          // 搜索栏
    /^网页版/,                        // 网页版提示
    /来闲鱼\d+天/,                    // 来闲鱼XX天
    /卖出\d+件/,                      // 卖出XX件宝贝
    /好评率\d+/,                      // 好评率XX%
    /^\d+分钟前来过$/,                // X分钟前来过
    /^\d+小时前来过$/,                // X小时前来过
    /^\d+天前来过$/,                  // X天前来过
    /^刚刚来过$/,
    /^\d+人想要$/,                    // XX人想要
    /^\d+浏览$/,                      // XX浏览
    /^¥\s*$/,                         // 孤立的 ¥ 符号
    /^[0-9]+(?:\.[0-9]+)?$/,          // 孤立数字（价格片段）
    /^包邮$/,
    /^小刀价$/,
    /^回头客超\d+%/,                  // 回头客超XX%卖家
    /^卖家信用/,                      // 卖家信用极好/优秀
    /^为你推荐/,
    /^你可能还想找/,
    /^相关推荐/,
    /^猜你喜欢/,
    /^更多商品/,
    /^更多宝贝/,
    /^相似商品/,
    /^同款/,
    /^小葵的宝藏资料库$/,
    /^柏林买盲盒的菠菜$/,
    /^可乐要加冰吖$/,
    /医学临床三基训练护士分册/,
    /^统一社会信用代码/,              // 页脚法律信息
    /^增值电信/,
    /^营业性演出/,
    /^广播电视/,
    /^网络食品/,
    /^集邮市场/,
    /^APP备案号/,
    /^浙公网安备/,
    /^电子营业执照/,
    /^闲鱼社区/,
    /^软件许可协议/,
    /^闲鱼规则/,
    /^意见征集/,
    /^算法备案/,
    /^推动绿色发展/,
    /《.*》$/,                        // 孤立的法规引用
    /^【个人闲置全新.*】$/,
    /（第五版）/,
    /配套训练试题集/,
  ];

  const core = lines
    .slice(start, end)
    .map(stripEmojiTokens)
    .map((l) => l.replace(/^#\s*/g, ''))
    .filter((l) => l && !uiNoiseExact.includes(l))
    .filter((l) => !uiNoisePatterns.some((re) => re.test(l)))
    // Drop stray footer/page artifacts like single-digit lines (e.g. "6")
    .filter((l) => !/^\d{1,2}$/.test(l));

  // Drop leading noise lines: metrics, seller info, short fragments.
  while (core.length && (/^(\d+\s*人想要|\d+\s*浏览|¥\s*$|[0-9]+(?:\.[0-9]+)?$|包邮|小刀价)$/u.test(core[0]) || core[0].length <= 2)) {
    core.shift();
  }

  return core;
}

function buildStructuredDescription(coreLines) {
  // Heuristic splitting into three sections.
  const intro = [];
  const trade = [];
  const notes = [];

  // Markers
  const noteMarkers = ['买前须知', '免责声明', '概不退款', '不退款', '拍下视为', '仅供学习', '版权'];
  const tradeMarkers = ['包邮', '同城', '自提', '发货', '网盘', '链接', '下单', '拍', '担保交易'];

  let mode = 'intro';
  for (const raw of coreLines) {
    const l = raw.trim();
    if (!l) continue;

    if (noteMarkers.some((m) => l.includes(m))) mode = 'notes';

    if (mode !== 'notes' && tradeMarkers.some((m) => l.includes(m))) {
      // keep intro too, but push trade-related lines into trade bucket.
      trade.push(l);
      continue;
    }

    if (mode === 'notes') notes.push(l);
    else intro.push(l);
  }

  // De-dup within each section while preserving order.
  function uniqKeep(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const k = x;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  }

  const introU = uniqKeep(intro).slice(0, 25);
  const tradeU = uniqKeep(trade).slice(0, 12);
  const notesU = uniqKeep(notes).slice(0, 20);

  const parts = [];
  parts.push(...(introU.length ? introU : ['（请补充：来源/成色/包含内容/交易方式）']));
  parts.push('');
  parts.push('【交易方式】');
  parts.push(...(tradeU.length ? tradeU : ['支持闲鱼担保交易；具体交付方式见说明。']));
  parts.push('');
  parts.push('【注意事项】');
  parts.push(...(notesU.length ? notesU : ['请在下单前确认信息，如有问题先聊一聊沟通。']));

  // Final cleanup: remove ultra-long footer-like lines.
  return parts
    .map((l) => l.replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length <= 300)
    .join('\n');
}

function listImagePaths(images) {
  return (Array.isArray(images) ? images : [])
    .map((im, idx) => ({
      order: Number.isFinite(im?.order) ? im.order : idx,
      path:
        (im?.processedStatus === 'ok' && im?.processedPath) ||
        (im?.downloadStatus === 'ok' && im?.localPath) ||
        null,
    }))
    .filter((item) => item.path)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.path);
}

(async () => {
  const inPath = arg('--in');
  const outArg = arg('--out');

  const category = arg('--category', '') || '笔记资料';
  const priceStrategy = arg('--price-strategy', 'minus2pct');
  const roundMode = arg('--round', 'fen');

  if (!inPath) {
    console.error('Missing --in <listing-assets.json>');
    process.exit(2);
  }

  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));

  const { price: originalPrice, source: originalPriceSource } = extractOriginalPrice(raw.bodyText || '');
  let price = null;
  if (originalPrice != null && priceStrategy === 'minus2pct') {
    price = roundPrice(originalPrice * 0.98, roundMode);
  } else if (originalPrice != null) {
    // Unknown strategy: keep original.
    price = roundPrice(originalPrice, roundMode);
  }

  const title = stripEmojiTokens(cleanTitle(raw.title || ''));
  const descSeed = String(raw.description || '').trim();
  const bodySeed = String(raw.bodyText || '').trim();
  let coreLines = [];

  if (descSeed) {
    coreLines = normalizeLines(descSeed)
      .map(stripEmojiTokens)
      .map((l) => l.replace(/^#\s*/g, ''))
      .filter(Boolean);
  }

  if (coreLines.length < 2 && bodySeed) {
    coreLines = takeCoreSectionLines(bodySeed, raw.title || '');
  }

  const description = buildStructuredDescription(coreLines);

  // Images selection:
  // - Prefer per-image processedPath/localPath so we preserve original listing order
  // - Fallback to existing raw.images order for older outputs
  let images = listImagePaths(raw.images);
  if (!images.length) {
    images = (raw.images || [])
      .map((im) => im?.localPath)
      .filter(Boolean);
  }

  const outDir = path.join(process.cwd(), 'outputs');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = outArg || path.join(outDir, `draft-${stamp}.json`);

  const out = {
    title,
    description,
    price,
    category: category || null,
    images,
    sourceUrl: raw.url || null,
    generatedAt: new Date().toISOString(),
    meta: buildMeta({
      script: 'skills/goofish-lister/scripts/generate_draft.js',
      inputs: {
        in: inPath,
        out: outArg || null,
        category: category || null,
        priceStrategy,
        round: roundMode,
        originalPrice,
        originalPriceSource,
        usedProcessedDir: Boolean(raw.processedDir),
      },
      counts: {
        images: images.length,
      },
    }),
  };

  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
