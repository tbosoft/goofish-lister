const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_PROFILE_DIR = path.join(os.homedir(), '.openclaw', 'goofish-profile');
const PROFILE_ROOT_DIR = path.join(os.homedir(), '.openclaw', 'goofish-profiles');

function normalizeGoofishAccountName(accountName) {
  const raw = String(accountName || process.env.GOOFISH_ACCOUNT || 'default').trim();
  if (!raw) return 'default';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'default';
}

function getGoofishUserDataDir(accountName) {
  if (process.env.GOOFISH_USER_DATA_DIR) {
    return process.env.GOOFISH_USER_DATA_DIR;
  }

  const account = normalizeGoofishAccountName(accountName);
  const accountDir = path.join(PROFILE_ROOT_DIR, account);

  if (account === 'default' && fs.existsSync(LEGACY_PROFILE_DIR) && !fs.existsSync(accountDir)) {
    return LEGACY_PROFILE_DIR;
  }

  return accountDir;
}

function fileHasContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function hasCachedLoginProfile(userDataDir = getGoofishUserDataDir()) {
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    return false;
  }

  const profileMarkers = [
    path.join(userDataDir, 'Local State'),
    path.join(userDataDir, 'Default', 'Cookies'),
    path.join(userDataDir, 'Default', 'Network', 'Cookies'),
  ];

  return profileMarkers.some(fileHasContent);
}

function getLoginRequiredMessage(userDataDir = getGoofishUserDataDir(), accountName) {
  const account = normalizeGoofishAccountName(accountName);
  return [
    `未检测到可用的闲鱼登录缓存（账号: ${account}）。`,
    `请先执行 \`npm run login -- --account ${account}\`，系统会通过 Playwright 打开浏览器供你手动登录闲鱼。`,
    '登录完成后关闭浏览器窗口，登录态会缓存到本地 profile，再重新执行发布。',
    `当前 profile 目录: ${userDataDir}`,
  ].join('\n');
}

function getReloginRequiredMessage(userDataDir = getGoofishUserDataDir(), accountName) {
  const account = normalizeGoofishAccountName(accountName);
  return [
    `检测到闲鱼页面要求重新登录（账号: ${account}），当前缓存的登录态可能已失效。`,
    `请重新执行 \`npm run login -- --account ${account}\`，系统会通过 Playwright 打开浏览器供你手动登录闲鱼。`,
    '登录完成后关闭浏览器窗口，再重新执行发布。',
    `当前 profile 目录: ${userDataDir}`,
  ].join('\n');
}

async function maybeClickQuickEnter(page, options = {}) {
  const {
    timeoutMs = 8000,
    afterClickWaitMs = 1800,
    verbose = false,
  } = options;

  if (!page || page.isClosed()) {
    return false;
  }

  const buttonTexts = ['快速进入', '立即进入', '进入闲鱼', '进入', '继续访问'];
  const popupHints = ['快速进入', '立即进入', '闲鱼', '欢迎回来', '继续访问', '弹窗'];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];

      for (const frame of frames) {
        const candidates = [
          frame.getByRole('button', { name: /快速进入|立即进入|进入闲鱼|继续访问|进入/i }).first(),
          frame.getByText(/快速进入|立即进入|进入闲鱼|继续访问/, { exact: false }).first(),
          frame.locator('button, [role="button"], a, div, span').filter({ hasText: /快速进入|立即进入|进入闲鱼|继续访问/ }).first(),
        ];

        for (const locator of candidates) {
          try {
            if (!(await locator.count())) continue;
            const target = locator.first();
            if (!(await target.isVisible({ timeout: 200 }).catch(() => false))) continue;

            const text = ((await target.innerText().catch(() => '')) || '').trim();
            const bodyText = await frame.locator('body').innerText().catch(() => '');
            const likelyPopup = popupHints.some((hint) => text.includes(hint) || bodyText.includes(hint));
            const looksLikeButton = !text || buttonTexts.some((label) => text.includes(label));
            if (!likelyPopup && !looksLikeButton) continue;

            try {
              await target.click({ timeout: 1000 });
            } catch {
              try {
                await target.click({ timeout: 1000, force: true });
              } catch {
                await target.evaluate((el) => el.click());
              }
            }

            await page.waitForTimeout(afterClickWaitMs);
            if (verbose) {
              console.log(`Detected popup and clicked 快速进入${frame !== page.mainFrame() ? ' (iframe)' : ''}.`);
            }
            return true;
          } catch {
            // keep probing other locators
          }
        }
      }

      const clickedByDomProbe = await page.evaluate(() => {
        const matcher = /快速进入|立即进入|进入闲鱼|继续访问/;
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        for (const node of nodes) {
          const text = (node.textContent || '').trim();
          if (!matcher.test(text) || !visible(node)) continue;
          node.click();
          return text || true;
        }
        return false;
      }).catch(() => false);

      if (clickedByDomProbe) {
        await page.waitForTimeout(afterClickWaitMs);
        if (verbose) {
          console.log(`Detected popup and clicked 快速进入${typeof clickedByDomProbe === 'string' ? `: ${clickedByDomProbe}` : ''}.`);
        }
        return true;
      }
    } catch {
      // noop
    }

    await page.waitForTimeout(250);
  }

  return false;
}

module.exports = {
  getGoofishUserDataDir,
  normalizeGoofishAccountName,
  hasCachedLoginProfile,
  getLoginRequiredMessage,
  getReloginRequiredMessage,
  maybeClickQuickEnter,
};
