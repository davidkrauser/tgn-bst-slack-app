import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { postNudge } from "../src/nudge.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { carries, render, SECRET } from "./helpers/log-guard.js";

const CHANNEL = "C123";
const TS = "1.1";
const TEXT = "secret nudge text";
const failure = (code) => new RegExp(`^\\S.* failed: ${code}$`);

let fake;
let logged;

beforeEach((t) => {
  fake = createFakeSlack();
  fake.seed({ channel: CHANNEL, ts: TS, user: "U1", text: "post" });
  const mock = t.mock.method(console, "error", () => {});
  logged = () => mock.mock.calls.map((c) => c.arguments);
});

// Every argument of every log call, objects and errors included, as one string.
const loggedText = () => logged().flat().map(render).join("\n");

// Whatever a test makes fail, nothing it logs may carry the reply text or a token.
afterEach(() => {
  assert.ok(!carries(loggedText(), TEXT), "a log line carries the reply text");
  assert.ok(!carries(loggedText(), SECRET), "a log line carries a token");
});

const methods = () => fake.calls.map((c) => c.method);
const lines = () => logged().map((args) => args[0]);
const callsTo = (method) => fake.calls.filter((c) => c.method === method);
const assertFields = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(actual[key], value, key);
  }
};
const assertOneLogLine = () => {
  assert.strictEqual(logged().length, 1);
  assert.strictEqual(typeof lines()[0], "string");
  assert.notStrictEqual(lines()[0], "");
};
// After the lamp and the reply, the rollback is a delete and a lamp removal in either order.
const assertRolledBack = (withDelete) => {
  assert.deepStrictEqual(methods().slice(0, 2), ["reactions.add", "chat.postMessage"]);
  const rest = methods().slice(2).sort();
  assert.deepStrictEqual(rest, withDelete ? ["chat.delete", "reactions.remove"] : ["reactions.remove"]);
};
const seedReply = (ts) =>
  fake.seed({ channel: CHANNEL, ts, thread_ts: TS, user: "UBOT" });
const run = () => postNudge(fake.client, CHANNEL, TS, TEXT);

describe("postNudge", () => {
  test("success adds the lamp, then posts in thread", async () => {
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(methods(), ["reactions.add", "chat.postMessage"]);
    assertFields(fake.calls[0].args, { channel: CHANNEL, timestamp: TS, name: "rotating_light" });
    assertFields(fake.calls[1].args, { channel: CHANNEL, thread_ts: TS, markdown_text: TEXT });
  });

  test("a top-level thread_ts alone confirms the reply", async () => {
    fake.respond("chat.postMessage", 1, { ok: true, channel: CHANNEL, ts: "9.9", thread_ts: TS, message: { ts: "9.9", text: TEXT } });
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(methods(), ["reactions.add", "chat.postMessage"]);
  });

  test("a failed lamp add does not stop the post", async () => {
    fake.fail("reactions.add", 1, "already_reacted");
    assert.strictEqual(await run(), true);
    assert.deepStrictEqual(methods(), ["reactions.add", "chat.postMessage"]);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("already_reacted"));
  });

  test("a rejected post skips the delete, removes the lamp, and returns false", async () => {
    fake.fail("chat.postMessage", 1, "channel_not_found");
    assert.strictEqual(await run(), false);
    assert.deepStrictEqual(methods(), ["reactions.add", "chat.postMessage", "reactions.remove"]);
    assertFields(fake.calls[2].args, { channel: CHANNEL, timestamp: TS, name: "rotating_light" });
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("channel_not_found"));
  });

  for (const [label, response] of [
    ["no thread_ts", { ok: true, channel: CHANNEL, ts: "9.9", message: { ts: "9.9", text: TEXT } }],
    ["another thread_ts", { ok: true, channel: CHANNEL, ts: "9.9", message: { ts: "9.9", text: TEXT, thread_ts: "5.5" } }],
  ]) {
    test(`an unconfirmed post (${label}) is deleted and the lamp removed`, async () => {
      fake.respond("chat.postMessage", 1, response);
      seedReply("9.9");
      assert.strictEqual(await run(), false);
      assertRolledBack(true);
      assertFields(callsTo("chat.delete")[0].args, { channel: CHANNEL, ts: "9.9" });
      assertFields(callsTo("reactions.remove")[0].args, { channel: CHANNEL, timestamp: TS, name: "rotating_light" });
      assert.strictEqual(fake.message("9.9"), undefined);
      assertOneLogLine();
    });
  }

  for (const [label, response] of [
    ["a null response", null],
    ["a response without ts", { ok: true }],
  ]) {
    test(`${label} skips the delete but removes the lamp`, async () => {
      fake.respond("chat.postMessage", 1, response);
      assert.strictEqual(await run(), false);
      assert.deepStrictEqual(methods(), ["reactions.add", "chat.postMessage", "reactions.remove"]);
      assertOneLogLine();
    });
  }

  test("a failed delete still removes the lamp", async () => {
    fake.respond("chat.postMessage", 1, { ok: true, channel: CHANNEL, ts: "9.9", message: { ts: "9.9", text: TEXT } });
    fake.fail("chat.delete", 1, "message_not_found");
    assert.strictEqual(await run(), false);
    assertRolledBack(true);
    assert.strictEqual(lines().length, 2);
    assert.ok(lines().some((line) => failure("message_not_found").test(line)));
  });

  test("a failed lamp removal is logged and false is returned", async () => {
    fake.respond("chat.postMessage", 1, { ok: true, channel: CHANNEL, ts: "9.9", message: { ts: "9.9", text: TEXT } });
    seedReply("9.9");
    fake.fail("reactions.remove", 1, "e_remove");
    assert.strictEqual(await run(), false);
    assert.strictEqual(lines().length, 2);
    assert.ok(lines().some((line) => failure("e_remove").test(line)));
  });

  test("every call failing still resolves, with one line per failure", async () => {
    fake.fail("reactions.add", 1, "e_add");
    fake.fail("chat.postMessage", 1, "e_post");
    fake.fail("reactions.remove", 1, "e_remove");
    assert.strictEqual(await run(), false);
    assert.deepStrictEqual(methods(), ["reactions.add", "chat.postMessage", "reactions.remove"]);
    assert.strictEqual(lines().length, 3);
    for (const code of ["e_add", "e_post", "e_remove"]) {
      assert.strictEqual(lines().filter((line) => failure(code).test(line)).length, 1, code);
    }
  });

  test("an error with only a code logs that code", async () => {
    const err = new Error("hidden detail");
    err.code = "ECONNRESET";
    fake.client.chat.postMessage = async () => {
      throw err;
    };
    assert.strictEqual(await run(), false);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("ECONNRESET"));
    assert.ok(!lines()[0].includes("hidden detail"));
  });

  test("a plain error logs unknown_error, not its message", async () => {
    fake.client.chat.postMessage = async () => {
      throw new Error("boom");
    };
    assert.strictEqual(await run(), false);
    assert.strictEqual(lines().length, 1);
    assert.match(lines()[0], failure("unknown_error"));
    assert.ok(!lines()[0].includes("boom"));
  });

  for (const [kind, code] of [
    ["rate_limited", "slack_webapi_rate_limited_error"],
    ["request", "slack_webapi_request_error"],
    ["http", "slack_webapi_http_error"],
    ["exhausted", "unknown_error"],
  ]) {
    test(`client error kind ${kind} on the post logs ${code}`, async () => {
      fake.failWith("chat.postMessage", 1, kind);
      assert.strictEqual(await run(), false);
      assert.strictEqual(lines().length, 1);
      assert.match(lines()[0], failure(code));
    });
  }

  // A client error can carry the token in its message and the request body in its
  // config. Every call is reached: unless the post itself throws, the reply comes
  // back unconfirmed, so the rollback deletes it and removes the lamp.
  for (const method of ["reactions.add", "chat.postMessage", "chat.delete", "reactions.remove"]) {
    test(`a token-bearing error from ${method} logs only its code`, async () => {
      fake.respond("chat.postMessage", 1, { ok: true, channel: CHANNEL, ts: "9.9", message: { ts: "9.9", text: TEXT } });
      seedReply("9.9");
      const [group, name] = method.split(".");
      fake.client[group][name] = async () => {
        throw Object.assign(new Error(`An API error occurred: invalid_auth ${SECRET}`), {
          data: { ok: false, error: "invalid_auth" },
          original: { config: { headers: { Authorization: `Bearer ${SECRET}` }, data: TEXT } },
        });
      };
      assert.strictEqual(await run(), false);
      assert.ok(lines().some((line) => failure("invalid_auth").test(line)));
      assert.ok(!carries(loggedText(), SECRET));
    });
  }
});
