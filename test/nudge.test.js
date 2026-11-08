import { describe, test } from "node:test";
import assert from "node:assert";
import { nudgeProblems, nudgeText } from "../src/nudge.js";

const IMG = [{ mimetype: "image/jpeg", id: "F1", url_private: "https://example.com/img.jpg" }];
const RULES = "https://example.com/rules";

const SENTENCES = {
  title: "It's missing a short line describing the item",
  location: "It's missing a location tag like [US]",
  price: "It's missing a price",
  photo: "It's missing a photo. Sale and trade posts need exactly *one* photo showing the item plus a handwritten note with your Slack name and the date of the post.",
  photos: "It has more than one photo. Extra photos must go in a thread reply only.",
  wtb_photo: "WTB/ISO posts can't include images. Photos are for sale listings only.",
  no_tag: "It has no leading tag (FS, FT, WTS, WTT, WTB, or ISO).",
};

const bulletsOf = (out) => out.split("\n").filter((line) => line.startsWith("- "));
const greetingOf = (out) => out.slice(0, out.indexOf("\n- "));

describe("nudgeProblems untagged posts", () => {
  test("image-only post with no text has no leading tag", () => {
    assert.deepStrictEqual(nudgeProblems({ files: IMG }), ["no_tag"]);
  });

  test("selling my watch has no leading tag", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "selling my watch" }), ["no_tag"]);
  });

  test("looking for a dress has no leading tag", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "looking for a dress" }), ["no_tag"]);
  });

  test("chatter gets no nudge", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "nice weather today" }), []);
  });

  test("a non-string text next to an image still counts the image", () => {
    assert.deepStrictEqual(
      nudgeProblems({ text: 5, files: [{ mimetype: "image/png" }] }),
      ["no_tag"],
    );
  });
});

describe("nudgeProblems whole words", () => {
  for (const text of ["upselling my watch", "for sales today", "forsale watch"]) {
    test(`${text} does not match`, () => {
      assert.deepStrictEqual(nudgeProblems({ text }), []);
    });
  }

  for (const text of ["Selling, my watch", "LOOKING FOR a dress", "watch For Sale"]) {
    test(`${text} matches`, () => {
      assert.deepStrictEqual(nudgeProblems({ text }), ["no_tag"]);
    });
  }
});

describe("nudgeProblems compliant posts", () => {
  const cases = [
    ["FS [US] Widget $10", IMG],
    ["WTB [US] Widget", undefined],
  ];
  for (const [text, files] of cases) {
    test(`${text} gets no nudge`, () => {
      assert.deepStrictEqual(nudgeProblems({ text, files }), []);
    });
  }
});

describe("nudgeProblems missing pieces", () => {
  test("FS $10 with an image lacks title and location", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "FS $10", files: IMG }), ["title", "location"]);
  });

  test("FS [US] with an image lacks title and price", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "FS [US]", files: IMG }), ["title", "price"]);
  });

  test("FS [US] $10 without files lacks title and photo", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "FS [US] $10" }), ["title", "photo"]);
  });

  test("bare FS lacks title, location, price and photo", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "FS" }), ["title", "location", "price", "photo"]);
  });

  test("WTB [US] with an image lacks title and may not have images", () => {
    assert.deepStrictEqual(nudgeProblems({ text: "WTB [US]", files: IMG }), ["title", "wtb_photo"]);
  });

  test("two images on a sale post give the photos code", () => {
    const twoImg = [IMG[0], { ...IMG[0], id: "F2" }];
    assert.deepStrictEqual(nudgeProblems({ text: "FS [US] Widget $10", files: twoImg }), ["photos"]);
  });
});

describe("nudgeProblems odd input", () => {
  const odd = [null, undefined, 5, "x", [], {}, { text: 5 }, { files: "x" }];
  for (const message of odd) {
    test(`${JSON.stringify(message)} gives no problems and does not throw`, () => {
      assert.deepStrictEqual(nudgeProblems(message), []);
    });
  }
});

describe("nudgeText", () => {
  test("with a URL the greeting links the word rules", () => {
    const out = nudgeText(["price"], RULES);
    assert.ok(greetingOf(out).includes(`[rules](${RULES})`));
    assert.match(greetingOf(out), /listing/i);
    assert.deepStrictEqual(bulletsOf(out), [`- ${SENTENCES.price}`]);
  });

  test("without a URL the greeting leaves the word rules unlinked", () => {
    for (const url of [null, undefined, ""]) {
      const greeting = greetingOf(nudgeText(["no_tag"], url));
      assert.ok(greeting.includes("rules"));
      assert.ok(!greeting.includes("]("), `link in: ${greeting}`);
      assert.ok(!greeting.includes("http"), `URL in: ${greeting}`);
    }
  });

  test("every code maps to its exact sentence, in plain text", () => {
    for (const [code, sentence] of Object.entries(SENTENCES)) {
      const out = nudgeText([code], RULES);
      assert.deepStrictEqual(bulletsOf(out), [`- ${sentence}`]);
      assert.doesNotMatch(out, /\p{Extended_Pictographic}/u);
      assert.doesNotMatch(out, /dashboard/i);
    }
  });

  test("each problem gets its own bullet line", () => {
    const out = nudgeText(["photo", "title", "price"], RULES);
    assert.deepStrictEqual(
      bulletsOf(out).sort(),
      [SENTENCES.photo, SENTENCES.title, SENTENCES.price].map((s) => `- ${s}`).sort(),
    );
  });
});

describe("nudgeText never echoes the message", () => {
  test("mentions, links and the title stay out of the reply", () => {
    const message = { text: "FS <@U123> <!channel> [x](https://evil.example) Widget $10" };
    const problems = nudgeProblems(message);
    assert.ok(problems.includes("photo"));
    const out = nudgeText(problems, RULES);
    for (const banned of ["<@U123>", "<!channel>", "[x](https://evil.example)", "evil.example", "Widget", "$10"]) {
      assert.ok(!out.includes(banned), `reply contains ${banned}`);
    }
    const allowed = new Set(Object.values(SENTENCES).map((s) => `- ${s}`));
    for (const bullet of bulletsOf(out)) {
      assert.ok(allowed.has(bullet), `unexpected bullet: ${bullet}`);
    }
  });
});

describe("nudgeProblems runs in linear time", () => {
  const inputs = {
    "for sal": "for sal".repeat(100_000 / 7),
    "looking fo ": "looking fo ".repeat(100_000 / 11),
  };
  for (const [name, text] of Object.entries(inputs)) {
    test(`near misses of ${name} answer quickly`, () => {
      const start = performance.now();
      assert.deepStrictEqual(nudgeProblems({ text }), []);
      assert.ok(performance.now() - start < 200);
    });
  }
});
