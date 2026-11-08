import { describe, test } from "node:test";
import assert from "node:assert";
import { parsePost, countImages, hasImage } from "../src/parse.js";

const img = (id, mimetype = "image/png") => ({ mimetype, id });

const typeOf = (text) => parsePost({ text }).type;
const locationOf = (text) => parsePost({ text }).location;

describe("parsePost keyword detection", () => {
  test("FS is a sale", () => {
    assert.strictEqual(typeOf("FS [US] $10"), "sale");
  });

  test("WTS is a sale", () => {
    assert.strictEqual(typeOf("WTS [US] $10"), "sale");
  });

  test("FT is a trade", () => {
    assert.strictEqual(typeOf("FT [US] $10"), "trade");
  });

  test("WTB is a want", () => {
    assert.strictEqual(typeOf("WTB [US] $10"), "want");
  });

  test("ISO is a want", () => {
    assert.strictEqual(typeOf("ISO [US] $10"), "want");
  });

  test("FS/FT is a sale", () => {
    assert.strictEqual(typeOf("FS/FT [US] $10"), "sale");
  });

  test("WTS FT is a sale", () => {
    assert.strictEqual(typeOf("WTS FT [US] $10"), "sale");
  });

  test("case-insensitive: fs", () => {
    assert.strictEqual(typeOf("fs [US] widget $10"), "sale");
  });

  test("case-insensitive: Wts", () => {
    assert.strictEqual(typeOf("Wts [US] widget $10"), "sale");
  });

  test("case-insensitive: Iso", () => {
    assert.strictEqual(typeOf("Iso [US] widget $10"), "want");
  });

  test("mixed FS + WTB: sale wins", () => {
    assert.strictEqual(typeOf("FS WTB title [US] $10"), "sale");
  });

  test("tags in any order and position", () => {
    assert.strictEqual(typeOf("WTB FS widget"), "sale");
    assert.strictEqual(typeOf("hey FS [US] $10"), "sale");
  });

  test("text without a tag returns null", () => {
    assert.strictEqual(parsePost({ text: "hello world" }), null);
  });

  test("null text returns null", () => {
    assert.strictEqual(parsePost({ text: null }), null);
  });

  test("empty text returns null", () => {
    assert.strictEqual(parsePost({ text: "" }), null);
  });

  test("a bracketed tag is a group, not a tag", () => {
    assert.strictEqual(parsePost({ text: "[FS] widget" }), null);
  });

  test("WTT is a trade", () => {
    assert.strictEqual(typeOf("WTT [US] widget $10"), "trade");
  });

  test("FS/WTT is a sale", () => {
    assert.strictEqual(typeOf("FS/WTT [US] widget $10"), "sale");
  });

  test("WTS/WTT is a sale", () => {
    assert.strictEqual(typeOf("WTS/WTT [US] widget $10"), "sale");
  });

  test("WTT/WTB is a trade (trade before want)", () => {
    assert.strictEqual(typeOf("WTT/WTB [US] widget"), "trade");
  });

  test("FS: trailing colon tolerated", () => {
    assert.strictEqual(typeOf("FS: [US] widget $10"), "sale");
  });

  test("wtt: case-insensitive with colon", () => {
    assert.strictEqual(typeOf("wtt: [US] widget"), "trade");
  });

  test("FS[US-PA] glued bracket parses", () => {
    const r = parsePost({ text: "FS[US-PA] Rolex $500" });
    assert.strictEqual(r.type, "sale");
    assert.strictEqual(r.location, "US-PA");
  });

  test("FS:[US-NM] glued bracket with colon", () => {
    const r = parsePost({ text: "FS:[US-NM] widget $19.95" });
    assert.strictEqual(r.type, "sale");
    assert.strictEqual(r.location, "US-NM");
  });

  test("non-ASCII letters are not word characters", () => {
    assert.strictEqual(parsePost({ text: "éFS widget" }).type, "sale");
    assert.strictEqual(parsePost({ text: "FSé widget" }).type, "sale");
    assert.strictEqual(parsePost({ text: "é widget" }), null);
  });

  test("a tag must be a whole word", () => {
    for (const text of [
      "FSX watch", "XFS watch", "FS1 watch", "1FS watch", "FSFT watch",
      "ISOLATE watch", "WTSS watch", "FSz watch", "FSZ watch", "zFS watch",
    ]) {
      assert.strictEqual(parsePost({ text }), null, text);
    }
  });

  test("only ASCII letters and digits join a tag to its neighbours", () => {
    for (const text of ["FS9 watch", "9FS watch", "FS0 watch", "0FS watch"]) {
      assert.strictEqual(parsePost({ text }), null, text);
    }
    for (const c of ["/", ":", "@", "`", "{"]) {
      assert.strictEqual(typeOf(`${c}FS watch`), "sale", `${c}FS`);
      assert.strictEqual(typeOf(`FS${c} watch`), "sale", `FS${c}`);
    }
  });

  test("an underscore separates words", () => {
    assert.strictEqual(typeOf("FS_watch"), "sale");
  });

  test("the tag counts as the first through sixth word, not the seventh", () => {
    const filler = ["one", "two", "three", "four", "five"];
    for (let n = 0; n <= 5; n++) {
      const text = [...filler.slice(0, n), "FS"].join(" ");
      assert.strictEqual(typeOf(text), "sale", text);
    }
    assert.strictEqual(parsePost({ text: "one two three four five six FS" }), null);
  });

  test("digits are words of the window", () => {
    assert.strictEqual(typeOf("1 2 3 4 5 FS"), "sale");
    assert.strictEqual(parsePost({ text: "1 2 3 4 5 6 FS" }), null);
  });

  test("punctuation separates words and is not a word", () => {
    assert.strictEqual(typeOf("Hey!!! you... there --- guys, nice: FS"), "sale");
    assert.strictEqual(
      parsePost({ text: "Hey!!! you... there --- guys, nice: really FS" }),
      null,
    );
  });

  test("a group is one window word however long", () => {
    for (const [open, close] of [["[", "]"], ["(", ")"]]) {
      const group = `${open}a b c d e f g h i j${close}`;
      assert.strictEqual(typeOf(`${group} FS`), "sale");
      assert.strictEqual(typeOf(`${open}a b c${close} x y z w FS`), "sale");
      assert.strictEqual(parsePost({ text: `${open}a b c${close} x y z w v FS` }), null);
    }
  });

  test("an unclosed group swallows the tags after it", () => {
    assert.strictEqual(parsePost({ text: "[x FS" }), null);
    assert.strictEqual(parsePost({ text: "(x FS" }), null);
  });

  test("a group glued before a tag leaves the tag a word", () => {
    const r = parsePost({ text: "[US]FS Watch $5" });
    assert.strictEqual(r.type, "sale");
    assert.strictEqual(r.location, "US");
    assert.strictEqual(r.title, "Watch");
  });

  test("a sale tag in the seventh word does not make a want a sale", () => {
    assert.strictEqual(typeOf("WTB a b c d FS"), "sale");
    assert.strictEqual(typeOf("WTB a b c d e FS"), "want");
    assert.strictEqual(typeOf("FT a b c d e f WTS"), "trade");
  });
});

describe("parsePost location", () => {
  test("extracts [US-VA]", () => {
    assert.strictEqual(locationOf("FS [US-VA] Widget $10"), "US-VA");
  });

  test("no bracket gives null location", () => {
    assert.strictEqual(locationOf("FS Widget $10"), null);
  });

  test("only the first group is used", () => {
    assert.strictEqual(locationOf("FS [US] [EU] stuff $10"), "US");
  });

  test("extracts (US-VA) paren form", () => {
    assert.strictEqual(locationOf("FS (US-VA) Widget $10"), "US-VA");
  });

  test("empty paren group gives null location", () => {
    assert.strictEqual(locationOf("FS () widget $500"), null);
  });

  test("a bare token is not a location", () => {
    const r = parsePost({ text: "FS CONUS Rolex $500" });
    assert.strictEqual(r.location, null);
    assert.strictEqual(r.type, "sale");
  });

  test("first group wins: bracket before paren", () => {
    assert.strictEqual(locationOf("FS [US-CA] (SF) widget $10"), "US-CA");
  });

  test("first group wins: paren before bracket", () => {
    assert.strictEqual(locationOf("FS (US-CA) [SF] widget $10"), "US-CA");
  });

  test("contents are taken verbatim, so [ ] is a space", () => {
    assert.strictEqual(locationOf("FS [ ] x"), " ");
  });

  test("an empty group is skipped for a later one", () => {
    assert.strictEqual(locationOf("FS [] [US] x"), "US");
  });

  test("an unclosed group gives null", () => {
    assert.strictEqual(locationOf("FS [US-PA x"), null);
  });

  test("an unclosed [ swallows a following (US)", () => {
    assert.strictEqual(locationOf("FS [abc (US) def"), null);
  });

  test("a group that is word 6 counts", () => {
    assert.strictEqual(locationOf("FS a b c d [US]"), "US");
  });

  test("a group that is word 7 does not", () => {
    assert.strictEqual(locationOf("FS a b c d e [US]"), null);
  });

  test("a group holding several words counts as one window word", () => {
    const r = parsePost({ text: "[US East Coast] a b c d FS x" });
    assert.strictEqual(r.type, "sale");
    assert.strictEqual(r.location, "US East Coast");
  });

  test("an empty group takes up a window word", () => {
    assert.strictEqual(locationOf("FS [] a b c [US]"), "US");
    assert.strictEqual(locationOf("FS [] a b c d [US]"), null);
  });

  test("an unclosed group after an empty one gives null", () => {
    assert.strictEqual(locationOf("FS [] (x"), null);
  });

  test("a closed group before an unclosed one is the location", () => {
    assert.strictEqual(locationOf("FS [US] Watch (like new"), "US");
  });
});

describe("parsePost price", () => {
  const hasPrice = (text) => parsePost({ text }).hasPrice;

  test("a price after struck prices counts", () => {
    assert.strictEqual(hasPrice("FS [US] Gadget ~$1000~ ~$900~ $810 USD, shipped"), true);
  });

  test("euro and pound symbols", () => {
    assert.strictEqual(hasPrice("FS [DE] Widget €50 shipped"), true);
    assert.strictEqual(hasPrice("FS [UK] Widget £50 shipped"), true);
  });

  test("price with commas", () => {
    assert.strictEqual(hasPrice("FS [US] Widget $1,200"), true);
  });

  test("a price on a later line counts", () => {
    assert.strictEqual(hasPrice("FS [US] Widget\nExtra line with $99"), true);
    assert.strictEqual(hasPrice("FS [US] Widget\nNo price here\n99 USD"), true);
    assert.strictEqual(hasPrice("FS [US] Widget\nOld price\n~$120~"), false);
  });

  test("no price", () => {
    assert.strictEqual(hasPrice("FS [US] Widget"), false);
  });

  test("struck prices only", () => {
    assert.strictEqual(hasPrice("FS [US] Widget ~$1000~ ~$900~"), false);
  });

  test("currency code forms", () => {
    assert.strictEqual(hasPrice("FS [US] Widget 900 eur"), true);
    assert.strictEqual(hasPrice("FS [US] Widget 900USD"), true);
    assert.strictEqual(hasPrice("FS [US] Widget 900 USDT"), true);
  });

  test("every supported currency code counts, in either case", () => {
    for (const c of ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "SGD", "HKD"]) {
      assert.strictEqual(hasPrice("FS [US] Widget 50 " + c), true, c);
      assert.strictEqual(hasPrice("FS [US] Widget 50 " + c.toLowerCase()), true, c.toLowerCase());
    }
  });

  test("symbol forms", () => {
    assert.strictEqual(hasPrice("FS [US] Widget $ 50"), true);
    assert.strictEqual(hasPrice("FS [US] Widget $19.95"), true);
    assert.strictEqual(hasPrice("FS [US] Widget 12$5"), true);
    assert.strictEqual(hasPrice("FS [US] Widget ,5 USD"), true);
  });

  test("any single whitespace character is allowed in a price", () => {
    assert.strictEqual(hasPrice("FS [US] Widget $\t50"), true);
    assert.strictEqual(hasPrice("FS [US] Widget $\u00a050"), true);
    assert.strictEqual(hasPrice("FS [US] Widget 50\tUSD"), true);
    assert.strictEqual(hasPrice("FS [US] Widget 50\u00a0USD"), true);
  });

  test("a price at the very start of the text counts", () => {
    assert.strictEqual(hasPrice("$5 FS [US] Widget"), true);
    assert.strictEqual(hasPrice("5USD FS [US] Widget"), true);
  });

  test("an unclosed tilde opens no strikeout", () => {
    assert.strictEqual(hasPrice("FS [US] Widget ~$50"), true);
  });

  test("a struck code price does not count", () => {
    assert.strictEqual(hasPrice("FS [US] Widget ~900 EUR~"), false);
  });

  test("double tildes are not a strikeout", () => {
    assert.strictEqual(hasPrice("FS [US] Widget ~~$50~~"), false);
    assert.strictEqual(hasPrice("FS [US] Widget ~~$50"), true);
  });

  test("a price after a closed strikeout counts", () => {
    assert.strictEqual(hasPrice("FS [US] Widget ~old~ $50"), true);
  });

  test("not price tokens", () => {
    assert.strictEqual(hasPrice("FS [US] Widget $  50"), false);
    assert.strictEqual(hasPrice("FS [US] Widget 50  USD"), false);
    assert.strictEqual(hasPrice("FS [US] Widget USD 50"), false);
    assert.strictEqual(hasPrice("FS [US] Widget $.50"), false);
    assert.strictEqual(hasPrice("FS [US] Widget 500"), false);
    assert.strictEqual(hasPrice("FS [US] Widget $"), false);
    assert.strictEqual(hasPrice("FS [US] Widget 5"), false);
    assert.strictEqual(hasPrice("FS [US] Widget 5 "), false);
  });

  test("text around the number does not make a price", () => {
    for (const token of ["USD50", "50 dollars", "50 US", "50$", "5k USD", "50 bucks"]) {
      assert.strictEqual(hasPrice("FS [US] Widget " + token), false, token);
    }
  });
});

describe("parsePost title", () => {
  const titleOf = (text) => parsePost({ text }).title;

  const cases = [
    ["hey FS [US] $10", "hey"],
    ["FS[US-PA] Rolex $500", "Rolex"],
    ["FS[US-PA] WTB widget", "widget"],
    ["FS (US-NYC) Sinn U1-T S $2200", "Sinn U1-T S"],
    ["FS/FT [US-WA] Fortis B-42 (tags, paper) $1,500", "Fortis B-42 (tags, paper)"],
    ["FS (mint) Rolex $500", "Rolex"],
    ["FS [US-FL] Rolex GMT ~$2,000~ $1,800 USD (net)", "Rolex GMT"],
    ["FS:[US-NM] Seiko 5 ~$50~ NOW ONLY $19.95", "Seiko 5"],
    ["FS [US-VA] Fancy Widget $950 USD, shipped.", "Fancy Widget"],
    ["FS [US] Widget ~$100~ $90", "Widget"],
    ["FS Fancy Widget $10", "Fancy Widget"],
    ["FS [US] Fancy Widget", "Fancy Widget"],
    ["FS Fancy Widget", "Fancy Widget"],
    ["FS [US] $10", ""],
    ["FS [US] — $500", ""],
    ["FS [US] Fancy papers! — $2,000", "Fancy papers!"],
    ["FS [US] widget - $10", "widget"],
    ["FS [US] widget, $10", "widget"],
    ["FS [US] widget — , $10", "widget"],
    ["FS [US] B-42 Flieger $500", "B-42 Flieger"],
    ["FS [US] Watch $50", "Watch"],
    ["FS WATCH [US] Seiko $500", "WATCH Seiko"],
    ["[US] FS WATCH Seiko $500", "WATCH Seiko"],
    ["FS [US] [EU] stuff $10", "[EU] stuff"],
    ["FS () widget $500", "() widget"],
    ["FS [US] Widget ~old~ $90", "Widget"],
    ["FS [US $50] Widget", "[US"],
    ["FS [US] Widget\nSold via PM\nFinal price $99", "Widget\nSold via PM\nFinal price"],
    ["FS [US]   Big    Widget  $5", "Big Widget"],
    ["FS: / Widget / $5", "Widget"],
  ];

  for (const [text, title] of cases) {
    test(`${JSON.stringify(text)} gives ${JSON.stringify(title)}`, () => {
      assert.strictEqual(titleOf(text), title);
    });
  }

  test("the title stops at a currency-code price", () => {
    assert.strictEqual(titleOf("FS [US] Watch Case 50 USD obo"), "Watch Case");
  });

  test("characters off the separator list are not trimmed", () => {
    assert.strictEqual(titleOf("FS [US] – Watch $5"), "– Watch");
    assert.strictEqual(titleOf("FS [US] *Watch!* $5"), "*Watch!*");
    assert.strictEqual(titleOf("FS [US] . Watch $5"), ". Watch");
  });

  test("tags are removed in any case and longer words keep their letters", () => {
    assert.strictEqual(titleOf("fs/ft [US] Watch $5"), "Watch");
    assert.strictEqual(titleOf("FS ISO [US] Watch $5"), "Watch");
    assert.strictEqual(titleOf("FS [US] Fsomething $5"), "Fsomething");
    assert.strictEqual(titleOf("FS [US] Isolator $5"), "Isolator");
  });

  test("a newline between the location and the title is trimmed", () => {
    assert.strictEqual(titleOf("FS [US]\nWatch $5"), "Watch");
  });

  test("tabs and newlines are not collapsed", () => {
    assert.strictEqual(titleOf("FS [US] a\t\tb\n\nc $5"), "a\t\tb\n\nc");
  });
});

describe("parsePost full output shape", () => {
  test("all fields present on a complete message", () => {
    const r = parsePost({
      text: "FS/FT [US-NY] Cool Laptop ~$1200~ $900 USD\nLike new condition",
      files: [img("F005", "image/jpeg")],
    });
    assert.deepStrictEqual(r, {
      type: "sale",
      title: "Cool Laptop",
      location: "US-NY",
      hasPrice: true,
      missing: [],
    });
  });

  test("minimal listing: keyword only", () => {
    assert.deepStrictEqual(parsePost({ text: "WTB" }), {
      type: "want",
      title: "",
      location: null,
      hasPrice: false,
      missing: ["title", "location"],
    });
  });
});

describe("parsePost completeness", () => {
  const missingOf = (text, files) => parsePost({ text, files }).missing;

  test("complete FS with one photo has nothing missing", () => {
    assert.deepStrictEqual(missingOf("FS [US] Widget $10", [img("F1")]), []);
  });

  test("FS with no title reports title", () => {
    assert.deepStrictEqual(missingOf("FS [US] $10", [img("F1")]), ["title"]);
  });

  test("FS with no location reports location", () => {
    assert.deepStrictEqual(missingOf("FS Widget $10", [img("F1")]), ["location"]);
  });

  test("FS with no price reports price", () => {
    assert.deepStrictEqual(missingOf("FS [US] Widget", [img("F1")]), ["price"]);
  });

  test("FS with no image reports photo", () => {
    assert.deepStrictEqual(missingOf("FS [US] Widget $10"), ["photo"]);
  });

  test("FS with two images reports photos", () => {
    assert.deepStrictEqual(
      missingOf("FS [US] Widget $10", [img("F1"), img("F2", "image/jpeg")]),
      ["photos"],
    );
  });

  test("FT has the same requirements as a sale", () => {
    assert.deepStrictEqual(missingOf("FT [US] Widget $10"), ["photo"]);
  });

  test("FS/FT with no price and no photo reports both", () => {
    assert.deepStrictEqual(missingOf("FS/FT [US] Widget"), ["price", "photo"]);
  });

  test("complete WTB has nothing missing", () => {
    assert.deepStrictEqual(missingOf("WTB [US] Widget"), []);
  });

  test("WTB with an image reports wtb_photo", () => {
    assert.deepStrictEqual(missingOf("WTB [US] Widget", [img("F1")]), ["wtb_photo"]);
  });

  test("WTB with two images still reports one wtb_photo", () => {
    assert.deepStrictEqual(missingOf("WTB [US] Widget", [img("F1"), img("F2")]), ["wtb_photo"]);
  });

  test("multiple missing fields come in a fixed order", () => {
    assert.deepStrictEqual(missingOf("FS"), ["title", "location", "price", "photo"]);
  });
});

describe("countImages", () => {
  test("an empty array counts zero", () => {
    assert.strictEqual(countImages([]), 0);
  });

  test("mixed files count only the images", () => {
    assert.strictEqual(
      countImages([
        img("F1", "application/pdf"),
        img("F2"),
        img("F3", "text/plain"),
        img("F4", "image/gif"),
      ]),
      2,
    );
  });

  test("odd entries are not images", () => {
    assert.strictEqual(
      countImages([null, 5, "image/png", {}, { mimetype: 5 }, { mimetype: null }, img("F1")]),
      1,
    );
  });

  test("a mimetype that only contains image is not an image", () => {
    assert.strictEqual(
      countImages([
        img("F1", "images/png"),
        img("F2", "application/image/png"),
        img("F3", "image"),
        img("F4", ""),
      ]),
      0,
    );
  });

  test("non-array files count zero", () => {
    for (const files of [undefined, null, 5, "image/png", {}, { mimetype: "image/png" }]) {
      assert.strictEqual(countImages(files), 0);
    }
  });
});

describe("hasImage", () => {
  test("true for one image", () => {
    assert.strictEqual(hasImage([img("F1")]), true);
  });

  test("false for no images", () => {
    assert.strictEqual(hasImage([]), false);
    assert.strictEqual(hasImage(null), false);
    assert.strictEqual(hasImage([img("F1", "application/pdf")]), false);
    assert.strictEqual(hasImage({}), false);
  });
});
