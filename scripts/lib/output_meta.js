// Lightweight output meta helper shared by offline scripts.
// Keep this CommonJS so existing scripts can require() it.

function nowIso() {
  return new Date().toISOString();
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Build a stable meta block that can be added to output JSON.
 *
 * Design goals:
 * - Non-breaking: adding `meta` should not change existing `items` shape.
 * - Traceable: include tool/script timestamps and echoed inputs.
 * - Small: no PII, no cookies, no full environment dumps.
 */
function buildMeta({
  schemaVersion = 'goofish-lister.output.v1',
  tool = 'goofish-lister',
  script,
  inputs,
  counts,
} = {}) {
  return {
    schemaVersion,
    tool,
    script,
    generatedAt: nowIso(),
    inputs: pickDefined(inputs),
    counts: pickDefined(counts),
  };
}

module.exports = {
  buildMeta,
};
