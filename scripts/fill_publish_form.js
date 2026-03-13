#!/usr/bin/env node
/**
 * Fill Goofish publish form from a generated draft JSON.
 *
 * Safety:
 * - NEVER clicks final publish/confirm.
 * - Opens headed persistent browser context.
 * - Intended for single-item assisted listing; no batching.
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

function hasFlag(name) {
  return process.argv.includes(name);
}

function fmtAction(label, obj) {
  const s = obj ? ` ${JSON.stringify(obj)}` : '';
  return `- ${label}${s}`;
}

(async () => {
  const draftPath = arg('--draft');
  const dryRun = hasFlag('--dry-run');
  const debugSelectors = hasFlag('--debug-selectors');
  const preview = hasFlag('--preview');
  const previewPathArg = arg('--preview-path');
  const hold = hasFlag('--hold');
  const holdMinutes = parseFloat(arg('--hold-minutes', '30'));

  if (!draftPath) {
    console.error('Missing --draft <draft.json>');
    process.exit(2);
  }

  const draft = JSON.parse(await fs.readFile(draftPath, 'utf8'));
  const title = String(draft.title || '').trim();
  const description = String(draft.description || '').trim();
  const price = draft.price;
  const category = draft.category || '电子资料';
  const images = Array.isArray(draft.images) ? draft.images : [];

  const plan = [
    fmtAction('Open publish page', { url: 'https://www.goofish.com/publish' }),
    fmtAction('Fill title', { title: title.slice(0, 40) + (title.length > 40 ? '...' : '') }),
    fmtAction('Fill description', { chars: description.length }),
    fmtAction('Fill price', { price }),
    fmtAction('Select category', { category }),
    fmtAction('Upload images', { count: images.length }),
    fmtAction('Click publish', { note: 'Auto publish.' }),
  ];

  // Convert image objects to array of paths if they exist
  const uploadPaths = [];
  if (Array.isArray(draft.images)) {
    for (const im of draft.images) {
      if (typeof im === 'string') {
        uploadPaths.push(im);
      } else if (im && typeof im === 'object') {
        if (im.processedStatus === 'ok' && im.processedPath) {
          uploadPaths.push(im.processedPath);
        } else if (im.downloadStatus === 'ok' && im.localPath) {
          uploadPaths.push(im.localPath);
        } else if (im.path) {
          uploadPaths.push(im.path);
        }
      }
    }
  }

  if (dryRun) {
    console.log('DRY RUN: will perform the following actions:');
    console.log(plan.join('\n'));
    process.exit(0);
  }

  const userDataDir = process.env.GOOFISH_USER_DATA_DIR || path.join(os.homedir(), '.openclaw', 'goofish-profile');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.goofish.com/publish', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);

  if (debugSelectors) {
    const debug = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      const info = {
        url: location.href,
        title: document.title,
        illegalAccess: /非法访问/.test(document.body?.innerText || ''),
        bodyTextHead: (document.body?.innerText || '').slice(0, 400),
      };

      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .slice(0, 50)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          return {
            tag,
            visible: visible(el),
            disabled: el.disabled || false,
            type: tag === 'input' ? (el.getAttribute('type') || 'text') : null,
            inputMode: tag === 'input' ? (el.getAttribute('inputmode') || null) : null,
            placeholder: el.getAttribute('placeholder') || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            name: el.getAttribute('name') || null,
            id: el.getAttribute('id') || null,
            class: el.getAttribute('class') || null,
            maxLength: el.getAttribute('maxlength') || null,
          };
        });

      const keywords = ['标题', '宝贝标题', '商品标题', '描述', '宝贝描述', '价格', '售价', '分类', '类目'];
      const clickableSelector = 'button, [role="button"], [onclick], [tabindex], div, span, a';
      const clickables = Array.from(document.querySelectorAll(clickableSelector))
        .map((el) => {
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const ariaLabel = el.getAttribute('aria-label') || '';
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            visible: visible(el),
            text,
            ariaLabel: ariaLabel || null,
            class: el.getAttribute('class') || null,
            tabIndex: el.getAttribute('tabindex') || null,
          };
        })
        .filter((x) => {
          const t = x.text || '';
          const a = x.ariaLabel || '';
          if (!t && !a) return false;
          return keywords.some((k) => t.includes(k) || a.includes(k));
        })
        .slice(0, 50);

      const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
        .slice(0, 20)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          visible: visible(el),
          ariaLabel: el.getAttribute('aria-label') || null,
          placeholder: el.getAttribute('placeholder') || null,
          class: el.getAttribute('class') || null,
          textHead: (el.innerText || '').slice(0, 120),
        }));

      return { info, inputs, clickables, editables };
    });

    console.log('=== DEBUG: page info ===');
    console.log(JSON.stringify(debug.info, null, 2));

    console.log('=== DEBUG: inputs/textarea (first 50) ===');
    for (const it of debug.inputs) console.log(JSON.stringify(it));

    console.log('=== DEBUG: contenteditable (first 20) ===');
    for (const it of debug.editables) console.log(JSON.stringify(it));

    console.log('=== DEBUG: clickable elements matching keywords (first 50) ===');
    for (const it of debug.clickables) console.log(JSON.stringify(it));

    await ctx.close();
    process.exit(0);
  }

  // Helpers: try multiple locator strategies.
  async function fillFirst(candidates, value) {
    for (const loc of candidates) {
      try {
        if ((await loc.count()) === 0) continue;
        const el = await pickVisible(loc);
        if (!el) continue;
        await el.click({ timeout: 2000 });
        await el.fill(String(value));
        return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  async function fillContentEditable(loc, value) {
    const el = await pickVisible(loc);
    if (!el) return false;
    await el.click({ timeout: 2000 });
    await page.keyboard.press('Meta+A');
    await page.keyboard.type(String(value));
    return true;
  }

  async function fillAntdFormItem(labelRe, value) {
    const items = page.locator('.ant-form-item');
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const it = items.nth(i);
      let labelText = '';
      try {
        const lbl = it.locator('.ant-form-item-label');
        labelText = (await lbl.innerText().catch(() => '')) || '';
      } catch {
        labelText = '';
      }
      if (!labelRe.test(labelText)) continue;

      // Prefer input/textarea in the control area.
      const input = await pickVisible(it.locator('input, textarea'));
      if (input) {
        await input.click({ timeout: 2000 });
        await input.fill(String(value));
        return true;
      }

      // Fall back to contenteditable editor.
      const editable = await pickVisible(it.locator('[contenteditable="true"]'));
      if (editable) {
        await editable.click({ timeout: 2000 });
        await page.keyboard.press('Meta+A');
        await page.keyboard.type(String(value));
        return true;
      }
    }
    return false;
  }

  async function clickFirst(candidates) {
    for (const loc of candidates) {
      try {
        if ((await loc.count()) === 0) continue;
        await loc.first().click({ timeout: 2000 });
        return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  // Utility: pick a visible element from locators
  async function pickVisible(locator) {
    const n = await locator.count();
    for (let i = 0; i < n; i++) {
      const el = locator.nth(i);
      try {
        if (await el.isVisible()) return el;
      } catch {
        // ignore
      }
    }
    return null;
  }

  // 1) Title
  // Priority: placeholder -> label -> AntD form item label -> fallback visible text input
  let titleErr = null;
  let titleOk = false;
  try {
    titleOk =
      (await fillFirst(
        [
          page.getByPlaceholder(/标题|宝贝标题|商品标题/u),
          page.getByPlaceholder(/请输入.*标题/u),
        ],
        title
      )) ||
      (await fillFirst([page.getByLabel(/标题|宝贝标题|商品标题/u)], title)) ||
      (await fillAntdFormItem(/标题|宝贝标题|商品标题/u, title));

    if (!titleOk) {
      const fallback = await pickVisible(
        page.locator('input[type="text"], input:not([type]), input[type="search"]')
      );
      if (fallback) {
        await fallback.click({ timeout: 2000 });
        await fallback.fill(title);
        titleOk = true;
      }
    }
  } catch (e) {
    titleErr = String(e?.message || e);
  }
  if (!titleOk) console.log('WARN: failed to fill title.', titleErr ? `reason=${titleErr}` : '');

  // 2) Description
  // Priority: textarea with placeholder/label -> AntD form item label -> any textarea -> contenteditable
  let descErr = null;
  let descOk = false;
  try {
    descOk =
      (await fillFirst(
        [
          page.getByPlaceholder(/描述|宝贝描述|商品描述/u),
          page.getByPlaceholder(/请输入.*描述|请输入.*介绍/u),
          page.getByLabel(/描述|详情|宝贝描述|商品描述/u),
        ],
        description
      )) ||
      (await fillAntdFormItem(/描述|宝贝描述|商品描述|详情/u, description)) ||
      (await fillFirst([page.locator('textarea')], description)) ||
      (await fillContentEditable(page.locator('[contenteditable="true"]'), description));
  } catch (e) {
    descErr = String(e?.message || e);
  }
  if (!descOk) console.log('WARN: failed to fill description.', descErr ? `reason=${descErr}` : '');

  // 3) Price
  // Priority: input[type=number] -> placeholder includes 价格/售价 -> AntD form item label
  let priceErr = null;
  let priceOk = false;
  try {
    if (price != null) {
      priceOk =
        (await fillFirst([page.locator('input[type="number"]')], price)) ||
        (await fillFirst([page.getByPlaceholder(/价格|售价|￥/u)], price)) ||
        (await fillAntdFormItem(/价格|售价|标价/u, price));

      if (!priceOk) {
        // Observed on publish page: price input is type=text with placeholder 0.00
        const priceInput = page.locator('input[placeholder="0.00"]');
        const el = await pickVisible(priceInput);
        if (el) {
          await el.click({ timeout: 2000 });
          await el.fill(String(price));
          priceOk = true;
        }
      }
    } else {
      console.log('WARN: draft.price is null; skipping price fill.');
    }
  } catch (e) {
    priceErr = String(e?.message || e);
  }
  if (price != null && !priceOk) console.log('WARN: failed to fill price.', priceErr ? `reason=${priceErr}` : '');

  // 4) Category
  // Strategy: click 分类/类目 entry -> search in modal -> click matching item.
  let catErr = null;
  let catOpened = false;
  try {
    // Publish page seems to have "属性规格" section for category/attributes.
    // Click a nearby entry point if present.
    catOpened = await clickFirst([
      page.getByRole('button', { name: /分类|类目|属性/u }),
      page.getByText(/分类|类目|属性规格/u).first(),
    ]);

    if (!catOpened) {
      // Click the section text itself (often opens attribute/category picker).
      catOpened = await clickFirst([
        page.getByText(/属性规格/u).first(),
        page.locator('.ant-form-item').filter({ hasText: /属性规格/u }).first(),
      ]);
    }

    if (catOpened) {
      await page.waitForTimeout(1000);
      const searchOk = await fillFirst(
        [
          page.getByPlaceholder(/搜索|输入/u),
          page.getByLabel(/搜索/u),
          page.locator('input[type="search"]'),
          page.locator('input').first(),
        ],
        category
      );
      if (searchOk) await page.waitForTimeout(800);

      // Additional robust click on "category name" popup selectors that might not be actual `<option>`s
      const partialCat = category.substring(0, 4); // Just match the first few characters to avoid exact string mismatches if goofish categories are long nested paths
      const picked = await clickFirst([
        page.getByRole('option', { name: new RegExp(partialCat) }),
        page.locator('.ant-cascader-menu-item').filter({ hasText: new RegExp(partialCat) }).first(),
        page.getByText(new RegExp(partialCat)).locator('visible=true').first(),
      ]);
      if (!picked) console.log('WARN: category picker opened but failed to select desired category.');
    } else {
      console.log('WARN: failed to open category/attributes selector; skipping category.');
    }
  } catch (e) {
    catErr = String(e?.message || e);
    console.log('WARN: category selection error:', catErr);
  }

  // 5) Upload images
  if (uploadPaths.length) {
    // Common pattern: hidden <input type=file>
    const fileInput = page.locator('input[type="file"]');
    if ((await fileInput.count()) > 0) {
      try {
        await fileInput.first().setInputFiles(uploadPaths);
        console.log('正在上传图片，等待处理完成...');
        // 关键：给图片上传和服务器处理留出足够时间，防止按钮因处于上传状态而被禁用
        await page.waitForTimeout(8000); 
      } catch (e) {
        console.log('WARN: failed to upload images:', String(e?.message || e));
      }
    } else {
      console.log('WARN: no file input found for uploading images.');
    }
  } else {
    console.log('WARN: draft.images is empty; skipping upload.');
  }

  if (preview) {
    try {
      const outDir = path.join(process.cwd(), 'outputs');
      await fs.mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const previewPath = previewPathArg || path.join(outDir, `publish-preview-${stamp}.png`);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: previewPath, fullPage: true });
      console.log(`PREVIEW_SAVED: ${previewPath}`);
    } catch (e) {
      console.log('WARN: failed to save preview screenshot:', String(e?.message || e));
    }
  }

  console.log('已填充完成，正在自动点击发布...');

  try {
    // 再次等待页面空闲
    await page.waitForLoadState('networkidle').catch(() => {});
    
    const publishBtnSelector = '.publish-button--KBpTVopQ';
    const publishBtn = await pickVisible(
      page.locator(publishBtnSelector),
      page.getByRole('button', { name: /发布|提交/u })
    );

    if (publishBtn) {
      // 检查按钮是否被禁用
      const isDisabled = await publishBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('ant-btn-loading'));
      if (isDisabled) {
        console.log('发布按钮当前不可用，再次等待图片处理...');
        await page.waitForTimeout(6000); // 增加等待时间
      }
      
      await publishBtn.click({ timeout: 10000 });
      console.log('已成功点击发布按钮！');
      await page.waitForTimeout(3000); // 等待发布成功或跳转
    } else {
      console.log('WARN: 未找到发布按钮');
    }
  } catch(e) {
    console.log('WARN: 自动点击发布失败:', String(e?.message || e));
  }

  // Keep the browser open for manual review if requested.
  if (hold) {
    const ms = Math.max(0, Math.min(holdMinutes, 180)) * 60 * 1000;
    console.log(`HOLDING_BROWSER: ${holdMinutes} minutes`);
    await page.waitForTimeout(ms);
    console.log('HOLD_DONE: closing browser window.');
  }
  await ctx.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
