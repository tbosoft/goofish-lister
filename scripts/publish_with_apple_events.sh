#!/bin/zsh
set -euo pipefail

ACCOUNT="default"
URL=""
NO_PUBLISH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account)
      ACCOUNT="${2:-default}"
      shift 2
      ;;
    --url|-u)
      URL="${2:-}"
      shift 2
      ;;
    --no-publish)
      NO_PUBLISH=1
      shift
      ;;
    --*)
      echo "Unknown option for Apple Events publish: $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "$URL" ]]; then
        URL="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "Missing Goofish URL." >&2
  exit 2
fi

if [[ ! "$URL" =~ ^https?:// ]]; then
  echo "Missing supported Goofish URL." >&2
  exit 2
fi

OUT_DIR="outputs"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
WORK_DIR="$OUT_DIR/apple-events-$STAMP"
mkdir -p "$WORK_DIR"

TITLE_FILE="$WORK_DIR/title.txt"
URL_FILE="$WORK_DIR/url.txt"
BODY_FILE="$WORK_DIR/body.txt"
DESCRIPTION_FILE="$WORK_DIR/description.txt"
IMAGES_FILE="$WORK_DIR/images.txt"
IMAGE_URL_LIST_FILE="$WORK_DIR/image-urls.txt"
IMAGE_PATH_LIST_FILE="$WORK_DIR/image-paths.txt"
ASSETS_FILE="$WORK_DIR/listing-assets.json"
DRAFT_LOG="$WORK_DIR/draft.log"
FILL_JS="$WORK_DIR/fill_publish.js"
UPLOAD_JS="$WORK_DIR/upload_image.js"

osascript -e 'tell application "Google Chrome" to activate'
osascript -e "tell application \"Google Chrome\" to set URL of active tab of front window to \"$URL\""
sleep 6

run_chrome_js() {
  local js="$1"
  osascript \
    -e 'on run argv' \
    -e 'set jsCode to item 1 of argv' \
    -e 'using terms from application "Google Chrome"' \
    -e 'tell application "Google Chrome" to tell active tab of front window to execute javascript jsCode' \
    -e 'end using terms from' \
    -e 'end run' \
    "$js"
}

write_chrome_text_utf8() {
  local expression="$1"
  local out_file="$2"
  local b64_file="$out_file.b64"

  # Keep AppleScript on an ASCII-only boundary. Passing Chinese text directly
  # through osascript/read POSIX file can corrupt it on some macOS locales.
  run_chrome_js "(() => {
    const text = String(($expression) ?? '');
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  })()" > "$b64_file"

  node -e '
const fs = require("fs");
const [inFile, outFile] = process.argv.slice(1);
const b64 = fs.readFileSync(inFile, "utf8").replace(/\s+/g, "");
fs.writeFileSync(outFile, Buffer.from(b64, "base64"));
' "$b64_file" "$out_file"
  rm -f "$b64_file"
}

write_chrome_text_utf8 'document.title' "$TITLE_FILE"
write_chrome_text_utf8 'location.href' "$URL_FILE"
write_chrome_text_utf8 'document.body.innerText' "$BODY_FILE"
write_chrome_text_utf8 '(() => {
  function cleanText(txt) {
    return String(txt || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  function isNoiseText(txt) {
    const s = cleanText(txt);
    if (!s) return true;
    const lines = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return true;
    const joined = lines.join(" | ");
    const noiseRes = [
      /^\d+人想要$/,
      /^\d+浏览$/,
      /^卖家信用/,
      /^回头客超\d+%/,
      /^为你推荐/,
      /^你可能还想找/,
      /^相关推荐/,
      /^猜你喜欢/,
      /^更多商品/,
      /^更多宝贝/,
      /^相似商品/,
      /^同款/,
      /^聊一聊$/,
      /^立即购买$/,
      /^收藏$/,
      /^举报$/,
      /^担保交易$/,
      /^小刀价$/,
      /^包邮$/,
      /^¥\s*$/,
      /^[0-9]+(?:\.[0-9]+)?$/
    ];
    const noisyLines = lines.filter((line) => noiseRes.some((re) => re.test(line)));
    if (noisyLines.length >= Math.max(2, Math.ceil(lines.length * 0.5))) return true;
    if (/卖家信用|人想要|浏览|为你推荐|猜你喜欢|相关推荐/.test(joined)) return true;
    return false;
  }
  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function scoreDescCandidate(el) {
    if (!el) return -1;
    const txt = cleanText(el.innerText || el.textContent || "");
    if (!txt || isNoiseText(txt)) return -1;
    const rect = el.getBoundingClientRect?.() || { width: 0, height: 0, top: 0 };
    const area = safeNum(rect.width) * safeNum(rect.height);
    let score = 0;
    score += Math.min(txt.length, 4000);
    score += Math.min(area / 20, 3000);
    const cls = String(el.className || "");
    if (/desc|detail|content|introduc|article|rich/i.test(cls)) score += 1500;
    if (rect.top > 0 && rect.top < 2200) score += 600;
    if (txt.includes("\n")) score += 300;
    if (txt.length < 20) score -= 2000;
    return score;
  }
  const metaDesc = document.querySelector("meta[name=\"description\"]")?.getAttribute("content") || "";
  const ogDesc = document.querySelector("meta[property=\"og:description\"]")?.getAttribute("content") || "";
  const detailRoots = [
    document.querySelector("[class*=\"item-main-window\"]"),
    document.querySelector("main"),
    document.querySelector("[class*=\"detail\"]"),
    document.querySelector("[class*=\"content\"]")
  ].filter(Boolean);
  const descCandidates = [];
  const pushed = new Set();
  function pushDescCandidate(el, source) {
    if (!el || pushed.has(el)) return;
    pushed.add(el);
    const text = cleanText(el.innerText || el.textContent || "");
    if (!text || isNoiseText(text)) return;
    descCandidates.push({ source, text, score: scoreDescCandidate(el) });
  }
  for (const root of detailRoots) {
    pushDescCandidate(root, "detailRoot");
    const selectors = [
      "[class*=\"desc--\"]",
      "[class*=\"desc\"]",
      "[class*=\"detail\"]",
      "[class*=\"content\"]",
      "[class*=\"introduc\"]",
      "[class*=\"article\"]",
      "section",
      "article",
      "div"
    ];
    for (const sel of selectors) {
      for (const el of Array.from(root.querySelectorAll(sel)).slice(0, 120)) {
        pushDescCandidate(el, `root:${sel}`);
      }
    }
  }
  for (const el of Array.from(document.querySelectorAll("[class*=\"desc--\"], [class*=\"desc\"], [class*=\"detail\"], [class*=\"content\"], article, section")).slice(0, 200)) {
    pushDescCandidate(el, "pageScoped");
  }
  descCandidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  return descCandidates[0]?.text || cleanText(ogDesc || metaDesc || "");
})()' "$DESCRIPTION_FILE"
write_chrome_text_utf8 '(() => {
  const maxImages = 30;
  const seen = new Set();
  const candidates = [];
  let order = 0;
  function normUrl(u) {
    const s = String(u || "").trim();
    if (!s || s.startsWith("data:")) return "";
    try {
      return new URL(s, location.href).href;
    } catch {
      return s;
    }
  }
  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function visible(img) {
    if (!img) return false;
    const style = getComputedStyle(img);
    if (style.display === "none" || style.visibility === "hidden" || img.getAttribute("aria-hidden") === "true") return false;
    return true;
  }
  function pushImg(img, source) {
    const url = normUrl(img?.currentSrc || img?.src || img?.getAttribute?.("data-src"));
    if (!url || seen.has(url)) return;
    seen.add(url);
    const rect = img?.getBoundingClientRect?.() || { width: 0, height: 0 };
    const naturalWidth = safeNum(img?.naturalWidth);
    const naturalHeight = safeNum(img?.naturalHeight);
    const area = safeNum(rect.width) * safeNum(rect.height);
    candidates.push({
      order: order++,
      url,
      source,
      hidden: !visible(img),
      naturalWidth,
      naturalHeight,
      area
    });
  }
  const mainWindow = document.querySelector("[class*=\"item-main-window\"]");
  if (mainWindow) {
    for (const img of Array.from(mainWindow.querySelectorAll("img"))) pushImg(img, "mainWindow.img");
  }
  const carousel = document.querySelector("[class*=\"carousel\"]");
  if (carousel) {
    for (const img of Array.from(carousel.querySelectorAll("img"))) pushImg(img, "carousel.img");
  }
  if (candidates.length < 2) {
    for (const img of Array.from(document.images || [])) pushImg(img, "document.images");
  }
  const large = candidates.filter((c) => {
    if (c.hidden) return false;
    const largeNatural = c.naturalWidth >= 300 && c.naturalHeight >= 300;
    const largeRect = c.area >= 300 * 300;
    return largeNatural || largeRect;
  });
  const sourceImages = large.length ? large : candidates.filter((c) => !c.hidden);
  const filtered = [];
  const seen2 = new Set();
  for (const c of sourceImages) {
    const lower = c.url.toLowerCase();
    if (!/\/bao\/uploaded\//i.test(lower)) continue;
    if (seen2.has(c.url)) continue;
    seen2.add(c.url);
    filtered.push(c.url);
    if (filtered.length >= maxImages) break;
  }
  if (!filtered.length) {
    for (const c of sourceImages) {
      const lower = c.url.toLowerCase();
      const hasExt = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(lower);
      const hasImgHint = /(img|image|photo|pic|jpeg|jpg|png|webp)/i.test(lower);
      if (!(hasExt || hasImgHint)) continue;
      if (seen2.has(c.url)) continue;
      seen2.add(c.url);
      filtered.push(c.url);
      if (filtered.length >= maxImages) break;
    }
  }
  return filtered.join("\n");
})()' "$IMAGES_FILE"

node -e '
const fs = require("fs");
const [imagesFile, outFile] = process.argv.slice(1);
const allUrls = fs.readFileSync(imagesFile, "utf8")
  .split(/\r?\n/)
  .map((x) => x.trim())
  .filter(Boolean)
  .filter((u, idx, arr) => arr.indexOf(u) === idx);
let urls = allUrls.filter((u) => /img\.alicdn\.com\/bao\/uploaded/i.test(u));
if (!urls.length) urls = allUrls.filter((u) => /img\.alicdn\.com/i.test(u));
if (!urls.length) urls = allUrls;
fs.writeFileSync(outFile, urls.join("\n"));
' "$IMAGES_FILE" "$IMAGE_URL_LIST_FILE"

IMAGE_PATHS=()
while IFS= read -r IMAGE_URL || [[ -n "$IMAGE_URL" ]]; do
  [[ -z "$IMAGE_URL" ]] && continue
  IMAGE_PATH="$WORK_DIR/image-${#IMAGE_PATHS[@]}.webp"
  curl -L -o "$IMAGE_PATH" "$IMAGE_URL"
  IMAGE_PATHS+=("$IMAGE_PATH")
done < "$IMAGE_URL_LIST_FILE"
printf '%s\n' "${IMAGE_PATHS[@]}" > "$IMAGE_PATH_LIST_FILE"

TITLE="$(cat "$TITLE_FILE")"
FINAL_URL="$(cat "$URL_FILE")"

node -e '
const fs = require("fs");
const [assetsFile, titleFile, urlFile, bodyFile, descFile, imageListFile] = process.argv.slice(1);
const title = fs.readFileSync(titleFile, "utf8").trim();
const url = fs.readFileSync(urlFile, "utf8").trim();
const bodyText = fs.readFileSync(bodyFile, "utf8").trim();
const descText = fs.existsSync(descFile) ? fs.readFileSync(descFile, "utf8").trim() : "";
const imagePaths = fs.existsSync(imageListFile)
  ? fs.readFileSync(imageListFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  : [];
const images = imagePaths.map((imagePath, order) => ({
  order,
  url: null,
  alt: null,
  source: "chrome-apple-events",
  width: null,
  height: null,
  rectW: null,
  rectH: null,
  area: null,
  localPath: imagePath,
  downloadStatus: "ok",
  downloadError: null,
  processedPath: imagePath,
  processedStatus: "ok",
  processedError: null,
  processedBytes: fs.existsSync(imagePath) ? fs.statSync(imagePath).size : null
}));
const lines = bodyText.split(/\n/).map((x) => x.trim()).filter(Boolean);
let start = title ? lines.findIndex((line) => title.replace(/[_\-\s]*闲鱼\s*$/u, "").includes(line) || line.includes(title.replace(/[_\-\s]*闲鱼\s*$/u, ""))) : -1;
if (start < 0) start = 0;
let end = lines.findIndex((line, idx) => idx > start && /^(聊一聊|立即购买|收藏|为你推荐)$/.test(line));
if (end < 0) end = Math.min(lines.length, start + 20);
function cleanLines(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
function cleanTitle(t) {
  return String(t || "").replace(/[_\-\s]*闲鱼\s*$/u, "").trim();
}
function takeCoreSectionLines(body, listingTitle) {
  const rawLines = cleanLines(body);
  const t = cleanTitle(listingTitle);
  let startIdx = 0;
  if (t) {
    const idx = rawLines.findIndex((l) => l.includes(t) || t.includes(l));
    if (idx !== -1) startIdx = idx;
  }
  if (startIdx === 0 && rawLines.length > 5) {
    for (let i = 0; i < Math.min(rawLines.length, 30); i++) {
      if (/^\d+浏览$/.test(rawLines[i]) || /^\d+人想要$/.test(rawLines[i])) {
        startIdx = i + 1;
      }
    }
  }
  let endIdx = rawLines.length;
  const endMarkers = ["为你推荐", "发闲置", "消息", "商品码", "客服", "回顶部", "© Goofish.com", "闲鱼社区", "统一社会信用代码", "增值电信业务", "你可能还想找", "相关推荐", "猜你喜欢"];
  for (let i = startIdx; i < rawLines.length; i++) {
    if (endMarkers.some((m) => rawLines[i].includes(m))) {
      endIdx = i;
      break;
    }
  }
  const uiNoiseExact = new Set(["展开", "聊一聊", "立即购买", "收藏", "举报", "担保交易", "搜索", "网页版", "闲鱼号", "关注"]);
  const uiNoisePatterns = [
    /^搜索/,
    /^网页版/,
    /来闲鱼\d+天/,
    /卖出\d+件/,
    /好评率\d+/,
    /^\d+分钟前来过$/,
    /^\d+小时前来过$/,
    /^\d+天前来过$/,
    /^刚刚来过$/,
    /^\d+人想要$/,
    /^\d+浏览$/,
    /^¥\s*$/,
    /^[0-9]+(?:\.[0-9]+)?$/,
    /^[.。·,，:：;；-]+$/,
    /^包邮$/,
    /^小刀价$/,
    /^回头客超\d+%/,
    /^卖家信用/,
    /^为你推荐/,
    /^你可能还想找/,
    /^相关推荐/,
    /^猜你喜欢/,
    /^更多商品/,
    /^更多宝贝/,
    /^相似商品/,
    /^同款/,
    /^统一社会信用代码/,
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
    /^算法备案/
  ];
  let sawPriceFragment = false;
  const core = rawLines.slice(startIdx, endIdx)
    .filter((line) => !uiNoiseExact.has(line))
    .filter((line) => {
      const isNoise = uiNoisePatterns.some((re) => re.test(line));
      if (/^¥\s*$/.test(line) || /^[0-9]+(?:\.[0-9]+)?$/.test(line) || /^[.。·,，:：;；-]+$/.test(line)) {
        sawPriceFragment = true;
      }
      if (isNoise) return false;
      if (sawPriceFragment && line.length <= 12 && !/[。！？!?~～]|我想要|感兴趣|链接|网盘|发货|下单|拍/u.test(line)) return false;
      return true;
    })
    .filter((line) => !/^#\s*/.test(line))
    .filter((line) => !/^\d{1,2}$/.test(line));
  while (core.length && (/^(\d+\s*人想要|\d+\s*浏览|¥\s*$|[0-9]+(?:\.[0-9]+)?$|包邮|小刀价)$/u.test(core[0]) || core[0].length <= 2)) {
    core.shift();
  }
  return core;
}
const descLines = takeCoreSectionLines(descText || lines.slice(start, end).join("\n"), title);
const description = descLines.join("\n");
const out = {
  url,
  fetchedAt: new Date().toISOString(),
  title,
  description,
  bodyText,
  images,
  processedDir: imagePaths.length ? require("path").dirname(imagePaths[0]) : null,
  meta: {
    schemaVersion: "goofish-lister.output.v1",
    tool: "goofish-lister",
    script: "scripts/publish_with_apple_events.sh",
    generatedAt: new Date().toISOString(),
    inputs: { browser: "chrome-apple-events" },
    counts: { images: images.length }
  }
};
fs.writeFileSync(assetsFile, JSON.stringify(out, null, 2));
' "$ASSETS_FILE" "$TITLE_FILE" "$URL_FILE" "$BODY_FILE" "$DESCRIPTION_FILE" "$IMAGE_PATH_LIST_FILE"

node scripts/generate_draft.js \
  --in "$ASSETS_FILE" \
  --category "笔记资料" \
  --price-strategy minus2pct \
  --round fen | tee "$DRAFT_LOG"

DRAFT_FILE="$(tail -n 1 "$DRAFT_LOG")"
if [[ ! -f "$DRAFT_FILE" ]]; then
  echo "Draft file not found: $DRAFT_FILE" >&2
  exit 1
fi

osascript -e 'tell application "Google Chrome" to set URL of active tab of front window to "https://www.goofish.com/publish"'
sleep 4

node -e '
const fs = require("fs");
const [draftFile, outFile] = process.argv.slice(1);
const draft = JSON.parse(fs.readFileSync(draftFile, "utf8"));
const title = String(draft.title || "");
const description = String(draft.description || "");
const titleB64 = Buffer.from(title, "utf8").toString("base64");
const descriptionB64 = Buffer.from(description, "utf8").toString("base64");
const price = String(draft.price ?? "");
const js = `(() => {
  const titleBytes = Uint8Array.from(atob(${JSON.stringify(titleB64)}), (c) => c.charCodeAt(0));
  const title = new TextDecoder().decode(titleBytes);
  const descriptionBytes = Uint8Array.from(atob(${JSON.stringify(descriptionB64)}), (c) => c.charCodeAt(0));
  const description = new TextDecoder().decode(descriptionBytes);
  const price = ${JSON.stringify(price)};
  const titleRe = /(\\u6807\\u9898|\\u5b9d\\u8d1d\\u6807\\u9898|\\u5546\\u54c1\\u6807\\u9898)/;
  const descRe = /(\\u63cf\\u8ff0|\\u8be6\\u60c5|\\u5b9d\\u8d1d\\u63cf\\u8ff0|\\u5546\\u54c1\\u63cf\\u8ff0|\\u4ecb\\u7ecd)/;
  const priceRe = /(\\u4ef7\\u683c|\\u552e\\u4ef7|\\u6807\\u4ef7)/;
  function fire(el) {
    const text = "value" in el ? el.value : (el.innerText || el.textContent || "");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function contextText(el) {
    const form = el.closest(".ant-form-item,[class*=form],[class*=Form]");
    if (form && form.innerText) return form.innerText.replace(/\\s+/g, "");
    let node = el;
    for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
      if (node.innerText) return node.innerText.replace(/\\s+/g, "");
    }
    return "";
  }
  function setInputLike(el, text) {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, "");
      fire(el);
      setter.call(el, String(text));
    } else {
      el.value = String(text);
    }
    fire(el);
    el.blur();
    return true;
  }
  function setEditable(el, text) {
    el.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, String(text));
    } catch {
      el.innerText = String(text);
    }
    fire(el);
    el.blur();
    return true;
  }
  function fillByContext(selector, re, text) {
    const els = Array.from(document.querySelectorAll(selector)).filter(visible);
    const exact = els.find((el) => re.test(contextText(el)) || re.test(el.placeholder || "") || re.test(el.getAttribute("aria-label") || ""));
    if (!exact) return false;
    if (exact.matches("[contenteditable=true]")) return setEditable(exact, text);
    return setInputLike(exact, text);
  }
  function fillFirstInput(selectors, text) {
    for (const selector of selectors) {
      const el = Array.from(document.querySelectorAll(selector)).find(visible);
      if (el && setInputLike(el, text)) return true;
    }
    return false;
  }
  function scorePriceInput(el, idx) {
    const ctx = contextText(el);
    const id = el.id || "";
    const name = el.name || "";
    const cls = el.className || "";
    const placeholder = el.placeholder || "";
    const aria = el.getAttribute("aria-label") || "";
    const type = el.type || "";
    const inputMode = el.getAttribute("inputmode") || "";
    let score = 0;
    if (id === "itemPriceDTO_priceInCent") score += 600;
    if (/price/i.test(id) || /price/i.test(name)) score += 100;
    if (/ant-input-number-input/.test(cls) && priceRe.test(ctx)) score += 120;
    if (priceRe.test(ctx)) score += 80;
    if (/\\u539f\\u4ef7/.test(ctx)) score -= 260;
    if (priceRe.test(placeholder) || /0\\.00|\\d+\\.\\d+/.test(placeholder)) score += 35;
    if (priceRe.test(aria)) score += 35;
    if (type === "number" || /decimal|numeric/.test(inputMode)) score += 15;
    if (el.disabled || el.readOnly) score -= 300;
    score -= idx * 0.01;
    return score;
  }
  function fillPrice(text) {
    const exactSelectors = [
      ".ant-form-item:has(label[for='itemPriceDTO_priceInCent']) input",
      ".ant-form-item:has(.ant-form-item-label label[title='\\u4ef7\\u683c']) input",
      ".ant-form-item:has(.ant-form-item-label) .ant-input-number-input",
      "input#itemPriceDTO_priceInCent",
      "input[name*=price i]",
      "input[id*=price i]"
    ];
    if (fillFirstInput(exactSelectors, text)) return true;
    if (fillByContext("input", priceRe, text)) return true;

    const candidates = Array.from(document.querySelectorAll("input")).filter(visible)
      .map((el, idx) => ({ el, score: scorePriceInput(el, idx) }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score < 20) return false;
    return setInputLike(best.el, text);
  }
  const titleOk = title ? (
    fillByContext("input,textarea,[contenteditable=true]", titleRe, title)
  ) : false;
  const fallbackEditable = Array.from(document.querySelectorAll("[contenteditable=true]")).filter(visible).sort((a, b) => contextText(b).length - contextText(a).length)[0];
  const descOk =
    fillByContext("textarea,[contenteditable=true]", descRe, description) ||
    (fallbackEditable ? setEditable(fallbackEditable, description) : false);
  const priceOk = price ? fillPrice(price) : false;
  return JSON.stringify({ ok: true, titleOk, descOk, priceOk, titleChars: title.length, descriptionChars: description.length, price });
})()`;
fs.writeFileSync(outFile, js);
' "$DRAFT_FILE" "$FILL_JS"

if [[ ${#IMAGE_PATHS[@]} -gt 0 ]]; then
  node -e '
const fs = require("fs");
const [imageListFile, outFile] = process.argv.slice(1);
const imagePaths = fs.readFileSync(imageListFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const payloads = imagePaths.map((imagePath) => ({
  b64: fs.readFileSync(imagePath, "base64"),
  name: require("path").basename(imagePath)
}));
const js = `(() => {
  const payloads = ${JSON.stringify(payloads)};
  const input = document.querySelector("input[type=file]");
  if (!input) return JSON.stringify({ ok: false, error: "no-file-input" });
  if (!input.multiple) input.multiple = true;
  const dt = new DataTransfer();
  for (const payload of payloads) {
    const bin = atob(payload.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], payload.name, { type: "image/webp" }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const previewCount = Array.from(document.images || []).filter((img) => {
    const src = img.currentSrc || img.src || "";
    const box = img.closest("[class*=upload],[class*=Upload],[class*=image],[class*=Image]");
    return box && src;
  }).length;
  return JSON.stringify({ ok: true, files: input.files.length, names: Array.from(input.files).map((f) => f.name), previewCount });
})()`;
fs.writeFileSync(outFile, js);
' "$IMAGE_PATH_LIST_FILE" "$UPLOAD_JS"

  UPLOAD_RESULT="$(osascript \
    -e "set jsCode to read POSIX file \"$(pwd)/$UPLOAD_JS\"" \
    -e 'using terms from application "Google Chrome"' \
    -e 'tell application "Google Chrome" to tell active tab of front window to execute javascript jsCode' \
    -e 'end using terms from')"
  echo "UPLOAD_IMAGES: $UPLOAD_RESULT"
  sleep 4
fi

osascript \
  -e "set jsCode to read POSIX file \"$(pwd)/$FILL_JS\"" \
  -e 'using terms from application "Google Chrome"' \
  -e 'tell application "Google Chrome" to tell active tab of front window to execute javascript jsCode' \
  -e 'end using terms from'
sleep 1

if [[ "$NO_PUBLISH" == "1" ]]; then
  echo "NO_PUBLISH: skipped publish click"
else
  run_chrome_js '(() => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const bodyText = () => (document.body && document.body.innerText) || "";
    const hasAppOnlyHint = () => /请用\s*APP\s*发布|去\s*APP\s*发布|仅支持\s*APP\s*发布|只支持\s*APP\s*发布|网页版暂不支持发布此分类|请使用闲鱼APP扫码继续发布/u.test(bodyText());
    const textOf = (el) => ((el?.innerText || el?.textContent || el?.value || "").replace(/\s+/g, " ").trim());
    const getPublishButton = () =>
      Array.from(document.querySelectorAll("button,[role=button],div,span"))
        .filter(visible)
        .find((el) => (el.innerText || "").trim() === "发布" && String(el.className || "").includes("publish-button")) ||
      Array.from(document.querySelectorAll("button,[role=button],div,span"))
        .filter(visible)
        .find((el) => (el.innerText || "").trim() === "发布");
    const isDisabled = (el) => {
      if (!el) return true;
      return el.getAttribute("aria-disabled") === "true" || !!el.disabled || /\bdisabled\b|\bloading\b/.test(String(el.className || ""));
    };
    const clickFirst = (nodes) => {
      const el = nodes.find(visible);
      if (!el) return false;
      el.click();
      return true;
    };
    const openCategoryPicker = () => {
      const categoryFormItem = Array.from(document.querySelectorAll(".categoryList--lqyn7MJb .ant-form-item, .ant-form-item"))
        .find((el) => /分类/.test(textOf(el)));
      const trigger =
        categoryFormItem?.querySelector(".ant-select-selector, [role=combobox], .ant-select") ||
        Array.from(document.querySelectorAll(".ant-select-selector, [role=combobox], .ant-select"))
          .find((el) => visible(el) && /分类|类目|属性规格/.test(textOf(el.closest(".ant-form-item") || el)));
      if (!trigger || !visible(trigger)) return false;
      const fire = (type) => trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      fire("mousedown");
      fire("mouseup");
      trigger.click();
      const input =
        trigger.matches?.("input") ? trigger :
        trigger.querySelector?.("input[role=combobox], .ant-select-selection-search-input") ||
        trigger.closest?.(".ant-select")?.querySelector?.("input[role=combobox], .ant-select-selection-search-input");
      if (input && visible(input)) {
        try {
          input.focus();
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
        } catch {}
      }
      const dropdown = Array.from(document.querySelectorAll(".ant-select-dropdown")).find((el) => visible(el));
      const selectOpen = !!categoryFormItem?.querySelector(".ant-select-open, .ant-select-focused");
      return !!dropdown || selectOpen;
    };
    const getCurrentCategoryText = () => {
      const nodes = Array.from(document.querySelectorAll(".ant-form-item,[class*=category],[role=combobox]"))
        .filter(visible);
      for (const el of nodes) {
        const text = ((el.innerText || "").replace(/\s+/g, " ").trim());
        if (text && /分类|类目|属性规格|闲置/.test(text)) return text;
      }
      return "";
    };
    const chooseCategory = async (name) => {
      if (!openCategoryPicker()) return { ok: false, reason: "picker-not-opened" };
      await wait(800);
      const exactRe = new RegExp("^\\\\s*" + name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&") + "\\\\s*$");
      const dropdown = Array.from(document.querySelectorAll(".ant-select-dropdown"))
        .find((el) => visible(el)) || document;
      const holder =
        dropdown.querySelector(".rc-virtual-list-holder") ||
        dropdown.querySelector(".rc-virtual-list");
      const findOption = () => Array.from(dropdown.querySelectorAll(".ant-select-item-option,[role=option],.ant-select-item-option-content"))
        .filter((el) => visible(el));
      const pickFromVisible = (els) => {
        return els.find((el) => {
          const title = (el.getAttribute("title") || "").trim();
          const text = textOf(el);
          return exactRe.test(title) || exactRe.test(text) || title.includes(name) || text.includes(name);
        });
      };
      let picked = pickFromVisible(findOption());
      if (!picked && holder) {
        const maxScrollTop = Math.max(0, holder.scrollHeight - holder.clientHeight);
        let attempts = 0;
        let lastScrollTop = -1;
        while (!picked && attempts < 40) {
          const ratio = attempts / 39;
          holder.scrollTop = Math.round(maxScrollTop * ratio);
          holder.dispatchEvent(new Event("scroll", { bubbles: true }));
          await wait(150);
          picked = pickFromVisible(findOption());
          if (picked) break;
          if (holder.scrollTop === lastScrollTop && holder.scrollTop >= maxScrollTop) break;
          lastScrollTop = holder.scrollTop;
          attempts += 1;
        }
      }
      if (!picked) return { ok: false, reason: "option-not-found" };
      picked.click();
      await wait(300);
      clickFirst(
        Array.from(document.querySelectorAll("button,[role=button],div,span"))
          .filter((el) => /确定|完成|确认/.test((el.innerText || "").trim()))
      );
      await wait(800);
      const current = getCurrentCategoryText();
      const matched = current.includes(name) || (name === "其他闲置" && /其他闲置|闲置/.test(current));
      return { ok: matched, current, reason: matched ? "selected" : "selection-not-applied" };
    };

    return (async () => {
      const before = getPublishButton();
      const appOnlyBefore = hasAppOnlyHint();
      if (before && !isDisabled(before) && !appOnlyBefore) {
        return JSON.stringify({
          changed: false,
          skipped: true,
          reason: "publishable-already",
          publishDisabled: isDisabled(before),
          appOnly: appOnlyBefore,
        });
      }
      const result = await chooseCategory("其他闲置");
      const after = getPublishButton();
      return JSON.stringify({
        changed: !!result.ok,
        reason: result.reason,
        current: result.current || "",
        publishDisabled: isDisabled(after),
        appOnly: hasAppOnlyHint()
      });
    })();
  })()' >/dev/null
  sleep 1
  PUBLISH_RESULT="$(run_chrome_js '(() => { const publishText = "\u53d1\u5e03"; const btn = Array.from(document.querySelectorAll("button,[role=button],div,span")).find(el => visible(el) && (el.innerText||"").trim() === publishText && String(el.className||"").includes("publish-button")) || Array.from(document.querySelectorAll("button,[role=button],div,span")).find(el => visible(el) && (el.innerText||"").trim() === publishText); if (!btn) return "NO_BUTTON"; const disabled = btn.getAttribute("aria-disabled") === "true" || !!btn.disabled || /\\bdisabled\\b|\\bloading\\b/.test(String(btn.className||"")); if (disabled) return "BUTTON_DISABLED"; btn.click(); return "CLICKED"; function visible(el){ if(!el) return false; const style = getComputedStyle(el); if(style.display === \"none\" || style.visibility === \"hidden\") return false; const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; } })()')"
  echo "PUBLISH_CLICK: $PUBLISH_RESULT"
  sleep 3
fi
echo "FINAL_URL: $(run_chrome_js 'location.href')"
echo "APPLE_EVENTS_PIPELINE_DONE: account=$ACCOUNT source=$FINAL_URL draft=$DRAFT_FILE"
