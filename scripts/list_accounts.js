#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasCachedLoginProfile } = require('./lib/goofish_login');

const legacyDir = path.join(os.homedir(), '.openclaw', 'goofish-profile');
const profilesRoot = path.join(os.homedir(), '.openclaw', 'goofish-profiles');

function listAccounts() {
  const accounts = [];
  const seen = new Set();

  if (fs.existsSync(legacyDir) && hasCachedLoginProfile(legacyDir)) {
    accounts.push({ account: 'default', dir: legacyDir, source: 'legacy' });
    seen.add('default');
  }

  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const dir = path.join(profilesRoot, entry.name);
      if (!hasCachedLoginProfile(dir)) continue;
      accounts.push({ account: entry.name, dir, source: 'profiles' });
      seen.add(entry.name);
    }
  }

  return accounts;
}

const accounts = listAccounts();
if (!accounts.length) {
  console.log('No cached Goofish accounts found.');
  process.exit(0);
}

for (const item of accounts) {
  console.log(`${item.account}\t${item.dir}\t${item.source}`);
}
