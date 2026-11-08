import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { fetchMessage, hasBotLamp } from "../src/nudge.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { carries, render, SECRET } from "./helpers/log-guard.js";

const CHANNEL = "C1";
const TS = "100.000001";
const TEXT = "FS secret listing text";

let fake;
let logged;

beforeEach((t) => {
  fake = createFakeSlack();
  const mock = t.mock.method(console, "error", () => {});
  logged = () => mock.mock.calls.map((c) => c.arguments);
});

// Every argument of every log call, objects and errors included, as one string.
const loggedText = () => logged().flat().map(render).join("\n");

// Whatever a test makes fail, nothing it logs may carry the message text or a token.
afterEach(() => {
  assert.ok(!carries(loggedText(), TEXT), "a log line carries the message text");
  assert.ok(!carries(loggedText(), SECRET), "a log line carries a token");
});

const lines = () => logged().map((args) => args[0]);
const assertOneLogLine = () => {
  assert.strictEqual(logged().length, 1);
  assert.strictEqual(typeof lines()[0], "string");
  assert.notStrictEqual(lines()[0], "");
};

const fetchIt = () => fetchMessage(fake.client, CHANNEL, TS);

describe("fetchMessage", () => {
  test("asks history for exactly that message and returns it", async () => {
    const message = {
      channel: CHANNEL,
      ts: TS,
      text: TEXT,
      reactions: [{ name: "rotating_light", users: ["UBOT"], count: 1 }],
      files: [{ id: "F1", mimetype: "image/png" }],
    };
    fake.seed(message);
    assert.deepStrictEqual(await fetchIt(), message);
    assert.deepStrictEqual(fake.calls, [
      {
        method: "conversations.history",
        args: { channel: CHANNEL, latest: TS, inclusive: true, limit: 1 },
      },
    ]);
  });

  test("a rejected call fails closed and logs only the error code", async () => {
    fake.seed({ channel: CHANNEL, ts: TS, text: TEXT });
    fake.fail("conversations.history", 1, "ratelimited");
    assert.strictEqual(await fetchIt(), null);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], /^\S.* failed: ratelimited$/);
  });

  test("a different message than the one asked for fails closed", async () => {
    fake.seed({ channel: CHANNEL, ts: "99.000001", text: TEXT });
    assert.strictEqual(await fetchIt(), null);
    assertOneLogLine();
  });

  for (const [name, response] of [
    ["an empty list", { ok: true, messages: [] }],
    ["a missing list", { ok: true }],
    ["a null response", null],
    ["a null entry", { ok: true, messages: [null] }],
    ["a non-array list", { ok: true, messages: "x" }],
    ["an array entry", { ok: true, messages: [[]] }],
  ]) {
    test(`${name} fails closed`, async () => {
      fake.respond("conversations.history", 1, response);
      assert.strictEqual(await fetchIt(), null);
      assertOneLogLine();
    });
  }

  test("no failure line contains the message text", async () => {
    fake.seed({ channel: CHANNEL, ts: "99.000001", text: TEXT });
    await fetchIt();
    fake.fail("conversations.history", 2, "ratelimited");
    await fetchIt();
    assert.strictEqual(logged().length, 2);
    assert.ok(!carries(loggedText(), TEXT));
  });

  // A client error can carry the token in its message and its request headers.
  test("a token-bearing error logs only its code", async () => {
    fake.seed({ channel: CHANNEL, ts: TS, text: TEXT });
    fake.client.conversations.history = async () => {
      throw Object.assign(new Error(`An API error occurred: invalid_auth ${SECRET}`), {
        data: { ok: false, error: "invalid_auth" },
        original: { config: { headers: { Authorization: `Bearer ${SECRET}` } } },
      });
    };
    assert.strictEqual(await fetchIt(), null);
    assert.ok(lines().some((line) => /^\S.* failed: invalid_auth$/.test(line)));
    assert.ok(!carries(loggedText(), SECRET));
  });
});

describe("hasBotLamp", () => {
  const lamp = (users) => ({ name: "rotating_light", users, count: 1 });
  const other = { name: "eyes", users: ["UBOT"], count: 1 };

  test("true only for the bot's own lamp", () => {
    assert.strictEqual(hasBotLamp({ reactions: [lamp(["UBOT"])] }, "UBOT"), true);
    assert.strictEqual(hasBotLamp({ reactions: [other, lamp(["UOTHER", "UBOT"])] }, "UBOT"), true);
  });

  const falseCases = [
    ["someone else's lamp", { reactions: [lamp(["UOTHER"])] }, "UBOT"],
    ["a different reaction by the bot", { reactions: [other] }, "UBOT"],
    ["no reactions", {}, "UBOT"],
    ["null reactions", { reactions: null }, "UBOT"],
    ["string reactions", { reactions: "x" }, "UBOT"],
    ["a null reaction entry", { reactions: [null] }, "UBOT"],
    ["a lamp without users", { reactions: [{ name: "rotating_light" }] }, "UBOT"],
    ["a lamp with string users", { reactions: [{ name: "rotating_light", users: "UBOT" }] }, "UBOT"],
    ["a null message", null, "UBOT"],
    ["an undefined message", undefined, "UBOT"],
    ["a numeric message", 5, "UBOT"],
    ["a null bot id", { reactions: [lamp(["UBOT"])] }, null],
  ];
  for (const [name, message, botUserId] of falseCases) {
    test(`false for ${name}`, () => {
      assert.strictEqual(hasBotLamp(message, botUserId), false);
    });
  }
});
