#!/bin/zsh
# BSK (browser-skill) publish pipeline for Goofish.
# Single-command equivalent of the manual BSK flow:
#   extract -> download -> beautify -> navigate /publish -> fill -> upload -> publish
#
# Usage:
#   scripts/publish_with_bsk.sh [--account <name>] [--dry-run] <goofish-url-or-short-url>
#
# Requires:
#   - `bsk` CLI installed and a Chrome window running with the BrowserSkill extension
#   - BrowserSkill extension granted file access (chrome://extensions -> 允许访问文件 URL)
#   - The current Chrome window already logged into Goofish
set -euo pipefail

ACCOUNT="default"
URL=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --account) ACCOUNT="${2:-default}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) if [[ -z "$URL" ]]; then URL="$1"; fi; shift ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "Missing Goofish URL." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
WORK_DIR="outputs/bsk-pipeline-$STAMP"
mkdir -p "$WORK_DIR"

echo ">> [1/7] start bsk session"
SESSION_FILE="outputs/.bsk-session-id"
mkdir -p outputs
SESSION_ID=""
REUSED=0

parse_session_id() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).session_id)}catch(e){process.exit(1)}})'
}

# Try to reuse an existing session: alive if a lightweight evaluate succeeds.
if [[ -f "$SESSION_FILE" ]]; then
  CAND="$(cat "$SESSION_FILE" 2>/dev/null || true)"
  if [[ -n "$CAND" ]] && bsk evaluate '1' --session "$CAND" >/dev/null 2>&1; then
    SESSION_ID="$CAND"
    REUSED=1
    echo "   reusing session=$SESSION_ID"
  else
    rm -f "$SESSION_FILE"
  fi
fi

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="$(bsk session start --json | parse_session_id)"
  if [[ -z "$SESSION_ID" ]]; then
    echo "Failed to parse session_id" >&2
    exit 1
  fi
  echo "$SESSION_ID" > "$SESSION_FILE"
  echo "   session=$SESSION_ID (new)"
fi

cleanup() {
  # Keep the session alive for reuse; only stop it if this run created it
  # and the pipeline failed before completion (Set by FINISHED flag).
  if [[ "${FINISHED:-0}" != "1" && "$REUSED" == "0" ]]; then
    bsk session stop "$SESSION_ID" >/dev/null 2>&1 || true
    rm -f "$SESSION_FILE"
  fi
}
trap cleanup EXIT

echo ">> [2/7] navigate to source item"
bsk navigate "$URL" --session "$SESSION_ID" >/dev/null

# Give the page a beat to settle (short-url redirects + SPA render).
sleep 3

echo ">> [3/7] extract item metadata"
EXTRACTED_JSON="$WORK_DIR/extracted.json"
bsk evaluate 'JSON.stringify((()=>{
  const cleanText=(t)=>String(t||"").replace(/\r\n?/g,"\n").split("\n").map(l=>l.replace(/[^\S\n]{2,}/g," ").trim()).join("\n").replace(/\n{3,}/g,"\n\n").trim();
  const desc=(document.querySelector("[class*=\"desc--\"]")?.innerText)||"";
  const allImgs=Array.from(document.querySelectorAll("[class*=item-main-window] img, [class*=carousel] img"))
    .map(i=>(i.currentSrc||i.src||"").replace(/_\d+x\d+Q\d+\.jpg_\.webp$|_Q\d+\.jpg_\.webp$/,""))
    .filter(u=>/\/bao\/uploaded\//.test(u));
  return {
    title: document.title.replace(/[_\-\s]*闲鱼\s*$/u,""),
    url: location.href,
    price: (document.body.innerText.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/)||[])[1] || null,
    desc: cleanText(desc),
    imgs: Array.from(new Set(allImgs)).slice(0,15)
  };
})())' --session "$SESSION_ID" > "$EXTRACTED_JSON"

TITLE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$EXTRACTED_JSON','utf8')).title||'')")"
PRICE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$EXTRACTED_JSON','utf8')).price||'')")"
DESC="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$EXTRACTED_JSON','utf8')).desc||'')")"
IMGS_COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$EXTRACTED_JSON','utf8')).imgs.length)")"
echo "   title=$TITLE"
echo "   price=$PRICE images=$IMGS_COUNT descChars=${#DESC}"

if [[ -z "$TITLE" || "$IMGS_COUNT" == "0" ]]; then
  echo "Extraction incomplete (title or images missing). Aborting." >&2
  exit 1
fi

echo ">> [4/7] download + beautify images"
node - "$EXTRACTED_JSON" "$WORK_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { cropWhitespaceAndAddBorder } = require(path.join(process.cwd(), "scripts/lib/image_processing"));

(async () => {
  const [extractedPath, workDir] = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(extractedPath, "utf8"));
  const urls = data.imgs || [];
  const procDir = path.join(workDir, "processed-images");
  fs.mkdirSync(procDir, { recursive: true });
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const src = path.join(workDir, `image-${i}.jpg`);
    const dst = path.join(procDir, `image-${i}.jpg`);
    try {
      execFileSync("curl", ["-sL", "-o", src, urls[i]], { stdio: "pipe" });
      const buf = fs.readFileSync(src);
      const { jpgBuf } = await cropWhitespaceAndAddBorder(buf, {
        border: 40,
        jpgQuality: 92,
        seed: `${urls[i]}:image-${i}`,
      });
      fs.writeFileSync(dst, jpgBuf);
      out.push(path.resolve(dst));
    } catch (e) {
      console.error(`   WARN image-${i}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(workDir, "image-paths.txt"), out.join("\n"));
  console.log(`   processed=${out.length}`);
})();
NODE

# Compute final price = original * 0.98, rounded to 2dp
FINAL_PRICE="$(node -e "const p=parseFloat('$PRICE');if(!isFinite(p)||p<=0){console.log('');}else{console.log((Math.floor(p*0.98*100)/100).toFixed(2))}")"
if [[ -z "$FINAL_PRICE" ]]; then
  echo "Could not compute final price from '$PRICE'" >&2
  exit 1
fi
echo "   finalPrice=$FINAL_PRICE"

echo ">> [5/7] navigate to /publish"
bsk navigate "https://www.goofish.com/publish" --session "$SESSION_ID" >/dev/null
sleep 3

# Observe to mint refs
OBSERVE_OUT="$(bsk observe --session "$SESSION_ID")"
DESC_REF="$(echo "$OBSERVE_OUT" | grep -E 'textbox "描述一下宝贝' | head -1 | sed -E 's/.*(@e[0-9]+).*/\1/')"
PRICE_REF="$(echo "$OBSERVE_OUT" | grep -E 'textbox "0.00"' | head -1 | sed -E 's/.*(@e[0-9]+).*/\1/')"
ADD_IMG_REF="$(echo "$OBSERVE_OUT" | grep -E 'button "添加首图"' | head -1 | sed -E 's/.*(@e[0-9]+).*/\1/')"
PUBLISH_REF="$(echo "$OBSERVE_OUT" | grep -E '^\s+@e[0-9]+ button "发布"$' | head -1 | sed -E 's/.*(@e[0-9]+).*/\1/')"

if [[ -z "$DESC_REF" || -z "$PRICE_REF" || -z "$ADD_IMG_REF" ]]; then
  echo "Failed to resolve refs (desc=$DESC_REF price=$PRICE_REF addImg=$ADD_IMG_REF)" >&2
  echo "$OBSERVE_OUT" | head -40 >&2
  exit 1
fi
echo "   refs: desc=$DESC_REF price=$PRICE_REF addImg=$ADD_IMG_REF publish=$PUBLISH_REF"

echo ">> [6/7] fill description + price"
bsk fill "$DESC_REF" --value "$DESC" --session "$SESSION_ID" >/dev/null || echo "   (desc fill reported unconfirmed, continuing)"
bsk fill "$PRICE_REF" --value "$FINAL_PRICE" --session "$SESSION_ID" >/dev/null || echo "   (price fill reported unconfirmed, continuing)"

# Upload images
IMG_ARGS=()
while IFS= read -r p || [[ -n "$p" ]]; do
  [[ -z "$p" ]] && continue
  IMG_ARGS+=(--file "$p")
done < "$WORK_DIR/image-paths.txt"

if [[ ${#IMG_ARGS[@]} -eq 0 ]]; then
  echo "No images staged; aborting before publish." >&2
  exit 1
fi
echo ">> [7/7] upload ${#IMG_ARGS[@]}/2 images + publish"
bsk upload "$ADD_IMG_REF" "${IMG_ARGS[@]}" --session "$SESSION_ID" >/dev/null

# Wait for upload previews to render.
sleep 5

UPLOAD_CHECK="$(bsk evaluate 'JSON.stringify({
  cards: document.querySelectorAll("[role=button][aria-roledescription=sortable]").length,
  cat: (document.querySelector(".ant-select-selection-item")?.innerText)||"",
  appOnly: /网页版暂不支持发布此分类|请使用闲鱼APP扫码/.test(document.body.innerText||""),
  price: document.querySelector("input[placeholder=\"0.00\"]")?.value||""
})' --session "$SESSION_ID")"
echo "   state: $UPLOAD_CHECK"

APponly="$(echo "$UPLOAD_CHECK" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{console.log(JSON.parse(s).appOnly?"1":"0")})')"
if [[ "$APponly" == "1" ]]; then
  echo "Category is APP-only on web; cannot publish from here." >&2
  exit 1
fi

# Re-resolve publish ref (page may have re-rendered)
OBSERVE2="$(bsk observe --session "$SESSION_ID")"
PUBLISH_REF2="$(echo "$OBSERVE2" | grep -E '^\s+@e[0-9]+ button "发布"$' | head -1 | sed -E 's/.*(@e[0-9]+).*/\1/')"
PUBLISH_REF="${PUBLISH_REF2:-$PUBLISH_REF}"
if [[ -z "$PUBLISH_REF" ]]; then
  echo "Publish button not found" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN: skipping final publish click (would click $PUBLISH_REF)"
  FINISHED=1
  exit 0
fi

bsk click "$PUBLISH_REF" --session "$SESSION_ID" >/dev/null
sleep 4

FINAL_URL="$(bsk evaluate 'location.href' --session "$SESSION_ID" | tr -d '"')"
echo "FINAL_URL: $FINAL_URL"

if [[ "$FINAL_URL" =~ /item\?id=([0-9]+) ]]; then
  FINISHED=1
  echo "BSK_PIPELINE_DONE: account=$ACCOUNT itemId=${BASH_REMATCH[1]} url=$FINAL_URL work=$WORK_DIR"
else
  echo "BSK_PIPELINE_UNCERTAIN: url did not match item page; check browser tab." >&2
  exit 1
fi
