const WINDOW_WORDS = 6;

const SALE_TAGS = new Set(["FS", "WTS"]);
const TRADE_TAGS = new Set(["FT", "WTT"]);
const WANT_TAGS = new Set(["WTB", "ISO"]);

const CURRENCY_SYMBOLS = new Set(["$", "€", "£"]);
const CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "SGD", "HKD",
]);

function isWordChar(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

// Single left-to-right pass: every character is visited at most once.
function tokenizeWindow(text, maxWords) {
  const words = [];
  let i = 0;

  while (i < text.length && words.length < maxWords) {
    const ch = text[i];

    if (ch === "[" || ch === "(") {
      const close = ch === "[" ? "]" : ")";
      let j = i + 1;
      while (j < text.length && text[j] !== close) j++;
      const closed = j < text.length;
      if (closed) j++;
      words.push({ word: text.slice(i, j), start: i, end: j, group: closed });
      i = j;
      continue;
    }

    if (isWordChar(text.charCodeAt(i))) {
      let j = i + 1;
      while (j < text.length && isWordChar(text.charCodeAt(j))) j++;
      words.push({ word: text.slice(i, j), start: i, end: j, group: false });
      i = j;
      continue;
    }

    i++;
  }

  return words;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function isRunChar(code) {
  return isDigit(code) || code === 44 || code === 46;
}

// Slack delivers strikeout as single tildes. Spans are found by index stepping,
// left to right, without overlap; `end` is exclusive.
function findStrikeSpans(text) {
  const spans = [];
  let i = text.indexOf("~");
  while (i !== -1) {
    const close = text.indexOf("~", i + 1);
    if (close === -1) break;
    if (close === i + 1) {
      i = close;
      continue;
    }
    spans.push({ start: i, end: close + 1 });
    i = text.indexOf("~", close + 1);
  }
  return spans;
}

function codeAt(text, index) {
  return CURRENCY_CODES.has(text.slice(index, index + 3).toUpperCase());
}

function runEnd(text, from) {
  let e = from;
  while (e < text.length && isRunChar(text.charCodeAt(e))) e++;
  return e;
}

// One left-to-right pass: returns the start index of every price token, in order.
function priceTokenStarts(text) {
  const starts = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (CURRENCY_SYMBOLS.has(ch)) {
      let d = i + 1;
      if (d < text.length && /\s/.test(text[d])) d++;
      if (d < text.length && isDigit(text.charCodeAt(d))) {
        starts.push(i);
        i = runEnd(text, d);
        continue;
      }
    } else if (isDigit(text.charCodeAt(i))) {
      const e = runEnd(text, i);
      if (codeAt(text, e) || (e < text.length && /\s/.test(text[e]) && codeAt(text, e + 1))) {
        starts.push(i);
      }
      i = e;
      continue;
    }

    i++;
  }

  return starts;
}

// Struck tokens are skipped by walking spans and tokens together, both in order.
function scanPrice(text) {
  const spans = findStrikeSpans(text);
  const starts = priceTokenStarts(text);

  let hasPrice = false;
  let k = 0;
  for (const start of starts) {
    while (k < spans.length && spans[k].end <= start) k++;
    if (!(k < spans.length && spans[k].start <= start)) hasPrice = true;
  }

  return {
    hasPrice,
    titleEnd: Math.min(starts[0] ?? text.length, spans[0]?.start ?? text.length),
  };
}

const SEPARATORS = new Set(["—", "-", ",", ":", "/"]);

function isSeparator(ch) {
  return SEPARATORS.has(ch) || /\s/.test(ch);
}

// Index loops from both ends keep this linear on long separator runs.
function trimSeparators(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isSeparator(text[start])) start++;
  while (end > start && isSeparator(text[end - 1])) end--;
  return text.slice(start, end);
}

// Markers wholly inside [0, regionEnd) are cut out; the pieces between are joined.
function deriveTitle(text, regionEnd, markers) {
  let title = "";
  let pos = 0;
  for (const m of markers) {
    if (m.end > regionEnd) continue;
    title += text.slice(pos, m.start);
    pos = m.end;
  }
  title += text.slice(pos, regionEnd);
  return trimSeparators(title.replace(/ {2,}/g, " "));
}

function canonicalType(tags) {
  if (tags.some((t) => SALE_TAGS.has(t))) return "sale";
  if (tags.some((t) => TRADE_TAGS.has(t))) return "trade";
  return "want";
}

function isImage(file) {
  return (
    file !== null &&
    typeof file === "object" &&
    typeof file.mimetype === "string" &&
    file.mimetype.startsWith("image/")
  );
}

export function countImages(files) {
  return Array.isArray(files) ? files.filter(isImage).length : 0;
}

export function hasImage(files) {
  return countImages(files) > 0;
}

export function missingFields(parsed, imageCount) {
  const missing = [];

  if (!parsed.title) missing.push("title");
  if (parsed.location === null) missing.push("location");

  if (parsed.type === "want") {
    if (imageCount > 0) missing.push("wtb_photo");
  } else {
    if (!parsed.hasPrice) missing.push("price");
    if (imageCount === 0) missing.push("photo");
    else if (imageCount > 1) missing.push("photos");
  }

  return missing;
}

export function parsePost(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const text = message.text;
  if (typeof text !== "string" || text === "") return null;

  const window = tokenizeWindow(text, WINDOW_WORDS);

  const tags = [];
  const markers = [];
  for (const w of window) {
    if (w.group) continue;
    const upper = w.word.toUpperCase();
    if (SALE_TAGS.has(upper) || TRADE_TAGS.has(upper) || WANT_TAGS.has(upper)) {
      tags.push(upper);
      markers.push(w);
    }
  }
  if (tags.length === 0) return null;

  const locationWord = window.find((w) => w.group && w.end - w.start > 2);
  const location = locationWord
    ? locationWord.word.slice(1, -1)
    : null;
  if (locationWord) {
    markers.push(locationWord);
    markers.sort((a, b) => a.start - b.start);
  }

  const price = scanPrice(text);

  const type = canonicalType(tags);
  const title = deriveTitle(text, price.titleEnd, markers);
  const hasPrice = price.hasPrice;

  return {
    type,
    title,
    location,
    hasPrice,
    missing: missingFields(
      { type, title, location, hasPrice },
      countImages(message.files),
    ),
  };
}
