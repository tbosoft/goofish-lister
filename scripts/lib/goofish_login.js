const fs = require('fs');
const os = require('os');
const path = require('path');

function getGoofishUserDataDir() {
  return process.env.GOOFISH_USER_DATA_DIR || path.join(os.homedir(), '.openclaw', 'goofish-profile');
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

function getLoginRequiredMessage(userDataDir = getGoofishUserDataDir()) {
  return [
    '未检测到可用的闲鱼登录缓存。',
    '请先执行 `npm run login`，系统会通过 Playwright 打开浏览器供你手动登录闲鱼。',
    '登录完成后关闭浏览器窗口，登录态会缓存到本地 profile，再重新执行发布。',
    `当前 profile 目录: ${userDataDir}`,
  ].join('\n');
}

function getReloginRequiredMessage(userDataDir = getGoofishUserDataDir()) {
  return [
    '检测到闲鱼页面要求重新登录，当前缓存的登录态可能已失效。',
    '请重新执行 `npm run login`，系统会通过 Playwright 打开浏览器供你手动登录闲鱼。',
    '登录完成后关闭浏览器窗口，再重新执行发布。',
    `当前 profile 目录: ${userDataDir}`,
  ].join('\n');
}

module.exports = {
  getGoofishUserDataDir,
  hasCachedLoginProfile,
  getLoginRequiredMessage,
  getReloginRequiredMessage,
};
