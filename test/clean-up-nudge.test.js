import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { cleanUpNudge } from "../src/nudge.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { carries, render, SECRET } from "./helpers/log-guard.js";

const CHANNEL = "C1";
const TS = "100.000001";
const BOT = "UBOT";
const POST_TEXT = "FS secret post text";
const REPLY_TEXT = "secret reply text";

let fake;
let logged;

const lampOn = () => [{ name: "rotating_light", users: [BOT], count: 1 }];

function seedParent() {
  fake.seed({ channel: CHANNEL, ts: TS, user: "UMEMBER", text: POST_TEXT, reactions: lampOn() });
}

function seedReply(ts, user = BOT, extra = {}) {
  fake.seed({ channel: CHANNEL, ts, thread_ts: TS, user, text: REPLY_TEXT, ...extra });
}

function setup(options) {
  fake = createFakeSlack(options);
  seedParent();
}

beforeEach((t) => {
  setup();
  const mock = t.mock.method(console, "error", () => {});
  logged = () => mock.mock.calls.map((c) => c.arguments);
});

// Every argument of every log call, objects and errors included, as one string.
const loggedText = () => logged().flat().map(render).join("\n");

// Whatever a test makes fail, nothing it logs may carry the post's or a reply's
// text, or a token.
afterEach(() => {
  for (const [secret, what] of [[POST_TEXT, "the post text"], [REPLY_TEXT, "a reply's text"], [SECRET, "a token"]]) {
    assert.ok(!carries(loggedText(), secret), `a log line carries ${what}`);
  }
});

const run = () => cleanUpNudge(fake.client, CHANNEL, TS, BOT);
const methods = () => fake.calls.map((c) => c.method);
const threadTs = () => fake.thread(TS).map((m) => m.ts);
const lamp = () => fake.message(TS).reactions;
const lines = () => logged().map((args) => args[0]);
const deletedTs = () => fake.calls.filter((c) => c.method === "chat.delete").map((c) => c.args.ts);
const failure = (code) => new RegExp(`^\\S.* failed: ${code}$`);

describe("cleanUpNudge", () => {
  test("deletes the bot's replies, spares others', removes the lamp", async () => {
    seedReply("100.000002");
    seedReply("100.000003", "UMEMBER");
    seedReply("100.000004", BOT);
    seedReply("100.000005", "UOTHERBOT", { bot_id: "BOTHER" });
    assert.strictEqual(await run(), true);
    const all = methods();
    assert.strictEqual(all[0], "conversations.replies");
    assert.strictEqual(all[all.length - 1], "reactions.remove");
    assert.strictEqual(fake.calls[0].args.channel, CHANNEL);
    assert.strictEqual(fake.calls[0].args.ts, TS);
    assert.deepStrictEqual(deletedTs().sort(), ["100.000002", "100.000004"]);
    assert.strictEqual(fake.calls[all.length - 1].args.timestamp, TS);
    assert.strictEqual(fake.calls[all.length - 1].args.name, "rotating_light");
    assert.deepStrictEqual(threadTs(), ["100.000003", "100.000005"]);
    assert.deepStrictEqual(lamp(), []);
  });

  test("pages through every reply, however many pages there are", async () => {
    setup({ pageSize: 2 });
    for (let i = 2; i <= 6; i += 1) seedReply(`100.00000${i}`);
    seedReply("100.000007", "UMEMBER");
    assert.strictEqual(await run(), true);
    assert.strictEqual(deletedTs().length, 5);
    assert.deepStrictEqual(threadTs(), ["100.000007"]);
    assert.deepStrictEqual(lamp(), []);
  });

  test("with no bot replies it only removes the lamp", async () => {
    seedReply("100.000002", "UMEMBER");
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(methods(), ["conversations.replies", "reactions.remove"]);
    assert.deepStrictEqual(lamp(), []);
  });

  test("a failed page deletes nothing, keeps the lamp, and returns false", async () => {
    setup({ pageSize: 2 });
    for (let i = 2; i <= 4; i += 1) seedReply(`100.00000${i}`);
    fake.fail("conversations.replies", 2);
    assert.strictEqual(await run(), false);
    assert.ok(!methods().includes("chat.delete"));
    assert.ok(!methods().includes("reactions.remove"));
    assert.strictEqual(lamp().length, 1);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("fatal_error"));
  });

  test("a failed delete still deletes the rest, keeps the lamp, and a retry finishes", async () => {
    seedReply("100.000002");
    seedReply("100.000003");
    fake.fail("chat.delete", 1, "cant_delete_message");
    assert.strictEqual(await run(), false);
    assert.strictEqual(fake.calls.filter((c) => c.method === "chat.delete").length, 2);
    assert.ok(!methods().includes("reactions.remove"));
    assert.strictEqual(lamp().length, 1);
    assert.strictEqual(threadTs().length, 1);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("cant_delete_message"));

    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(threadTs(), []);
    assert.deepStrictEqual(lamp(), []);
  });

  test("a reply that is already gone counts as clean", async () => {
    seedReply("100.000002");
    fake.fail("chat.delete", 1, "message_not_found");
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(lamp(), []);
  });

  test("a failed lamp removal returns false and is logged", async () => {
    seedReply("100.000002");
    fake.fail("reactions.remove", 1);
    assert.strictEqual(await run(), false);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("fatal_error"));
  });

  for (const [label, response] of [
    ["null", null],
    ["no messages", { ok: true }],
  ]) {
    test(`an odd page (${label}) deletes nothing and ends the listing`, async () => {
      fake.respond("conversations.replies", 1, response);
      assert.strictEqual(await run(), true);
      assert.deepStrictEqual(methods(), ["conversations.replies", "reactions.remove"]);
    });
  }

  test("non-object entries and a reply with no ts are skipped, the other bot replies still deleted", async () => {
    seedReply("100.000002");
    fake.respond("conversations.replies", 1, {
      ok: true,
      messages: [null, 5, { user: BOT, text: "no ts" }, { user: BOT, ts: "100.000002", thread_ts: TS }],
    });
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(deletedTs(), ["100.000002"]);
    assert.deepStrictEqual(lamp(), []);
  });

  // A client error can carry the token in its message and its request headers.
  // With one bot reply in the thread, cleanup reaches each of these calls.
  for (const method of ["conversations.replies", "chat.delete", "reactions.remove"]) {
    test(`a token-bearing error from ${method} logs only its code`, async () => {
      seedReply("100.000002");
      const [group, name] = method.split(".");
      fake.client[group][name] = async () => {
        throw Object.assign(new Error(`An API error occurred: invalid_auth ${SECRET}`), {
          data: { ok: false, error: "invalid_auth" },
          original: { config: { headers: { Authorization: `Bearer ${SECRET}` } } },
        });
      };
      assert.strictEqual(await run(), false);
      assert.ok(lines().some((line) => failure("invalid_auth").test(line)));
      assert.ok(!carries(loggedText(), SECRET));
    });
  }

  test("a parent entry authored by the bot is never deleted", async () => {
    fake.seed({ channel: CHANNEL, ts: TS, user: BOT, text: POST_TEXT, reactions: lampOn() });
    seedReply("100.000002");
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(deletedTs(), ["100.000002"]);
    assert.ok(fake.message(TS));
  });
});
