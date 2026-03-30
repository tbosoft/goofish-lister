#!/usr/bin/env node
/**
 * Fill Goofish publish form from a generated draft JSON.
 *
 * Safety:
 * - Auto-clicks the final publish button unless --no-publish is provided.
 * - Opens headed persistent browser context.
 * - Intended for single-item assisted listing; no batching.
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

function stripEmojiForGoofish(s) {
  let out = String(s || '');
  out = out.replace(/[\u200D\uFE0F]/g, '');
  try {
    out = out.replace(/\p{Extended_Pictographic}/gu, '');
  } catch {
    out = out.replace(/[\u{1F000}-\u{1FAFF}]/gu, '').replace(/[\u{2600}-\u{27BF}]/gu, '');
  }
  return out;
}

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

function composeDescription(title, description, includeTitleInDescription) {
  const cleanTitle = String(title || '').trim();
  const cleanDescription = String(description || '').trim();

  if (!includeTitleInDescription || !cleanTitle) {
    return cleanDescription;
  }

  if (!cleanDescription) {
    return cleanTitle;
  }

  if (cleanDescription.startsWith(cleanTitle)) {
    return cleanDescription;
  }

  return `${cleanTitle}\n\n${cleanDescription}`;
}

(async () => {
  const draftPath = arg('--draft');
  const dryRun = hasFlag('--dry-run');
  const debugSelectors = hasFlag('--debug-selectors');
  const preview = hasFlag('--preview');
  const previewPathArg = arg('--preview-path');
  const hold = hasFlag('--hold');
  const holdMinutes = parseFloat(arg('--hold-minutes', '30'));
  const noPublish = hasFlag('--no-publish');
  const forceCategory = hasFlag('--force-category');

  if (!draftPath) {
    console.error('Missing --draft <draft.json>');
    process.exit(2);
  }

  const draft = JSON.parse(await fs.readFile(draftPath, 'utf8'));
  const title = stripEmojiForGoofish(String(draft.title || '').trim());
  const rawDescription = stripEmojiForGoofish(String(draft.description || '').trim());
  const price = draft.price;
  const draftCategory = String(draft.category || '').trim();
  const category = draftCategory || '笔记资料';
  const images = Array.isArray(draft.images) ? draft.images : [];

  const plan = [
    fmtAction('Open publish page', { url: 'https://www.goofish.com/publish' }),
    fmtAction('Fill title', { title: title.slice(0, 40) + (title.length > 40 ? '...' : '') }),
    fmtAction('Fill description', { chars: rawDescription.length }),
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
  async function pickVisible(...locators) {
    for (const locator of locators) {
      if (!locator) continue;
      let n = 0;
      try {
        n = await locator.count();
      } catch {
        n = 0;
      }
      for (let i = 0; i < n; i++) {
        const el = locator.nth(i);
        try {
          if (await el.isVisible()) return el;
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function getPublishButton() {
    const publishBtnSelector = '.publish-button--KBpTVopQ';
    return await pickVisible(
      page.locator(publishBtnSelector),
      page.getByRole('button', { name: /发布|提交/u })
    );
  }

  async function isButtonDisabled(btn) {
    if (!btn) return true;
    try {
      return await btn.evaluate((el) => {
        const ariaDisabled = el.getAttribute && el.getAttribute('aria-disabled') === 'true';
        const disabledProp = 'disabled' in el ? Boolean(el.disabled) : false;
        const classDisabled =
          (el.classList && (el.classList.contains('ant-btn-loading') || el.classList.contains('ant-btn-disabled'))) ||
          false;
        return ariaDisabled || disabledProp || classDisabled;
      });
    } catch {
      return true;
    }
  }

  async function bodyHasAppOnlyHint() {
    try {
      const t = await page.evaluate(() => document.body?.innerText || '');
      return /请用\s*APP\s*发布|去\s*APP\s*发布|仅支持\s*APP\s*发布|只支持\s*APP\s*发布/u.test(t);
    } catch {
      return false;
    }
  }

  async function openCategoryPicker() {
    const opened =
      (await clickFirst([
        page.getByRole('button', { name: /分类|类目|属性/u }),
        page.getByText(/分类|类目|属性规格/u).first(),
      ])) ||
      (await clickFirst([
        page.getByText(/属性规格/u).first(),
        page.locator('.ant-form-item').filter({ hasText: /属性规格/u }).first(),
      ]));

    if (!opened) return null;

    await page.waitForTimeout(800);

    const overlay = await pickVisible(
      page.locator('.ant-cascader-dropdown'),
      page.locator('.ant-select-dropdown'),
      page.locator('.ant-popover'),
      page.locator('.ant-dropdown'),
      page.locator('.ant-modal'),
      page.locator('.ant-drawer')
    );

    return overlay;
  }

  async function selectCategoryInPicker(name) {
    const categoryName = String(name || '').trim();
    if (!categoryName) return false;

    const overlay = await openCategoryPicker();
    const root = overlay || page;

    // Try to use the picker search box if present.
    const searchInput = await pickVisible(
      root.getByPlaceholder(/搜索|输入/u),
      root.getByLabel(/搜索/u),
      root.locator('input[type="search"]')
    );
    if (searchInput) {
      try {
        await searchInput.click({ timeout: 2000 });
        await searchInput.fill(categoryName);
        await page.waitForTimeout(600);
      } catch {
        // ignore
      }
    }

    const partial = categoryName.length > 4 ? categoryName.slice(0, 4) : categoryName;
    const re = new RegExp(escapeRegExp(partial));

    const picked = await clickFirst([
      root.getByRole('option', { name: re }),
      root.locator('.ant-cascader-menu-item').filter({ hasText: re }).first(),
      root.locator('.ant-select-item-option').filter({ hasText: re }).first(),
      root.locator('.ant-select-item-option-content').filter({ hasText: re }).first(),
      root.getByText(re).first(),
    ]);

    if (!picked) return false;

    // Some pickers require explicit confirmation.
    await clickFirst([
      root.getByRole('button', { name: /确定|完成|确认/u }),
      page.getByRole('button', { name: /确定|完成|确认/u }),
    ]);

    await page.waitForTimeout(800);
    return true;
  }

  async function ensurePublishableCategory() {
    const btn = await getPublishButton();
    if (!btn) return;

    const disabledBefore = await isButtonDisabled(btn);
    if (!disabledBefore) return;

    // Give upload/async validation a chance first.
    await page.waitForTimeout(1500);

    const disabledAgain = await isButtonDisabled(btn);
    if (!disabledAgain) return;

    const appOnly = await bodyHasAppOnlyHint();
    if (!appOnly) return;

    console.log('检测到“请用APP发布”，尝试自动切换到可网页发布的类目...');

    const candidates = [];
    // Prefer a known web-friendly fallback first.
    candidates.push('笔记资料');
    // Then try draft category if it differs and is not the common blocked one.
    if (draftCategory && draftCategory !== '电子资料' && draftCategory !== '笔记资料') {
      candidates.push(draftCategory);
    }
    // Additional fallbacks.
    candidates.push('二手图书');
    candidates.push('图书');

    const tried = new Set();
    for (const c of candidates) {
      const cc = String(c || '').trim();
      if (!cc || tried.has(cc)) continue;
      tried.add(cc);

      console.log(`尝试选择类目: ${cc}`);
      const ok = await selectCategoryInPicker(cc);
      if (!ok) continue;

      await page.waitForTimeout(1200);

      const btnNow = await getPublishButton();
      if (!btnNow) continue;

      const disabledNow = await isButtonDisabled(btnNow);
      const stillAppOnly = await bodyHasAppOnlyHint();

      if (!disabledNow && !stillAppOnly) {
        console.log(`类目已切换为可发布: ${cc}`);
        return;
      }
    }

    console.log('WARN: 未能自动找到可网页发布的类目（发布按钮仍不可用）。');
  }

  // 1) Title
  // Priority: placeholder -> label -> AntD form item label.
  // Do not fall back to generic text inputs; on the new page those may be price inputs.
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
  } catch (e) {
    titleErr = String(e?.message || e);
  }
  if (!titleOk) console.log('WARN: failed to fill title.', titleErr ? `reason=${titleErr}` : '');

  const description = composeDescription(title, rawDescription, !titleOk);
  if (!titleOk && title) {
    console.log('INFO: no standalone title field found; prepending title to description.');
  }

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
  // Price fields are often duplicated (e.g., 价格 + 原价). Avoid blindly filling the first numeric input.
  let priceErr = null;
  let priceOk = false;

  async function fillPriceByHeuristic(value) {
    const v = String(value);

    async function fillInputRobust(inputLoc) {
      const el = await pickVisible(inputLoc);
      if (!el) return false;

      const nv = Number(v.replace(/,/g, ''));

      async function okNow() {
        try {
          const cur = await el.inputValue();
          if (!cur) return false;
          const ncur = Number(String(cur).replace(/,/g, ''));
          if (Number.isFinite(nv) && Number.isFinite(ncur)) return Math.abs(ncur - nv) < 0.001;
          return String(cur).replace(/,/g, '') === v.replace(/,/g, '');
        } catch {
          return false;
        }
      }

      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
      } catch {
        // ignore
      }

      // Helper: blur the input without Tab (Tab jumps to 原价 field).
      async function blurInput() {
        await page.keyboard.press('Escape').catch(() => {});
        await el.evaluate((node) => node.blur()).catch(() => {});
      }

      // Strategy 1: Playwright fill.
      try {
        await el.click({ timeout: 2000 });
        await el.fill('');
        await el.fill(v);
        await blurInput();
        await page.waitForTimeout(150);
        if (await okNow()) return true;
      } catch {
        // ignore
      }

      // Strategy 2: real keyboard typing (slower delay for React InputNumber).
      try {
        await el.click({ timeout: 2000 });
        await page.keyboard.press('Meta+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(50);
        await page.keyboard.type(v, { delay: 35 });
        await blurInput();
        await page.waitForTimeout(200);
        if (await okNow()) return true;
      } catch {
        // ignore
      }

      // Strategy 3: native value setter (bypasses React's value property interception).
      try {
        await el.evaluate((node, val) => {
          const input = node;
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          nativeSetter.call(input, String(val));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        }, v);
        await page.waitForTimeout(200);
        if (await okNow()) return true;
      } catch {
        // ignore
      }

      // Strategy 4: React fiber – directly invoke the component's onChange handler.
      try {
        const changed = await el.evaluate((node, val) => {
          const input = node;
          input.focus();
          // Walk up the React fiber tree to find onChange.
          const fiberKey = Object.keys(input).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          if (!fiberKey) return false;
          let fiber = input[fiberKey];
          for (let i = 0; i < 20 && fiber; i++) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props && typeof props.onChange === 'function') {
              props.onChange(Number(val));
              return true;
            }
            fiber = fiber.return;
          }
          return false;
        }, v);
        if (changed) {
          await page.waitForTimeout(200);
          // Also set display value via native setter so it shows correctly.
          await el.evaluate((node, val) => {
            try {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              ).set;
              nativeSetter.call(node, String(val));
              node.dispatchEvent(new Event('input', { bubbles: true }));
            } catch { /* ignore */ }
          }, v).catch(() => {});
          if (await okNow()) return true;
          // Even if okNow fails, the React state may have been set correctly.
          // Trust the fiber approach if it returned true.
          return true;
        }
      } catch {
        // ignore
      }

      return false;
    }

    // 0) Exact selector from DOM: locate the AntD form item for “价格” and fill its input.
    // NOTE: the input itself may have no id, even if the label has a `for`.
    const exactByFor = page
      .locator('.ant-form-item')
      .filter({ has: page.locator('label[for="itemPriceDTO_priceInCent"]') })
      .locator('input');
    if (await fillInputRobust(exactByFor)) return true;

    const exactByTitle = page
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label label[title="价格"]') })
      .locator('input');
    if (await fillInputRobust(exactByTitle)) return true;

    // 0b) Ant Design InputNumber within a “价格” form item (common pattern).
    const exactInputNumber = page
      .locator('.ant-form-item')
      .filter({ hasText: /价格/u })
      .locator('.ant-input-number-input');
    if (await fillInputRobust(exactInputNumber)) return true;

    const exactByLabelText = page
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label').filter({ hasText: /^\s*价格\s*$/u }) })
      .locator('input');
    if (await fillInputRobust(exactByLabelText)) return true;

    // 1) Common accessible labels/placeholders.
    if (await fillInputRobust(page.getByLabel(/价格|售价|标价/u))) return true;
    if (await fillInputRobust(page.getByPlaceholder(/价格|售价|￥/u))) return true;
    // Avoid old helper that may type into wrong focused editor on this page.

    // 2) Heuristic: pick the best visible input whose surrounding text contains “价格” but not “原价”.
    const best = await page.locator('input').evaluateAll((els) => {
      function visible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function ctxText(el) {
        const byForm = el.closest('.ant-form-item');
        if (byForm && byForm.innerText) return byForm.innerText;

        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          if (node.innerText) return node.innerText;
          node = node.parentElement;
        }
        return '';
      }

      const scored = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!visible(el)) continue;
        const placeholder = el.getAttribute('placeholder') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const type = el.getAttribute('type') || '';
        const inputMode = el.getAttribute('inputmode') || '';
        const id = el.getAttribute('id') || '';
        const ctx = (ctxText(el) || '').replace(/\s+/g, '');

        const cls = el.getAttribute('class') || '';

        let score = 0;
        if (id === 'itemPriceDTO_priceInCent') score += 500;
        if (/price/i.test(id)) score += 80;
        if (/ant-input-number-input/.test(cls) && /价格/.test(ctx)) score += 100;
        if (/价格/.test(ctx)) score += 60;
        if (/原价/.test(ctx)) score -= 200;
        if (/价格/.test(ariaLabel)) score += 30;
        if (/0\.00/.test(placeholder)) score += 10;
        if (type === 'number') score += 5;
        if (/decimal|numeric/.test(inputMode)) score += 5;
        if (el.disabled) score -= 200;

        scored.push({ idx: i, score });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored[0] || null;
    });

    if (!best || best.score < 20) return false;

    const input = page.locator('input').nth(best.idx);
    return await fillInputRobust(input);
  }

  try {
    if (price != null) {
      priceOk = await fillPriceByHeuristic(price);
      if (!priceOk) console.log('WARN: failed to fill price (no suitable input matched).');
    } else {
      console.log('WARN: draft.price is null; skipping price fill.');
    }
  } catch (e) {
    priceErr = String(e?.message || e);
  }

  if (price != null && !priceOk) console.log('WARN: failed to fill price.', priceErr ? `reason=${priceErr}` : '');

  // Click away from the price area to dismiss focus (prevents getting stuck on 原价 field).
  try {
    await page.locator('body').click({ position: { x: 10, y: 10 }, timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
  } catch {
    // ignore
  }

  // 4) Category
  // Strategy:
  // - 默认不强制改类目（因为页面会根据文案自动出现一个“可发布”的类目）
  // - 仅当你传了 --force-category 时，先尝试按 draft.category/默认值选择
  // - 若检测到“请用APP发布”导致发布按钮置灰，则自动尝试切换到可网页发布类目
  let catErr = null;
  try {
    if (forceCategory) {
      const desired = category;
      if (desired) {
        const ok = await selectCategoryInPicker(desired);
        if (!ok) console.log('WARN: failed to force select desired category.');
      }
    }

    // Always try to resolve app-only category blocks.
    await ensurePublishableCategory();
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

  if (noPublish) {
    console.log('NO_PUBLISH: 已填充完成（--no-publish），不会自动点击发布。');
  } else {
    console.log('已填充完成，正在自动点击发布...');
  }

  if (!noPublish) {
    try {
      // 再次等待页面空闲
      await page.waitForLoadState('networkidle').catch(() => {});

      const publishBtn = await getPublishButton();
      if (publishBtn) {
        // 检查按钮是否被禁用
        const isDisabled = await isButtonDisabled(publishBtn);
        if (isDisabled) {
          console.log('发布按钮当前不可用，可能仍在校验/上传处理中...');
          await page.waitForTimeout(3000);
        }

        await publishBtn.click({ timeout: 10000 });
        console.log('已成功点击发布按钮！');
        await page.waitForTimeout(3000); // 等待发布成功或跳转
      } else {
        console.log('WARN: 未找到发布按钮');
      }
    } catch (e) {
      console.log('WARN: 自动点击发布失败:', String(e?.message || e));
    }
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
