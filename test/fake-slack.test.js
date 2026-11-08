import { test } from "node:test";
import assert from "node:assert";
import { createFakeSlack } from "./helpers/fake-slack.js";

test("records calls across methods in call order", async () => {
  const { client, calls, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "1.1" });
  seed({ channel: "C1", ts: "2.2" });
  await client.chat.postMessage({ channel: "C1", markdown_text: "a" });
  await client.reactions.add({ channel: "C1", timestamp: "1.1", name: "x" });
  await client.chat.delete({ channel: "C1", ts: "2.2" });
  await client.reactions.remove({ channel: "C1", timestamp: "1.1", name: "x" });
  assert.deepStrictEqual(calls, [
    { method: "chat.postMessage", args: { channel: "C1", markdown_text: "a" } },
    {
      method: "reactions.add",
      args: { channel: "C1", timestamp: "1.1", name: "x" },
    },
    { method: "chat.delete", args: { channel: "C1", ts: "2.2" } },
    {
      method: "reactions.remove",
      args: { channel: "C1", timestamp: "1.1", name: "x" },
    },
  ]);
});

test("mutating an args object after the call leaves the log unchanged", async () => {
  const { client, calls } = createFakeSlack();
  const args = { channel: "C1", markdown_text: "a" };
  await client.chat.postMessage(args);
  args.markdown_text = "changed";
  assert.strictEqual(calls[0].args.markdown_text, "a");
});

test("fail rejects only the nth call of a method, with a platform error", async () => {
  const { client, calls, fail, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "1.1" });
  fail("reactions.add", 2, "too_many_emoji");
  const args = { channel: "C1", timestamp: "1.1", name: "x" };
  assert.deepStrictEqual(await client.reactions.add(args), { ok: true });
  await assert.rejects(client.reactions.add(args), (error) => {
    assert.ok(error instanceof Error);
    assert.strictEqual(error.code, "slack_webapi_platform_error");
    assert.deepStrictEqual(error.data, { ok: false, error: "too_many_emoji" });
    assert.strictEqual(
      error.message,
      "An API error occurred: too_many_emoji",
    );
    return true;
  });
  await assert.rejects(
    client.reactions.add(args),
    (error) => error.data.error === "already_reacted",
  );
  assert.strictEqual(calls.length, 3);
});

test("fail without a code uses fatal_error", async () => {
  const { client, fail } = createFakeSlack();
  fail("chat.delete", 1);
  await assert.rejects(
    client.chat.delete({ channel: "C1", ts: "1.1" }),
    (error) => error.data.error === "fatal_error",
  );
});

test("counts are kept per method", async () => {
  const { client, fail } = createFakeSlack();
  fail("chat.delete", 1);
  await client.chat.postMessage({ channel: "C1", markdown_text: "a" });
  await assert.rejects(client.chat.delete({ channel: "C1", ts: "1.1" }));
});

test("respond replaces one response, then the default returns", async () => {
  const { client, respond } = createFakeSlack();
  respond("chat.postMessage", 1, null);
  assert.strictEqual(
    await client.chat.postMessage({ channel: "C1", markdown_text: "a" }),
    null,
  );
  const second = await client.chat.postMessage({
    channel: "C1",
    markdown_text: "b",
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.message.text, "b");
});

test("post timestamps are unique and increasing", async () => {
  const { client } = createFakeSlack();
  const stamps = [];
  for (let i = 0; i < 12; i += 1) {
    stamps.push((await client.chat.postMessage({ channel: "C1" })).ts);
  }
  assert.strictEqual(new Set(stamps).size, stamps.length);
  assert.deepStrictEqual(
    stamps,
    [...stamps].sort((a, b) => Number(a) - Number(b)),
  );
});

test("a post never takes the ts of a message already in the channel", async () => {
  const { client, seed, message } = createFakeSlack();
  // Take the first stamp by posting, then seed a parent and a reply on the next two
  // stamps that a later post would take.
  const first = (await client.chat.postMessage({ channel: "C1" })).ts;
  const taken = [first, "1700000000.000002", "1700000000.000003"];
  seed({ channel: "C1", ts: taken[1], user: "U1", text: "MEMBER POST" });
  seed({ channel: "C1", ts: taken[2], thread_ts: taken[1], user: "U2", text: "MEMBER REPLY" });
  const posted = (await client.chat.postMessage({ channel: "C1", thread_ts: taken[1] })).ts;
  assert.ok(!taken.includes(posted), `${posted} was already taken`);
  assert.strictEqual(message(taken[1]).text, "MEMBER POST");
  assert.strictEqual(message(taken[2]).text, "MEMBER REPLY");
  const { messages } = await client.conversations.replies({ channel: "C1", ts: taken[1] });
  assert.deepStrictEqual(messages.map((m) => m.ts), [taken[1], taken[2], posted]);
});

test("a threaded post echoes thread_ts on the message only", async () => {
  const { client } = createFakeSlack();
  const threaded = await client.chat.postMessage({
    channel: "C1",
    thread_ts: "9.9",
    markdown_text: "hi",
  });
  assert.strictEqual(threaded.channel, "C1");
  assert.strictEqual(threaded.message.thread_ts, "9.9");
  assert.ok(!("thread_ts" in threaded));

  const top = await client.chat.postMessage({ channel: "C1" });
  assert.ok(!("thread_ts" in top.message));
  assert.ok(!("thread_ts" in top));
});

test("the message carries the configured bot identity", async () => {
  const defaults = await createFakeSlack().client.chat.postMessage({});
  assert.strictEqual(defaults.message.user, "UBOT");
  assert.strictEqual(defaults.message.bot_id, "BBOT");
  assert.strictEqual(defaults.message.type, "message");

  const custom = createFakeSlack({ botUserId: "U42", botId: "B42" });
  const { message } = await custom.client.chat.postMessage({});
  assert.strictEqual(message.user, "U42");
  assert.strictEqual(message.bot_id, "B42");
});

test("auth.test, history and replies are recorded and honour fail and respond", async () => {
  const { client, calls, fail, respond, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "1.1" });
  fail("auth.test", 1, "invalid_auth");
  await assert.rejects(
    client.auth.test({}),
    (error) => error.data.error === "invalid_auth",
  );
  respond("conversations.history", 1, { ok: true, messages: [] });
  const historyArgs = { channel: "C1", limit: 1 };
  assert.deepStrictEqual(await client.conversations.history(historyArgs), {
    ok: true,
    messages: [],
  });
  fail("conversations.replies", 1, "thread_not_found");
  const repliesArgs = { channel: "C1", ts: "1.1" };
  await assert.rejects(
    client.conversations.replies(repliesArgs),
    (error) => error.data.error === "thread_not_found",
  );
  const second = await client.conversations.replies(repliesArgs);
  assert.deepStrictEqual(second.messages.map((m) => m.ts), ["1.1"]);
  assert.deepStrictEqual(calls, [
    { method: "auth.test", args: {} },
    { method: "conversations.history", args: historyArgs },
    { method: "conversations.replies", args: repliesArgs },
    { method: "conversations.replies", args: repliesArgs },
  ]);
});

test("auth.test returns the configured bot identity", async () => {
  const defaults = await createFakeSlack().client.auth.test({});
  assert.strictEqual(defaults.ok, true);
  assert.strictEqual(defaults.user_id, "UBOT");
  assert.strictEqual(defaults.bot_id, "BBOT");
  assert.strictEqual(typeof defaults.team_id, "string");
  const custom = createFakeSlack({ botUserId: "U42", botId: "B42" });
  const result = await custom.client.auth.test({});
  assert.strictEqual(result.user_id, "U42");
  assert.strictEqual(result.bot_id, "B42");
});

test("a reaction shows in history and is gone from it once removed", async () => {
  const { client, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1", user: "U1", text: "hi" });
  const react = { channel: "C1", timestamp: "10.1", name: "rotating_light" };
  const latest = { channel: "C1", latest: "10.1", inclusive: true, limit: 1 };

  await client.reactions.add(react);
  let [post] = (await client.conversations.history(latest)).messages;
  assert.deepStrictEqual(post.reactions, [
    { name: "rotating_light", users: ["UBOT"], count: 1 },
  ]);

  await client.reactions.remove(react);
  [post] = (await client.conversations.history(latest)).messages;
  assert.ok(!post.reactions || post.reactions.length === 0);
});

test("another user's reaction survives the bot's add and remove", async () => {
  const { client, seed, message } = createFakeSlack();
  seed({
    channel: "C1",
    ts: "10.1",
    reactions: [{ name: "rotating_light", users: ["U9"], count: 1 }],
  });
  const react = { channel: "C1", timestamp: "10.1", name: "rotating_light" };
  await client.reactions.add(react);
  assert.deepStrictEqual(message("10.1").reactions, [
    { name: "rotating_light", users: ["U9", "UBOT"], count: 2 },
  ]);
  await client.reactions.remove(react);
  assert.deepStrictEqual(message("10.1").reactions, [
    { name: "rotating_light", users: ["U9"], count: 1 },
  ]);
});

test("reactions on unknown messages or names fail and change nothing", async () => {
  const { client, seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  const code = (error) => error.data.error;
  const unknownTs = { channel: "C1", timestamp: "99.9", name: "x" };
  await assert.rejects(client.reactions.add(unknownTs), (e) => code(e) === "message_not_found");
  await assert.rejects(client.reactions.remove(unknownTs), (e) => code(e) === "message_not_found");
  await assert.rejects(
    client.reactions.remove({ channel: "C1", timestamp: "10.1", name: "x" }),
    (e) => code(e) === "no_reaction" && e.code === "slack_webapi_platform_error",
  );
  assert.strictEqual(message("99.9"), undefined);
  assert.ok(!message("10.1").reactions);
});

test("removing a reaction the bot did not make fails and leaves the other users' reaction", async () => {
  const { client, seed, message } = createFakeSlack();
  seed({
    channel: "C1",
    ts: "10.1",
    reactions: [{ name: "rotating_light", users: ["U9"], count: 1 }],
  });
  await assert.rejects(
    client.reactions.remove({ channel: "C1", timestamp: "10.1", name: "rotating_light" }),
    (error) => error.data.error === "no_reaction",
  );
  assert.deepStrictEqual(message("10.1").reactions, [
    { name: "rotating_light", users: ["U9"], count: 1 },
  ]);
});

test("a second add by the bot fails already_reacted and leaves one reaction", async () => {
  const { client, seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  const react = { channel: "C1", timestamp: "10.1", name: "x" };
  await client.reactions.add(react);
  const before = message("10.1");
  await assert.rejects(
    client.reactions.add(react),
    (error) =>
      error.code === "slack_webapi_platform_error" &&
      error.data.error === "already_reacted",
  );
  assert.deepStrictEqual(message("10.1"), before);
});

test("chat.delete of an unknown ts fails message_not_found and deletes nothing", async () => {
  const { client, seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  await assert.rejects(
    client.chat.delete({ channel: "C1", ts: "99.9" }),
    (error) =>
      error.code === "slack_webapi_platform_error" &&
      error.data.error === "message_not_found",
  );
  assert.ok(message("10.1"));
  await client.chat.delete({ channel: "C1", ts: "10.1" });
  await assert.rejects(
    client.chat.delete({ channel: "C1", ts: "10.1" }),
    (error) => error.data.error === "message_not_found",
  );
});

test("replies on an unknown parent fails thread_not_found, and limit overrides the page size", async () => {
  const { client, seed } = createFakeSlack({ pageSize: 5 });
  seed({ channel: "C1", ts: "10.1" });
  await assert.rejects(
    client.conversations.replies({ channel: "C1", ts: "99.9" }),
    (error) =>
      error.code === "slack_webapi_platform_error" &&
      error.data.error === "thread_not_found",
  );
  await assert.rejects(
    client.conversations.replies({ channel: "C2", ts: "10.1" }),
    (error) => error.data.error === "thread_not_found",
  );
  for (let i = 1; i <= 4; i += 1) {
    seed({ channel: "C1", ts: `10.${i + 1}`, thread_ts: "10.1" });
  }
  const limited = await client.conversations.replies({ channel: "C1", ts: "10.1", limit: 2 });
  assert.deepStrictEqual(limited.messages.map((m) => m.ts), ["10.1", "10.2"]);
  assert.strictEqual(limited.has_more, true);
  assert.notStrictEqual(limited.response_metadata.next_cursor, "");
});

const CLIENT_KINDS = {
  rate_limited: { code: "slack_webapi_rate_limited_error", retryAfter: 1 },
  request: { code: "slack_webapi_request_error" },
  http: { code: "slack_webapi_http_error", statusCode: 500 },
  exhausted: {},
};

for (const [kind, expected] of Object.entries(CLIENT_KINDS)) {
  test(`failWith ${kind} throws a client error on the nth call only`, async () => {
    const { client, calls, failWith, seed, message } = createFakeSlack();
    seed({ channel: "C1", ts: "1.1" });
    failWith("reactions.add", 2, kind);
    const react = { channel: "C1", timestamp: "1.1", name: "x" };
    await client.reactions.add(react);
    await client.reactions.remove(react);
    await assert.rejects(client.reactions.add(react), (error) => {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.code, expected.code);
      assert.strictEqual(error.retryAfter, expected.retryAfter);
      assert.strictEqual(error.statusCode, expected.statusCode);
      assert.ok(!("data" in error));
      if (kind === "request") {
        assert.ok(error.original instanceof Error);
        assert.strictEqual(error.original.message, "socket hang up");
      }
      return true;
    });
    assert.deepStrictEqual(message("1.1").reactions ?? [], []);
    assert.deepStrictEqual(await client.reactions.add(react), { ok: true });
    assert.strictEqual(calls.length, 4);
  });
}

test("an exhausted rate limit names the method that was called", async () => {
  const { client, failWith, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "1.1" });
  failWith("chat.postMessage", 1, "exhausted");
  failWith("reactions.add", 1, "exhausted");
  await assert.rejects(
    client.chat.postMessage({ channel: "C1" }),
    (error) => error.message.includes("url: chat.postMessage,"),
  );
  await assert.rejects(
    client.reactions.add({ channel: "C1", timestamp: "1.1", name: "x" }),
    (error) =>
      error.message.includes("url: reactions.add,") &&
      !error.message.includes("chat.postMessage"),
  );
});

test("failWith rejects an unknown kind", () => {
  const { failWith } = createFakeSlack();
  assert.throws(() => failWith("chat.postMessage", 1, "bogus"));
});

test("history honours inclusive, limit and channel, and hides thread replies", async () => {
  const { client, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  seed({ channel: "C1", ts: "20.1" });
  seed({ channel: "C1", ts: "30.1" });
  seed({ channel: "C2", ts: "25.1" });
  seed({ channel: "C1", ts: "20.2", thread_ts: "20.1" });
  seed({ channel: "C1", ts: "20.1", thread_ts: "20.1" });

  const stamps = (result) => result.messages.map((m) => m.ts);
  assert.deepStrictEqual(
    stamps(await client.conversations.history({ channel: "C1" })),
    ["30.1", "20.1", "10.1"],
  );
  assert.deepStrictEqual(
    stamps(
      await client.conversations.history({
        channel: "C1",
        latest: "20.1",
        inclusive: true,
      }),
    ),
    ["20.1", "10.1"],
  );
  assert.deepStrictEqual(
    stamps(
      await client.conversations.history({
        channel: "C1",
        latest: "20.1",
        inclusive: false,
      }),
    ),
    ["10.1"],
  );
  const limited = await client.conversations.history({
    channel: "C1",
    latest: "25.0",
    inclusive: true,
    limit: 1,
  });
  assert.deepStrictEqual(stamps(limited), ["20.1"]);
  assert.strictEqual(limited.has_more, true);
});

test("threaded posts appear in thread and replies, and chat.delete removes them", async () => {
  const { client, seed, thread } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1", user: "U1" });
  const reply = await client.chat.postMessage({
    channel: "C1",
    thread_ts: "10.1",
    markdown_text: "nudge",
  });
  assert.deepStrictEqual(
    thread("10.1").map((m) => m.ts),
    [reply.ts],
  );
  assert.strictEqual(thread("10.1")[0].user, "UBOT");
  assert.strictEqual(thread("10.1")[0].channel, "C1");
  let replies = await client.conversations.replies({ channel: "C1", ts: "10.1" });
  assert.deepStrictEqual(
    replies.messages.map((m) => m.ts),
    ["10.1", reply.ts],
  );

  await client.chat.delete({ channel: "C1", ts: reply.ts });
  assert.deepStrictEqual(thread("10.1"), []);
  replies = await client.conversations.replies({ channel: "C1", ts: "10.1" });
  assert.deepStrictEqual(
    replies.messages.map((m) => m.ts),
    ["10.1"],
  );
});

test("replies pages through a thread with an opaque cursor", async () => {
  const { client, seed } = createFakeSlack({ pageSize: 2 });
  seed({ channel: "C1", ts: "10.1" });
  for (let i = 1; i <= 5; i += 1) {
    seed({ channel: "C1", ts: `10.${i + 1}`, thread_ts: "10.1" });
  }
  const seen = [];
  const cursors = [];
  let cursor;
  let pages = 0;
  do {
    const page = await client.conversations.replies({
      channel: "C1",
      ts: "10.1",
      cursor,
    });
    pages += 1;
    seen.push(...page.messages.map((m) => m.ts));
    cursor = page.response_metadata.next_cursor;
    cursors.push(cursor);
    assert.strictEqual(page.has_more, cursor !== "");
  } while (cursor);
  assert.strictEqual(pages, 3);
  assert.deepStrictEqual(seen, ["10.1", "10.2", "10.3", "10.4", "10.5", "10.6"]);
  assert.strictEqual(cursors.at(-1), "");
});

test("a cursor is an opaque string, not an offset a caller could compute", async () => {
  const { client, seed } = createFakeSlack({ pageSize: 2 });
  seed({ channel: "C1", ts: "10.1" });
  for (let i = 1; i <= 4; i += 1) {
    seed({ channel: "C1", ts: `10.${i + 1}`, thread_ts: "10.1" });
  }
  const first = await client.conversations.replies({ channel: "C1", ts: "10.1" });
  const cursor = first.response_metadata.next_cursor;
  assert.strictEqual(typeof cursor, "string");
  assert.ok(cursor.length > 0);
  assert.ok(!/^\d+$/.test(cursor), "a bare number reads as an offset");
});

test("a cursor Slack never issued is rejected as invalid_cursor", async () => {
  const { client, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  for (const cursor of ["2", "not a cursor", "!!!"]) {
    await assert.rejects(
      client.conversations.replies({ channel: "C1", ts: "10.1", cursor }),
      (error) =>
        error.code === "slack_webapi_platform_error" &&
        error.data.error === "invalid_cursor",
    );
    await assert.rejects(
      client.conversations.history({ channel: "C1", cursor }),
      (error) => error.data.error === "invalid_cursor",
    );
  }
});

test("history pages newest first with the cursor, and the last page has none", async () => {
  const { client, seed } = createFakeSlack();
  for (const ts of ["10.1", "20.1", "30.1", "40.1", "50.1"]) {
    seed({ channel: "C1", ts });
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const result = await client.conversations.history({
      channel: "C1",
      limit: 2,
      cursor,
    });
    pages += 1;
    seen.push(...result.messages.map((m) => m.ts));
    cursor = result.response_metadata.next_cursor;
    assert.strictEqual(result.has_more, cursor !== "");
  } while (cursor);
  assert.strictEqual(pages, 3);
  assert.deepStrictEqual(seen, ["50.1", "40.1", "30.1", "20.1", "10.1"]);
});

test("success responses use Slack's shapes: ok, string ts with six decimals, channel", async () => {
  const { client, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "1700000000.000500" });
  const posted = await client.chat.postMessage({
    channel: "C1",
    thread_ts: "1700000000.000500",
    markdown_text: "hi",
  });
  assert.strictEqual(posted.ok, true);
  assert.strictEqual(posted.channel, "C1");
  assert.match(posted.ts, /^\d{10}\.\d{6}$/);
  assert.strictEqual(posted.message.ts, posted.ts);

  const react = { channel: "C1", timestamp: "1700000000.000500", name: "x" };
  assert.deepStrictEqual(await client.reactions.add(react), { ok: true });
  assert.deepStrictEqual(await client.reactions.remove(react), { ok: true });

  const deleted = await client.chat.delete({ channel: "C1", ts: posted.ts });
  assert.deepStrictEqual(deleted, { ok: true, channel: "C1", ts: posted.ts });

  const history = await client.conversations.history({ channel: "C1" });
  assert.strictEqual(history.ok, true);
  assert.ok(Array.isArray(history.messages));
  assert.strictEqual(typeof history.has_more, "boolean");
  assert.match(history.messages[0].ts, /^\d{10}\.\d{6}$/);
});

test("update changes text and keeps reactions unless they are set", async () => {
  const { seed, update, message } = createFakeSlack();
  const reactions = [{ name: "x", users: ["U9"], count: 1 }];
  seed({ channel: "C1", ts: "10.1", text: "old", reactions });
  update("10.1", { text: "new" });
  assert.strictEqual(message("10.1").text, "new");
  assert.deepStrictEqual(message("10.1").reactions, reactions);
  update("10.1", { reactions: [] });
  assert.deepStrictEqual(message("10.1").reactions, []);
});

test("seed replaces a stored message with the same ts", () => {
  const { seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1", text: "a" });
  seed({ channel: "C1", ts: "10.1", text: "b" });
  assert.strictEqual(message("10.1").text, "b");
});

test("returned and seeded messages are copies of the store", async () => {
  const { client, seed, message } = createFakeSlack();
  const seeded = { channel: "C1", ts: "10.1", text: "a" };
  seed(seeded);
  seeded.text = "changed";
  assert.strictEqual(message("10.1").text, "a");

  message("10.1").text = "changed";
  const [fromHistory] = (await client.conversations.history({ channel: "C1" }))
    .messages;
  fromHistory.text = "changed";
  const { messages } = await client.conversations.replies({
    channel: "C1",
    ts: "10.1",
  });
  messages[0].text = "changed";
  assert.strictEqual(message("10.1").text, "a");
});

test("hold with after false leaves the store untouched until release", async () => {
  const { client, calls, hold, seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  const held = hold("chat.delete", 1);
  let settled = false;
  const pending = client.chat
    .delete({ channel: "C1", ts: "10.1" })
    .then((response) => {
      settled = true;
      return response;
    });
  await held.reached;
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, "chat.delete");
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(settled, false);
  assert.ok(message("10.1"));

  held.release();
  assert.deepStrictEqual(await pending, {
    ok: true,
    channel: "C1",
    ts: "10.1",
  });
  assert.strictEqual(message("10.1"), undefined);
});

test("hold with after true changes the store at once and answers on release", async () => {
  const { client, hold, seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  const held = hold("chat.delete", 1, { after: true });
  let settled = false;
  const pending = client.chat
    .delete({ channel: "C1", ts: "10.1" })
    .then((response) => {
      settled = true;
      return response;
    });
  await held.reached;
  assert.strictEqual(message("10.1"), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(settled, false);

  held.release();
  assert.deepStrictEqual(await pending, {
    ok: true,
    channel: "C1",
    ts: "10.1",
  });
});

test("a held call still fails or answers as configured once released", async () => {
  const { client, fail, hold, respond, seed } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  fail("reactions.add", 1, "too_many_emoji");
  const failing = hold("reactions.add", 1);
  const args = { channel: "C1", timestamp: "10.1", name: "x" };
  const first = client.reactions.add(args);
  const failed = assert.rejects(
    first,
    (error) => error.data.error === "too_many_emoji",
  );
  await failing.reached;
  failing.release();
  await failed;

  respond("auth.test", 1, { ok: true, user_id: "UOTHER" });
  const answering = hold("auth.test", 1, { after: true });
  const second = client.auth.test();
  await answering.reached;
  answering.release();
  assert.strictEqual((await second).user_id, "UOTHER");
});

test("calls that are not held behave as before while another is held", async () => {
  const { client, hold, seed, message } = createFakeSlack();
  seed({ channel: "C1", ts: "10.1" });
  seed({ channel: "C1", ts: "10.2" });
  const held = hold("chat.delete", 2);
  await client.chat.delete({ channel: "C1", ts: "10.1" });
  assert.strictEqual(message("10.1"), undefined);
  const pending = client.chat.delete({ channel: "C1", ts: "10.2" });
  await held.reached;
  assert.ok(message("10.2"));
  held.release();
  await pending;
  assert.strictEqual(message("10.2"), undefined);
  await assert.rejects(
    client.chat.delete({ channel: "C1", ts: "10.2" }),
    (error) => error.data.error === "message_not_found",
  );
});
