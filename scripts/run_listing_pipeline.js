#!/usr/bin/env node
/**
 * Fixed Goofish listing pipeline:
 * 1. Extract listing assets from one Goofish URL
 * 2. Download and beautify images
 * 3. Generate a draft with fixed defaults
 * 4. Open the publish page and auto-publish
 *
 * Usage:
 *   node scripts/run_listing_pipeline.js "https://www.goofish.com/item?id=..."
 *   node scripts/run_listing_pipeline.js --url "https://m.tb.cn/..."
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FIXED_CATEGORY = '笔记资料';
const FIXED_PRICE_STRATEGY = 'minus2pct';
const FIXED_ROUND_MODE = 'fen';

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const value = process.argv[idx + 1];
  return value ?? def;
}

function firstPositionalArg() {
  for (let i = 2; i < process.argv.length; i++) {
    const value = process.argv[i];
    if (!value || value.startsWith('-')) continue;
    return value;
  }
  return null;
}

function resolveUrl() {
  const explicit = arg('--url') || arg('-u');
  if (explicit) return explicit;
  return firstPositionalArg();
}

function looksLikeUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return false;
  return /(goofish\.com|m\.tb\.cn|tb\.cn)/i.test(text);
}

function lastNonEmptyLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

function ensureFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath || '<empty>'}`);
  }
}

function runNodeScript(scriptName, args) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${scriptName} exited with code ${result.status}`);
  }

  return result;
}

(async () => {
  const url = resolveUrl();
  if (!looksLikeUrl(url)) {
    console.error('Missing supported Goofish URL. Pass one 闲鱼商品链接或短链 as the first argument or via --url.');
    process.exit(2);
  }

  console.log(`PIPELINE_START: ${url}`);

  const extractResult = runNodeScript('extract_listing_assets.js', [
    '--url',
    url,
    '--download-images',
    '--beautify-images',
  ]);
  const extractPath = lastNonEmptyLine(extractResult.stdout);
  ensureFile(extractPath, 'Extract output');

  const draftResult = runNodeScript('generate_draft.js', [
    '--in',
    extractPath,
    '--category',
    FIXED_CATEGORY,
    '--price-strategy',
    FIXED_PRICE_STRATEGY,
    '--round',
    FIXED_ROUND_MODE,
  ]);
  const draftPath = lastNonEmptyLine(draftResult.stdout);
  ensureFile(draftPath, 'Draft output');

  runNodeScript('fill_publish_form.js', [
    '--draft',
    draftPath,
    '--force-category',
  ]);

  console.log(`PIPELINE_DONE: ${draftPath}`);
})().catch((error) => {
  console.error(`PIPELINE_FAILED: ${error.message}`);
  process.exit(1);
});
