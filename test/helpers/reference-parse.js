// Slow, obviously correct reference versions of the parser's rules, written
// from the posting rules alone. Inputs are short, so clarity beats speed.

const WINDOW_WORDS = 6;
const TAGS = new Set(["FS", "FT", "WTS", "WTT", "WTB", "ISO"]);
const SALE_TAGS = new Set(["FS", "WTS"]);
const TRADE_TAGS = new Set(["FT", "WTT"]);
const CODES = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "SGD", "HKD"]);

// The first six words of the text: a bracket or parenthesis group (to its
// closer, or to the end if unclosed) or a run of ASCII letters and digits.
function windowWords(text) {
  const words = text.match(/\[[^\]]*\]?|\([^)]*\)?|[A-Za-z0-9]+/g) ?? [];
  return words.slice(0, WINDOW_WORDS);
}

function isGroup(word) {
  return word.startsWith("[") || word.startsWith("(");
}

export function refWindow(text) {
  const words = windowWords(text);
  const tags = words.filter((w) => !isGroup(w) && TAGS.has(w.toUpperCase()));
  const upper = tags.map((t) => t.toUpperCase());
  let type = "want";
  if (upper.some((t) => SALE_TAGS.has(t))) type = "sale";
  else if (upper.some((t) => TRADE_TAGS.has(t))) type = "trade";

  let location = null;
  for (const w of words) {
    if (isGroup(w) && w.length > 2 && (w.endsWith("]") || w.endsWith(")"))) {
      location = w.slice(1, -1);
      break;
    }
  }
  return { listing: tags.length > 0, type, location };
}

function strikeSpans(text) {
  const spans = [];
  let i = text.indexOf("~");
  while (i !== -1) {
    const j = text.indexOf("~", i + 1);
    if (j === -1) break;
    if (j === i + 1) {
      i = j;
    } else {
      spans.push([i, j]);
      i = text.indexOf("~", j + 1);
    }
  }
  return spans;
}

const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";

function priceTokenAt(text, p) {
  const c = text[p];
  if ("$€£".includes(c)) {
    if (isDigit(text[p + 1])) return true;
    return /\s/.test(text[p + 1] ?? "") && isDigit(text[p + 2]);
  }
  if (!isDigit(c)) return false;
  let e = p + 1;
  while (e < text.length && (isDigit(text[e]) || text[e] === "," || text[e] === ".")) e++;
  if (CODES.has(text.slice(e, e + 3).toUpperCase())) return true;
  return (
    e < text.length &&
    /\s/.test(text[e]) &&
    CODES.has(text.slice(e + 1, e + 4).toUpperCase())
  );
}

// A price-shaped token that is not inside a strikeout span. Any single
// whitespace character is allowed between symbol or number and what follows
// it; two in a row do not count.
export function refHasPrice(text) {
  const spans = strikeSpans(text);
  for (let p = 0; p < text.length; p++) {
    if (!priceTokenAt(text, p)) continue;
    if (!spans.some(([from, to]) => p >= from && p <= to)) return true;
  }
  return false;
}

export function refCountImages(files) {
  if (!Array.isArray(files)) return 0;
  return files.filter(
    (f) => f !== null && typeof f === "object" && typeof f.mimetype === "string" && f.mimetype.startsWith("image/"),
  ).length;
}

export function refMissing({ type, title, location, hasPrice }, imageCount) {
  const missing = [];
  if (title === "") missing.push("title");
  if (location === null) missing.push("location");
  if (type === "sale" || type === "trade") {
    if (!hasPrice) missing.push("price");
    if (imageCount === 0) missing.push("photo");
    else if (imageCount > 1) missing.push("photos");
  } else if (imageCount > 0) {
    missing.push("wtb_photo");
  }
  return missing;
}
