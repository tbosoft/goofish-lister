#!/usr/bin/env node
/**
 * One-time login helper for Goofish.
 * Launches a *persistent* (headed) Chrome/Chromium profile so you can login.
 *
 * Usage:
 *   GOOFISH_USER_DATA_DIR=~/.openclaw/goofish-profile node scripts/login_once.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');

(async () => {
  const userDataDir = process.env.GOOFISH_USER_DATA_DIR || path.join(os.homedir(), '.openclaw', 'goofish-profile');
  await fs.mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // Using the installed Chrome channel can look more like a normal browser.
    // If not available, Playwright falls back gracefully.
    channel: 'chrome',
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.goofish.com/', { waitUntil: 'domcontentloaded', timeout: 0 });

  console.log('Goofish login window opened.');
  console.log('1) Please login manually in the opened browser window.');
  console.log('2) After login is successful, close the browser window.');
  console.log(`Profile saved at: ${userDataDir}`);

  // Keep alive until user kills the script
  while (true) {
    if (context.pages().length === 0) break;
    await new Promise(r => setTimeout(r, 1000));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
