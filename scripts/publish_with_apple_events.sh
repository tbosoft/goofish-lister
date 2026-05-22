#!/bin/zsh
set -euo pipefail

ACCOUNT="default"
URL=""

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
IMAGES_FILE="$WORK_DIR/images.txt"
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
write_chrome_text_utf8 'Array.from(document.images).map(img=>img.currentSrc||img.src).filter(Boolean).join("\n")' "$IMAGES_FILE"

IMAGE_URL="$(awk '/img\.alicdn\.com\/bao\/uploaded/ && /790x10000/ { print; exit }' "$IMAGES_FILE")"
if [[ -z "$IMAGE_URL" ]]; then
  IMAGE_URL="$(awk '/img\.alicdn\.com\/bao\/uploaded/ { print; exit }' "$IMAGES_FILE")"
fi

IMAGE_PATH=""
if [[ -n "$IMAGE_URL" ]]; then
  IMAGE_PATH="$WORK_DIR/main.webp"
  curl -L -o "$IMAGE_PATH" "$IMAGE_URL"
fi

TITLE="$(cat "$TITLE_FILE")"
FINAL_URL="$(cat "$URL_FILE")"

node -e '
const fs = require("fs");
const [assetsFile, titleFile, urlFile, bodyFile, imagePath, imageUrl] = process.argv.slice(1);
const title = fs.readFileSync(titleFile, "utf8").trim();
const url = fs.readFileSync(urlFile, "utf8").trim();
const bodyText = fs.readFileSync(bodyFile, "utf8").trim();
const image = imagePath ? {
  order: 0,
  url: imageUrl || null,
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
} : null;
const lines = bodyText.split(/\n/).map((x) => x.trim()).filter(Boolean);
let start = title ? lines.findIndex((line) => title.replace(/[_\-\s]*闲鱼\s*$/u, "").includes(line) || line.includes(title.replace(/[_\-\s]*闲鱼\s*$/u, ""))) : -1;
if (start < 0) start = 0;
let end = lines.findIndex((line, idx) => idx > start && /^(聊一聊|立即购买|收藏|为你推荐)$/.test(line));
if (end < 0) end = Math.min(lines.length, start + 20);
const description = lines.slice(start, end).join("\n");
const out = {
  url,
  fetchedAt: new Date().toISOString(),
  title,
  description,
  bodyText,
  images: image ? [image] : [],
  processedDir: imagePath ? require("path").dirname(imagePath) : null,
  meta: {
    schemaVersion: "goofish-lister.output.v1",
    tool: "goofish-lister",
    script: "scripts/publish_with_apple_events.sh",
    generatedAt: new Date().toISOString(),
    inputs: { browser: "chrome-apple-events" },
    counts: { images: image ? 1 : 0 }
  }
};
fs.writeFileSync(assetsFile, JSON.stringify(out, null, 2));
' "$ASSETS_FILE" "$TITLE_FILE" "$URL_FILE" "$BODY_FILE" "$IMAGE_PATH" "$IMAGE_URL"

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
  const titleOk = title ? (
    fillByContext("input,textarea,[contenteditable=true]", titleRe, title)
  ) : false;
  const fallbackEditable = Array.from(document.querySelectorAll("[contenteditable=true]")).filter(visible).sort((a, b) => contextText(b).length - contextText(a).length)[0];
  const descOk =
    fillByContext("textarea,[contenteditable=true]", descRe, description) ||
    (fallbackEditable ? setEditable(fallbackEditable, description) : false);
  const priceOk = price ? fillByContext("input", priceRe, price) : false;
  return JSON.stringify({ ok: true, titleOk, descOk, priceOk, titleChars: title.length, descriptionChars: description.length, price });
})()`;
fs.writeFileSync(outFile, js);
' "$DRAFT_FILE" "$FILL_JS"

if [[ -n "$IMAGE_PATH" ]]; then
  node -e '
const fs = require("fs");
const [imagePath, outFile] = process.argv.slice(1);
const b64 = fs.readFileSync(imagePath, "base64");
const name = require("path").basename(imagePath);
const js = `(() => {
  const b64 = ${JSON.stringify(b64)};
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], ${JSON.stringify(name)}, { type: "image/webp" });
  const input = document.querySelector("input[type=file]");
  if (!input) return JSON.stringify({ ok: false, error: "no-file-input" });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return JSON.stringify({ ok: true, files: input.files.length, name: input.files[0]?.name, size: input.files[0]?.size });
})()`;
fs.writeFileSync(outFile, js);
' "$IMAGE_PATH" "$UPLOAD_JS"

  osascript \
    -e "set jsCode to read POSIX file \"$(pwd)/$UPLOAD_JS\"" \
    -e 'using terms from application "Google Chrome"' \
    -e 'tell application "Google Chrome" to tell active tab of front window to execute javascript jsCode' \
    -e 'end using terms from'
  sleep 4
fi

osascript \
  -e "set jsCode to read POSIX file \"$(pwd)/$FILL_JS\"" \
  -e 'using terms from application "Google Chrome"' \
  -e 'tell application "Google Chrome" to tell active tab of front window to execute javascript jsCode' \
  -e 'end using terms from'
sleep 1

PUBLISH_RESULT="$(run_chrome_js '(() => { const publishText = "\u53d1\u5e03"; const btn = Array.from(document.querySelectorAll("button,[role=button],div,span")).find(el => (el.innerText||"").trim() === publishText && String(el.className||"").includes("publish-button")) || Array.from(document.querySelectorAll("button,[role=button],div,span")).find(el => (el.innerText||"").trim() === publishText); if (!btn) return "NO_BUTTON"; btn.click(); return "CLICKED"; })()')"
echo "PUBLISH_CLICK: $PUBLISH_RESULT"
sleep 3
echo "FINAL_URL: $(run_chrome_js 'location.href')"
echo "APPLE_EVENTS_PIPELINE_DONE: account=$ACCOUNT source=$FINAL_URL draft=$DRAFT_FILE"
