import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { createMessageHandler } from "../src/handlers.js";
import { nudgeText } from "../src/nudge.js";
import { changeEvent } from "./helpers/events.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { createLogGuard } from "./helpers/log-guard.js";

const RULES = "https://example.com/rules";
const image = { id: "F1", mimetype: "image/png", filetype: "png" };
const GOOD = { text: "FS [US] Widget $10", files: [image] };
const BAD = { text: "FS" };

describe("edit lifecycle scenarios", () => {
  let fake;
  let handler;
  let guard;
  const logs = () => guard.lines();
  const run = (event) => {
    guard.watch(event);
    return handler({ event, client: fake.client });
  };
  const useFake = (options) => {
    fake = guard.track(createFakeSlack(options));
  };

  const postNew = async (ts, msg) => {
    const message = { channel: "C1", ts, user: "UMEMBER", ...msg };
    fake.seed(message);
    await run({ ...message, type: "message", channel_type: "channel", event_ts: ts });
  };

  const editTo = async (ts, fields) => {
    const before = fake.message(ts);
    fake.update(ts, fields);
    const edited = { edited: { user: "UMEMBER", ts: "100.999999" } };
    await run(changeEvent(before, fake.message(ts), edited));
  };

  // A reply was added to the post: the parent now carries thread_ts equal to its
  // own ts and a reply count, and the event is a change that is not an edit.
  const replyAdded = async (ts) => {
    const before = fake.message(ts);
    fake.seed({ channel: "C1", ts: `${ts}9`, thread_ts: ts, user: "UMEMBER", text: "INTERESTED" });
    const counts = { thread_ts: ts, reply_count: fake.thread(ts).length, reply_users_count: 2 };
    fake.update(ts, counts);
    await run(changeEvent(before, fake.message(ts)));
  };

  // A link in the post was unfurled: attachments added, text unchanged, no `edited`.
  const unfurled = async (ts) => {
    const before = fake.message(ts);
    fake.update(ts, {
      attachments: [{ id: 1, from_url: "https://example.com/widget", title: "Widget", service_name: "example" }],
    });
    await run(changeEvent(before, fake.message(ts)));
  };

  const botReplies = (ts) => fake.thread(ts).filter((m) => m.user === "UBOT");
  const lamped = (ts) => fake.message(ts).reactions ?? [];
  const methodCalls = (name) => fake.calls.filter((c) => c.method === name).length;

  const lamp = (...users) => [{ name: "rotating_light", users, count: users.length }];
  const botReply = (ts, n) => ({
    channel: "C1",
    ts: `1700000000.9000${n}`,
    thread_ts: ts,
    user: "UBOT",
    text: "BOT REPLY TEXT",
  });

  beforeEach((t) => {
    guard = createLogGuard(t);
    useFake();
    handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });
  });

  // Whatever a scenario makes fail, no log line carries a text, a response or a token.
  afterEach(() => guard.check());

  describe("nudge cap", () => {
    const BAD_EDIT = { text: "FS", files: [] };
    // The only logged lines in these scenarios that are not failures are cap notices.
    const capLogs = () => logs().filter((line) => !/ failed: /.test(line));

    const capPost = async (ts) => {
      await postNew(ts, BAD);
      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
    };

    test("a post toggled between broken and fixed is nudged at most 3 times", async () => {
      const ts = "100.000001";
      await capPost(ts);
      assert.strictEqual(methodCalls("chat.postMessage"), 3);
      assert.strictEqual(botReplies(ts).length, 1);

      await editTo(ts, GOOD);
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);

      await editTo(ts, BAD_EDIT);
      assert.strictEqual(methodCalls("chat.postMessage"), 3);
      assert.strictEqual(methodCalls("reactions.add"), 3);
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);
      assert.strictEqual(capLogs().length, 1);

      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
      assert.strictEqual(methodCalls("chat.postMessage"), 3);
      assert.strictEqual(methodCalls("reactions.add"), 3);
      assert.strictEqual(capLogs().length, 1);
    });

    test("a failed nudge attempt counts toward the cap", async () => {
      const ts = "100.000001";
      fake.fail("chat.postMessage", 1);
      await postNew(ts, BAD);
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);

      await editTo(ts, {});
      assert.strictEqual(botReplies(ts).length, 1);
      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
      assert.strictEqual(methodCalls("chat.postMessage"), 3);
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);
      assert.strictEqual(capLogs().length, 1);
    });

    test("a nudge whose lamp failed is repeated by the next non-compliant edit and counts toward the cap", async () => {
      const ts = "100.000001";
      for (const n of [1, 2, 3]) fake.fail("reactions.add", n);
      await postNew(ts, BAD);
      assert.strictEqual(botReplies(ts).length, 1);
      assert.strictEqual(lamped(ts).length, 0);

      await editTo(ts, {});
      assert.strictEqual(botReplies(ts).length, 2);
      await editTo(ts, {});
      assert.strictEqual(botReplies(ts).length, 3);

      await editTo(ts, {});
      assert.strictEqual(methodCalls("chat.postMessage"), 3);
      assert.strictEqual(methodCalls("reactions.add"), 3);
      assert.strictEqual(botReplies(ts).length, 3);
      assert.strictEqual(capLogs().length, 1);
    });

    test("the cap is per post", async () => {
      const first = "100.000001";
      const second = "100.000002";
      await capPost(first);
      await postNew(second, BAD);
      assert.strictEqual(botReplies(second).length, 1);
      assert.strictEqual(lamped(second).length, 1);

      await editTo(first, GOOD);
      await editTo(first, BAD_EDIT);
      assert.strictEqual(methodCalls("chat.postMessage"), 4);
      assert.strictEqual(methodCalls("reactions.add"), 4);
      assert.strictEqual(botReplies(first).length, 0);
      assert.strictEqual(lamped(first).length, 0);
      assert.strictEqual(capLogs().length, 1);
    });

    test("the cap is logged once for each capped post", async () => {
      const first = "100.000001";
      const second = "100.000002";
      await capPost(first);
      await capPost(second);
      for (const ts of [first, second]) {
        await editTo(ts, GOOD);
        await editTo(ts, BAD_EDIT);
      }
      assert.strictEqual(capLogs().length, 2);
      assert.strictEqual(methodCalls("chat.postMessage"), 6);
    });

    test("a restart starts every post's count afresh", async () => {
      const ts = "100.000001";
      await capPost(ts);
      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
      assert.strictEqual(methodCalls("chat.postMessage"), 3);
      assert.strictEqual(capLogs().length, 1);

      handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });
      await editTo(ts, GOOD);
      await editTo(ts, BAD_EDIT);
      assert.strictEqual(methodCalls("chat.postMessage"), 4);
      assert.strictEqual(botReplies(ts).length, 1);
      assert.strictEqual(lamped(ts).length, 1);
    });
  });

  test("a post is nudged, cleaned up when fixed, and nudged again when broken again", async () => {
    const ts = "100.000001";
    await postNew(ts, BAD);
    assert.strictEqual(botReplies(ts).length, 1);
    assert.strictEqual(lamped(ts).length, 1);

    await editTo(ts, { text: "FS Widget" });
    assert.strictEqual(botReplies(ts).length, 1);

    fake.seed({ channel: "C1", ts: "100.000002", thread_ts: ts, user: "UMEMBER", text: "INTERESTED" });
    await editTo(ts, GOOD);
    assert.strictEqual(botReplies(ts).length, 0);
    assert.strictEqual(fake.thread(ts).length, 1);
    assert.strictEqual(fake.thread(ts)[0].user, "UMEMBER");
    assert.strictEqual(lamped(ts).length, 0);

    await editTo(ts, { text: "FS", files: [] });
    assert.strictEqual(botReplies(ts).length, 1);
    assert.strictEqual(lamped(ts).length, 1);
  });

  test("a compliant post gets no calls and an edit into non-compliance is nudged", async () => {
    const ts = "100.000001";
    await postNew(ts, GOOD);
    assert.strictEqual(fake.calls.length, 0);

    await editTo(ts, { text: "FS", files: [] });
    assert.strictEqual(botReplies(ts).length, 1);
    assert.strictEqual(lamped(ts).length, 1);
  });

  test("an edit that leaves exactly one problem is nudged", async () => {
    const ts = "100.000001";
    await postNew(ts, GOOD);
    await editTo(ts, { text: "FS [US] Widget" });
    const posts = fake.calls.filter((c) => c.method === "chat.postMessage");
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].args.markdown_text, nudgeText(["price"], RULES));
    assert.strictEqual(botReplies(ts).length, 1);
    assert.strictEqual(lamped(ts).length, 1);
  });

  test("a restart forgets the bot id and asks for it again", async () => {
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...GOOD });
    await editTo(ts, {});
    assert.strictEqual(methodCalls("auth.test"), 1);
    await editTo(ts, {});
    assert.strictEqual(methodCalls("auth.test"), 1);

    handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });
    await editTo(ts, {});
    assert.strictEqual(methodCalls("auth.test"), 2);
  });

  describe("message_changed events that are not edits", () => {
    const nothingChanged = () => {
      assert.strictEqual(methodCalls("chat.delete"), 0);
      assert.strictEqual(methodCalls("reactions.remove"), 0);
    };

    const changes = { "a reply added": replyAdded, "a link unfurl": unfurled };

    for (const [name, change] of Object.entries(changes)) {
      test(`${name} on a nudged post leaves the one reply and the lamp`, async () => {
        const ts = "100.000001";
        await postNew(ts, BAD);
        assert.strictEqual(botReplies(ts).length, 1);

        await change(ts);
        assert.ok(methodCalls("conversations.history") >= 1);
        assert.strictEqual(methodCalls("chat.postMessage"), 1);
        assert.strictEqual(methodCalls("reactions.add"), 1);
        nothingChanged();
        assert.strictEqual(botReplies(ts).length, 1);
        assert.strictEqual(lamped(ts).length, 1);
        assert.deepStrictEqual(lamped(ts)[0].users, ["UBOT"]);
      });

      test(`${name} on a compliant post makes no post, delete or reaction call`, async () => {
        const ts = "100.000001";
        await postNew(ts, GOOD);
        await change(ts);
        assert.ok(methodCalls("conversations.history") >= 1);
        assert.strictEqual(methodCalls("chat.postMessage"), 0);
        assert.strictEqual(methodCalls("reactions.add"), 0);
        nothingChanged();
      });
    }

    test("a link unfurl on a non-compliant post with no lamp is nudged once", async () => {
      const ts = "100.000001";
      fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD });
      await unfurled(ts);
      assert.strictEqual(methodCalls("chat.postMessage"), 1);
      assert.strictEqual(botReplies(ts).length, 1);
      assert.deepStrictEqual(lamped(ts)[0].users, ["UBOT"]);
    });
  });

  test("another user's lamp does not stop a nudge", async () => {
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD, reactions: lamp("UOTHER") });
    await editTo(ts, {});
    assert.strictEqual(botReplies(ts).length, 1);
    assert.deepStrictEqual(lamped(ts)[0].users.sort(), ["UBOT", "UOTHER"]);
  });

  test("another user's lamp is left alone when the post is fixed", async () => {
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD, reactions: lamp("UOTHER") });
    await editTo(ts, GOOD);
    for (const name of ["chat.postMessage", "reactions.add", "chat.delete", "reactions.remove"]) {
      assert.strictEqual(methodCalls(name), 0, name);
    }
    assert.deepStrictEqual(lamped(ts)[0].users, ["UOTHER"]);
  });

  test("cleanup pages through every reply", async () => {
    useFake({ pageSize: 2 });
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD, reactions: lamp("UBOT") });
    for (let n = 1; n <= 5; n++) fake.seed(botReply(ts, n));
    await editTo(ts, GOOD);
    assert.strictEqual(botReplies(ts).length, 0);
    assert.strictEqual(lamped(ts).length, 0);
  });

  describe("partial cleanup retries", () => {
    test("a failed reply listing leaves everything and the next edit finishes", async () => {
      const ts = "100.000001";
      await postNew(ts, BAD);
      fake.fail("conversations.replies", 1);
      await editTo(ts, GOOD);
      assert.strictEqual(botReplies(ts).length, 1);
      assert.strictEqual(lamped(ts).length, 1);

      await editTo(ts, {});
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);
    });

    test("a failed delete keeps the lamp and the next edit finishes", async () => {
      const ts = "100.000001";
      await postNew(ts, BAD);
      fake.seed(botReply(ts, 1));
      assert.strictEqual(botReplies(ts).length, 2);

      fake.fail("chat.delete", 1);
      await editTo(ts, GOOD);
      assert.strictEqual(botReplies(ts).length, 1);
      assert.strictEqual(lamped(ts).length, 1);

      await editTo(ts, {});
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);
    });

    test("a failed later page of the reply listing deletes nothing and the next edit finishes", async () => {
      useFake({ pageSize: 2 });
      const ts = "100.000001";
      fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD, reactions: lamp("UBOT") });
      for (let n = 1; n <= 5; n++) fake.seed(botReply(ts, n));
      fake.fail("conversations.replies", 2);
      await editTo(ts, GOOD);
      assert.strictEqual(botReplies(ts).length, 5);
      assert.strictEqual(lamped(ts).length, 1);

      await editTo(ts, {});
      assert.strictEqual(botReplies(ts).length, 0);
      assert.strictEqual(lamped(ts).length, 0);
    });

    test("while the lamp is still on, a non-compliant edit posts nothing", async () => {
      const ts = "100.000001";
      await postNew(ts, BAD);
      fake.fail("conversations.replies", 1);
      await editTo(ts, GOOD);
      const posts = methodCalls("chat.postMessage");

      await editTo(ts, { text: "FS", files: [] });
      assert.strictEqual(methodCalls("chat.postMessage"), posts);
      assert.strictEqual(botReplies(ts).length, 1);
    });
  });

  test("a failed bot id lookup fails closed, retries, then caches", async () => {
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD });
    fake.fail("auth.test", 1);
    await editTo(ts, {});
    assert.deepStrictEqual(fake.calls.map((c) => c.method), ["auth.test"]);
    assert.strictEqual(logs().length, 1);
    assert.match(logs()[0], /failed: fatal_error$/);

    await editTo(ts, {});
    assert.strictEqual(methodCalls("auth.test"), 2);
    assert.strictEqual(botReplies(ts).length, 1);

    await editTo(ts, {});
    assert.strictEqual(methodCalls("auth.test"), 2);
  });

  test("a bot id answer without a user id fails closed", async () => {
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD });
    fake.respond("auth.test", 1, {
      ok: true,
      url: "https://acmeworkspace.slack.com/",
      team: "ACME WORKSPACE",
      user: "bstbot",
      team_id: "T1",
      bot_id: "B1",
    });
    await editTo(ts, {});
    assert.deepStrictEqual(fake.calls.map((c) => c.method), ["auth.test"]);
    assert.strictEqual(logs().length, 1);
  });

  test("a new post is nudged even while auth.test fails", async () => {
    fake.fail("auth.test", 1);
    await postNew("100.000001", BAD);
    assert.strictEqual(methodCalls("auth.test"), 0);
    assert.strictEqual(botReplies("100.000001").length, 1);
  });

  test("a failed refetch on a fixed lamped post leaves the replies and the lamp", async () => {
    const ts = "100.000001";
    await postNew(ts, BAD);
    fake.fail("conversations.history", 1);
    await editTo(ts, GOOD);
    assert.strictEqual(botReplies(ts).length, 1);
    assert.strictEqual(lamped(ts).length, 1);
  });

  test("a refetch that returns another message posts nothing", async () => {
    const ts = "100.000001";
    fake.seed({ channel: "C1", ts, user: "UMEMBER", ...BAD });
    fake.respond("conversations.history", 1, {
      ok: true,
      messages: [{ type: "message", user: "UOTHER", ts: "999.000000", text: "ANOTHER POST TEXT" }],
    });
    await editTo(ts, {});
    assert.strictEqual(methodCalls("chat.postMessage"), 0);
    assert.strictEqual(methodCalls("reactions.add"), 0);
    assert.strictEqual(logs().length, 1);
  });

  test("the decision uses the refetched copy, not the event's", async () => {
    const ts = "100.000001";
    fake.seed({
      channel: "C1",
      ts,
      user: "UMEMBER",
      text: "FS [US] Widget $10",
      files: [image],
      reactions: lamp("UBOT"),
    });
    fake.seed(botReply(ts, 1));
    await editTo(ts, {});
    assert.strictEqual(botReplies(ts).length, 0);
    assert.strictEqual(lamped(ts).length, 0);
  });
});
