import { describe, test } from "node:test";
import assert from "node:assert";
import { missingFields, parsePost } from "../src/parse.js";
import { int, mulberry32, pick, randomText } from "./helpers/random.js";
import {
  refCountImages,
  refHasPrice,
  refMissing,
  refWindow,
} from "./helpers/reference-parse.js";

const CASES = 2000;
const SEED = 20260117;

const FRAGMENTS = [
  "FS", "FT", "WTS", "WTT", "WTB", "ISO", "fs", "Wtb", "iso", "[", "]", "(", ")",
  "[]", "[US]", "a", "Widget", "é", "$", "€", "£", "0", "1", "5", "42", ",", ".",
  "USD", "usd", "Eur", "GBP", "CAD", "AUD", "CHF", "JPY", "SGD", "HKD", "USDT",
  "~", "~~", " ", " ", " ", "\t", " ", "\n", "-", "—", ":", "/",
];

// Five to eight filler words, then a tag, so the edge of the six-word window
// is crossed.
function textWithLateTag(rand) {
  const fillers = int(rand, 5, 8);
  const parts = [];
  for (let i = 0; i < fillers; i++) {
    parts.push(pick(rand, ["a", "Widget", "é", "x1", "[US]", "(Ohio)", "[]", "[open"]));
  }
  parts.push(pick(rand, ["FS", "wtb", "FT", "(ISO)", "ISO"]));
  parts.push(randomText(rand, FRAGMENTS, 10));
  return parts.join(pick(rand, [" ", " ", "-", "/"]));
}

function randomText80(rand) {
  return rand() < 0.2 ? textWithLateTag(rand) : randomText(rand, FRAGMENTS, 80);
}

function failure(seed, n, input) {
  return `seed ${seed}, case ${n}, input ${JSON.stringify(input)}`;
}

describe("parsePost against slow reference implementations", () => {
  test("the tag window decides listing, type and location", () => {
    const rand = mulberry32(SEED);
    let listings = 0;
    for (let n = 0; n < CASES; n++) {
      const text = randomText80(rand);
      const expected = refWindow(text);
      const actual = parsePost({ text });
      const where = failure(SEED, n, text);
      if (!expected.listing) {
        assert.strictEqual(actual, null, where);
        continue;
      }
      listings++;
      assert.ok(actual, where);
      assert.strictEqual(actual.type, expected.type, where);
      assert.strictEqual(actual.location, expected.location, where);
    }
    assert.ok(listings > 100 && listings < CASES - 100, `${listings} listings`);
  });

  test("a price is an unstruck price-shaped token", () => {
    const seed = SEED + 1;
    const rand = mulberry32(seed);
    let withPrice = 0;
    for (let n = 0; n < CASES; n++) {
      const s = randomText(rand, FRAGMENTS, 80);
      const expected = refHasPrice(s);
      const parsed = parsePost({ text: "FS [US] x " + s });
      assert.strictEqual(parsed.hasPrice, expected, failure(seed, n, s));
      if (expected) withPrice++;
    }
    // Enough cases with a price and enough without, so neither answer is trivial.
    assert.ok(withPrice > 100 && withPrice < CASES - 100, `${withPrice} with a price`);
  });

  test("missingFields matches the reference for any parsed shape", () => {
    const seed = SEED + 2;
    const rand = mulberry32(seed);
    for (let n = 0; n < CASES; n++) {
      const parsed = {
        type: pick(rand, ["sale", "trade", "want"]),
        title: pick(rand, ["", "Widget", " "]),
        location: pick(rand, [null, "US", "x"]),
        hasPrice: rand() < 0.5,
      };
      const count = int(rand, 0, 3);
      assert.deepStrictEqual(
        missingFields(parsed, count),
        refMissing(parsed, count),
        failure(seed, n, [parsed, count]),
      );
    }
  });

  test("parsePost reports the missing fields the reference expects", () => {
    const seed = SEED + 3;
    const rand = mulberry32(seed);
    const FILES = [
      null, undefined, 5, "x", {}, { mimetype: 5 }, { mimetype: "text/plain" },
      { mimetype: "image/png" }, { mimetype: "image/jpeg" }, { mimetype: "IMAGE/png" },
    ];
    for (let n = 0; n < CASES; n++) {
      const text = pick(rand, ["FS ", "WTB ", "FT [US] ", "iso (UK) "]) + randomText(rand, FRAGMENTS, 60);
      const files =
        rand() < 0.1
          ? pick(rand, [undefined, null, 3, "image/png", { length: 2 }])
          : Array.from({ length: int(rand, 0, 3) }, () => pick(rand, FILES));
      const parsed = parsePost({ text, files });
      if (parsed === null) continue;
      const { type, title, location, hasPrice } = parsed;
      assert.deepStrictEqual(
        parsed.missing,
        refMissing({ type, title, location, hasPrice }, refCountImages(files)),
        failure(seed, n, { text, files }),
      );
    }
  });
});
