function buildEmojiSequenceRegex() {
  try {
    return new RegExp(
      String.raw`(?:\p{Regional_Indicator}+|[#*0-9]\uFE0F?\u20E3|(?:\u{1F3F4}(?:[\u{E0061}-\u{E007A}]{2,})\u{E007F})|(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?))*))`,
      'gu'
    );
  } catch {
    return /(?:[\u{1F1E6}-\u{1F1FF}]+|[#*0-9]\uFE0F?\u20E3|[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}])/gu;
  }
}

function buildEmojiCleanupRegex() {
  try {
    return new RegExp(String.raw`[\u200D\uFE0E\uFE0F\u20E3]|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]`, 'gu');
  } catch {
    return /[\u200D\uFE0E\uFE0F\u20E3\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
  }
}

const EMOJI_SEQUENCE_RE = buildEmojiSequenceRegex();
const EMOJI_CLEANUP_RE = buildEmojiCleanupRegex();

function stripBracketEmojiTokens(text) {
  return String(text || '').replace(/\[[^\]]{1,12}\]/g, '');
}

function normalizeWhitespacePreservingBreaks(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeGoofishText(text, options = {}) {
  const { stripBracketTokens = false } = options;
  let out = String(text || '');

  if (stripBracketTokens) {
    out = stripBracketEmojiTokens(out);
  }

  out = out.replace(EMOJI_SEQUENCE_RE, '');
  out = out.replace(EMOJI_CLEANUP_RE, '');

  return normalizeWhitespacePreservingBreaks(out);
}

module.exports = {
  sanitizeGoofishText,
  stripBracketEmojiTokens,
};
