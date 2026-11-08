import { describe, test } from "node:test";
import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { parsePost } from "../src/parse.js";
import { int, mulberry32, pick, randomText } from "./helpers/random.js";

const BIG = 100_000;
const MAX_MS = 200;

function parsesQuickly(text) {
  const start = performance.now();
  assert.doesNotThrow(() => parsePost({ text }));
  const elapsed = performance.now() - start;
  assert.ok(elapsed < MAX_MS, `took ${elapsed.toFixed(1)} ms for ${text.length} chars`);
}

function isDeterministic(text, files) {
  assert.deepStrictEqual(parsePost({ text, files }), parsePost({ text, files }));
}

const FRAGMENTS = [
  "FS", "FT", "WTS", "WTT", "WTB", "ISO", "fs", "[", "]", "(", ")", "~", "$", "€",
  "£", ",", ".", "-", "—", ":", "/", "0", "1", "9", "USD", "eur", "a", "Z", "é",
  " ", "\n", "\t",
];

describe("parsePost robustness", () => {
  test("odd input returns null without throwing", () => {
    for (const m of [undefined, null, 5, "FS x", ["FS x"]]) {
      assert.strictEqual(parsePost(m), null);
    }
    for (const text of [undefined, null, 5, {}, ["FS x"], ""]) {
      assert.strictEqual(parsePost({ text }), null);
    }
  });

  const ODD_FILES = {
    missing: undefined,
    null: null,
    number: 5,
    string: "image/png",
    object: { mimetype: "image/png" },
    "mixed odd entries": [
      null, 5, "image/png", {}, { mimetype: 5 }, { mimetype: null },
      { mimetype: "image/png" },
    ],
  };

  for (const [name, files] of Object.entries(ODD_FILES)) {
    test(`odd files value gives a missing list: ${name}`, () => {
      for (const text of ["FS [US] x $5", "WTB [US] x"]) {
        let r;
        assert.doesNotThrow(() => { r = parsePost({ text, files }); });
        assert.ok(Array.isArray(r.missing));
        isDeterministic(text, files);
      }
    });
  }

  const SEED = 20260107;
  const CASES = 1000;
  const NOT_TEXT = [undefined, null, 5, {}, ["FS x"]];
  const NOT_MESSAGES = [undefined, null, 0, 5, "FS x", ["FS x"], []];
  const FILE_ENTRIES = [
    null, 5, "image/png", {}, { mimetype: 5 }, { mimetype: null },
    { mimetype: "image/png" }, { mimetype: "text/plain" },
  ];
  const EXTRA_FIELDS = ["subtype", "user", "ts", "blocks", "bot_id", "channel"];

  function randomFiles(rand) {
    const kind = int(rand, 0, 6);
    if (kind === 0) return undefined;
    if (kind === 1) return null;
    if (kind === 2) return 5;
    if (kind === 3) return "image/png";
    if (kind === 4) return { mimetype: "image/png" };
    const files = [];
    for (let k = int(rand, 0, 5); k > 0; k--) files.push(pick(rand, FILE_ENTRIES));
    return files;
  }

  function randomMessage(rand) {
    if (int(rand, 0, 9) === 0) return pick(rand, NOT_MESSAGES);
    const text = int(rand, 0, 4) === 0
      ? pick(rand, NOT_TEXT)
      : randomText(rand, FRAGMENTS, 200);
    const message = { text, files: randomFiles(rand) };
    for (let k = int(rand, 0, 3); k > 0; k--) {
      message[pick(rand, EXTRA_FIELDS)] = pick(rand, [...NOT_TEXT, "x", true]);
    }
    return message;
  }

  test("seeded random messages never throw, are deterministic and have a known shape", () => {
    const rand = mulberry32(SEED);
    for (let n = 0; n < CASES; n++) {
      const message = randomMessage(rand);
      const where = `seed ${SEED} case ${n}: ${JSON.stringify(message)?.slice(0, 200)}`;
      let first;
      assert.doesNotThrow(() => { first = parsePost(message); }, where);
      assert.deepStrictEqual(parsePost(message), first, where);

      const plain = message !== null && typeof message === "object" && !Array.isArray(message);
      if (!plain || typeof message.text !== "string" || message.text === "") {
        assert.strictEqual(first, null, where);
      } else if (first !== null) {
        assert.ok(Array.isArray(first.missing), where);
      }
    }
  });

  test("seeded random 100,000-character texts parse in under 200 ms", () => {
    const rand = mulberry32(SEED + 1);
    const prefix = "FS [US] ";
    for (let n = 0; n < 8; n++) {
      const text = prefix + randomText(rand, FRAGMENTS, BIG - prefix.length, BIG - prefix.length);
      assert.strictEqual(text.length, BIG);
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        parsePost({ text });
        best = Math.min(best, performance.now() - start);
      }
      assert.ok(best < MAX_MS, `seed ${SEED + 1} case ${n}: best of 3 took ${best.toFixed(1)} ms`);
    }
  });

  test("lone surrogates, control characters and emoji never throw", () => {
    for (const text of [
      "FS \ud800 [US] Watch $5", "\udc00 FS", "FS\u0000[US]\u0000Watch\u0000$5",
      "FS \u{1F600} [\u{1F600}] Watch", "\ufeffFS Watch", "FS\r\n[US]\r\nWatch \r\n$5",
    ]) {
      assert.doesNotThrow(() => parsePost({ text }), JSON.stringify(text));
    }
  });

  test("a result is a fresh object and the message is left alone", () => {
    const a = parsePost({ text: "FS" });
    a.missing.push("junk");
    a.title = "changed";
    const b = parsePost({ text: "FS" });
    assert.deepStrictEqual(b.missing, ["title", "location", "price", "photo"]);
    assert.strictEqual(b.title, "");

    const message = Object.freeze({
      text: "FS [US] Watch $5",
      files: Object.freeze([Object.freeze({ mimetype: "image/png" })]),
    });
    assert.deepStrictEqual(parsePost(message).missing, []);
    assert.strictEqual(message.text, "FS [US] Watch $5");
  });

  test("repeated calls do not leak state between messages", () => {
    const files = [{ mimetype: "image/png" }];
    for (let n = 0; n < 6; n++) {
      assert.strictEqual(parsePost({ text: "FS [US] Watch $5", files }).hasPrice, true);
      assert.strictEqual(parsePost({ text: "FS [US] Watch", files }).hasPrice, false);
      assert.strictEqual(parsePost({ text: "hello" }), null);
    }
  });

  test("a 50,000-digit run decides the price by its currency", () => {
    const digits = "1".repeat(50_000);
    const priced = parsePost({ text: "FS [US] Watch $" + digits });
    assert.strictEqual(priced.hasPrice, true);
    assert.strictEqual(priced.title, "Watch");
    assert.strictEqual(parsePost({ text: "FS [US] Watch " + digits }).hasPrice, false);
  });

  const adversarial = {
    "open brackets": "FS " + "[".repeat(BIG - 3),
    "open parens": "FS " + "(".repeat(BIG - 3),
    "unclosed group followed by letters": "FS [" + "a".repeat(BIG - 4),
    "one huge word": "FS " + "a".repeat(BIG - 3),
    "punctuation only": "FS " + "!?.,;".repeat(BIG / 5).slice(0, BIG - 3),
    "many words": "FS " + "a ".repeat(BIG / 2).slice(0, BIG - 3),
    "huge word without a tag": "a".repeat(BIG),
    "punctuation without a tag": "!".repeat(BIG),
    "digits": "FS [US] " + "1".repeat(BIG - 8),
    "digit-comma pairs": "FS [US] " + "1,".repeat((BIG - 8) / 2),
    "dollar-digit pairs": "FS [US] " + "$1".repeat((BIG - 8) / 2),
    "digits ending in a currency code": "FS [US] " + "1".repeat(BIG - 12) + " USD",
    "dollar-space pairs": "FS [US] " + "$ ".repeat((BIG - 8) / 2),
    "tildes": "FS [US] " + "~".repeat(BIG - 8),
    "unclosed tilde then letters": "FS [US] ~" + "a".repeat(BIG - 9),
    "tilde-digit pairs": "FS [US] " + "~1".repeat((BIG - 8) / 2),
    "many struck prices": "FS [US] " + "~$1~ ".repeat((BIG - 8) / 5),
    "hyphen-space run after a tag": "FS " + "- ".repeat((BIG - 3) / 2),
    "em dash run": "FS x" + "—".repeat(BIG - 4),
    "space run": "FS " + " ".repeat(BIG - 3),
    "space-hyphen run ending in a price": "FS x" + " -".repeat((BIG - 7) / 2) + " $5",
    "digit-space pairs ending in a currency code": "FS [US] " + "1 ".repeat((BIG - 12) / 2) + "USD",
    "number-code pairs": "FS [US] " + "9 USD ".repeat((BIG - 8) / 6),
    "unclosed tilde before many prices": "FS [US] ~" + "$1 ".repeat((BIG - 9) / 3),
    "price-tilde pairs": "FS [US] " + "$1 ~".repeat((BIG - 8) / 4),
    "empty groups after a tag": "FS " + "[] ".repeat((BIG - 3) / 3),
    "many tags": "FS ".repeat(BIG / 3),
    "one huge location": "FS [" + "a".repeat(BIG - 5) + "]",
    "newline run": "FS" + "\n".repeat(BIG - 2),
    "lone surrogates": "FS " + "\ud800".repeat(BIG - 3),
    "tab-comma run ending in a letter": "FS x" + "\t,".repeat((BIG - 6) / 2) + " y",
  };

  for (const [name, text] of Object.entries(adversarial)) {
    test(`adversarial input stays fast and deterministic: ${name}`, () => {
      parsesQuickly(text);
      isDeterministic(text);
    });
  }
});
