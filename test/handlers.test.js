import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { classifyEvent, createMessageHandler } from "../src/handlers.js";
import { nudgeText } from "../src/nudge.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { createLogGuard, SECRET } from "./helpers/log-guard.js";

const RULES = "https://example.com/rules";
const image = { id: "F1", mimetype: "image/png", filetype: "png" };

// A message event as Slack sends it: its own ts and event_ts, the channel type, the author.
const post = (extra = {}) => {
  const ts = extra.ts ?? "1.1";
  return {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "UMEMBER",
    ts,
    event_ts: ts,
    text: "FS",
    ...extra,
  };
};

// A message_changed event as Slack sends it: hidden, with its own ts and event_ts,
// no text of its own, the changed message nested under the original ts, and the
// message as it was before.
const edit = (message) => ({
  type: "message",
  subtype: "message_changed",
  hidden: true,
  channel: "C1",
  channel_type: "channel",
  ts: "1.2",
  event_ts: "1.2",
  message,
  previous_message: { type: "message", user: "UMEMBER", ts: "1.1", text: "FS [US] Widget $10" },
});
// A change that is not an edit (a thread reply count, a link unfurl) has no `edited`.
const unedited = (extra = {}) => edit({ type: "message", user: "UMEMBER", ts: "1.1", text: "FS", ...extra });
const goodEdit = (extra = {}) => unedited({ edited: { user: "UMEMBER", ts: "1.2" }, ...extra });

// Every event the bot must ignore. Any top-level text on these is non-compliant,
// so only the classification keeps the handler from nudging.
const ignored = {
  "null": null,
  "undefined": undefined,
  "a number": 5,
  "a string": "x",
  "an array": [],
  "an empty object": {},
  "another channel": post({ channel: "C2" }),
  "a missing channel": { ts: "1.1", text: "FS" },
  "bot_message": post({ subtype: "bot_message" }),
  "thread_broadcast": post({ subtype: "thread_broadcast" }),
  "message_deleted": post({ subtype: "message_deleted" }),
  "channel_join": post({ subtype: "channel_join" }),
  "me_message": post({ subtype: "me_message" }),
  "a missing ts": { channel: "C1", text: "FS" },
  "a numeric ts": post({ ts: 5 }),
  "an empty ts": post({ ts: "" }),
  "a thread reply": post({ ts: "2.0", thread_ts: "1.0" }),
  "a bot_id": post({ bot_id: "B1" }),
  "a file_share with a bot_id": post({ subtype: "file_share", bot_id: "B1" }),
  "an edit with no message": { ...goodEdit(), message: undefined },
  "an edit with a null message": edit(null),
  "an edit with no text": edit({ ts: "1.1" }),
  "an edit with empty text": edit({ ts: "1.1", text: "" }),
  "an edit of a thread reply": goodEdit({ ts: "2.0", thread_ts: "1.0" }),
  "an edit by a bot_id": goodEdit({ bot_id: "B1" }),
  "an edit by a bot_message": goodEdit({ subtype: "bot_message" }),
  "an edit in another channel": { ...goodEdit(), channel: "C2" },
};

describe("classifyEvent", () => {
  for (const [name, event] of Object.entries(ignored)) {
    test(`ignores ${name}`, () => {
      assert.strictEqual(classifyEvent(event, "C1"), null);
    });
  }

  const fresh = {
    "a plain post": post(),
    "a file_share post": post({ subtype: "file_share" }),
    "a thread parent": post({ thread_ts: "1.1" }),
  };
  for (const [name, event] of Object.entries(fresh)) {
    test(`classifies ${name} as new`, () => {
      assert.strictEqual(classifyEvent(event, "C1"), "new");
    });
  }

  test("classifies a top-level human edit as edit", () => {
    assert.strictEqual(classifyEvent(goodEdit(), "C1"), "edit");
  });

  test("classifies a thread parent's reply-count change as edit", () => {
    const change = unedited({ thread_ts: "1.1", reply_count: 1, reply_users_count: 1 });
    assert.strictEqual(classifyEvent(change, "C1"), "edit");
  });

  test("classifies a link unfurl change as edit", () => {
    const change = unedited({
      attachments: [{ from_url: "https://example.com/widget", title: "Widget", id: 1 }],
    });
    assert.strictEqual(classifyEvent(change, "C1"), "edit");
  });
});

describe("message handler", () => {
  let fake;
  let handler;
  let guard;
  const run = (event) => {
    guard.watch(event);
    return handler({ event, client: fake.client });
  };
  const freshFake = () => {
    fake = guard.track(createFakeSlack());
    handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });
  };

  beforeEach((t) => {
    guard = createLogGuard(t);
    freshFake();
  });

  // Whatever a test makes fail, no log line carries a text, a response or a token.
  afterEach(() => guard.check());

  // A broken post, and a fixed one whose nudge is still up (the lamp and the bot's reply).
  const brokenPost = () => fake.seed({ channel: "C1", ts: "1.1", user: "UMEMBER", text: "FS" });
  const nudgedFixedPost = () => {
    fake.seed({
      channel: "C1",
      ts: "1.1",
      user: "UMEMBER",
      text: "FS [US] Widget $10",
      files: [image],
      reactions: [{ name: "rotating_light", users: ["UBOT"], count: 1 }],
    });
    fake.seed({ channel: "C1", ts: "1.2", thread_ts: "1.1", user: "UBOT", text: "BOT REPLY TEXT" });
  };

  // Slack-shaped success whose message is not in the thread, so the reply is rolled back.
  const unconfirmedReply = () =>
    fake.respond("chat.postMessage", 1, {
      ok: true,
      channel: "C1",
      ts: "1.9",
      message: { type: "message", user: "UBOT", ts: "1.9", text: "ECHOED REPLY" },
    });

  const reply = () => fake.calls.find((c) => c.method === "chat.postMessage").args;

  test("nudges a non-compliant new post with the lamp first", async () => {
    await run(post());
    const methods = fake.calls.map((c) => c.method);
    assert.ok(methods.includes("reactions.add") && methods.includes("chat.postMessage"));
    assert.ok(methods.indexOf("reactions.add") < methods.indexOf("chat.postMessage"));
    assert.strictEqual(reply().thread_ts, "1.1");
    assert.strictEqual(
      reply().markdown_text,
      nudgeText(["title", "location", "price", "photo"], RULES),
    );
  });

  test("a repeated new-post event is nudged at most 3 times", async () => {
    for (let n = 0; n < 4; n++) await run(post());
    const count = (name) => fake.calls.filter((c) => c.method === name).length;
    assert.strictEqual(count("chat.postMessage"), 3);
    assert.strictEqual(count("reactions.add"), 3);
  });

  test("simultaneous repeated new-post events are nudged at most 3 times", async () => {
    await Promise.all([0, 1, 2, 3].map(() => run(post())));
    const count = (name) => fake.calls.filter((c) => c.method === name).length;
    assert.strictEqual(count("chat.postMessage"), 3);
    assert.strictEqual(count("reactions.add"), 3);
  });

  test("nudges an image-only file_share as no_tag", async () => {
    const shared = {
      id: "F1",
      created: 1700000000,
      name: "widget.png",
      mimetype: "image/png",
      filetype: "png",
      mode: "hosted",
      size: 12345,
      url_private: "https://files.slack.com/files-pri/T1-F1/widget.png",
    };
    await run(post({ subtype: "file_share", text: "", upload: true, files: [shared] }));
    assert.strictEqual(reply().markdown_text, nudgeText(["no_tag"], RULES));
  });

  test("a null rules URL leaves no link in the reply", async () => {
    handler = createMessageHandler({ channelId: "C1", rulesUrl: null });
    await run(post());
    assert.ok(!reply().markdown_text.includes("]("));
  });

  test("a compliant post and chatter get no calls", async () => {
    await run(post({ text: "FS [US] Widget $10", files: [image] }));
    await run(post({ text: "anyone going to the meetup?" }));
    assert.strictEqual(fake.calls.length, 0);
  });

  test("a non-compliant post in another channel gets no calls", async () => {
    await run(post({ channel: "C2" }));
    assert.strictEqual(fake.calls.length, 0);
  });

  test("the author's id makes no difference to whether a post is nudged", async () => {
    const authors = ["UMEMBER", "UADMIN", "UOWNER", "UGUEST", "W0ENTERPRISE"];
    for (const [n, user] of authors.entries()) {
      const fresh = `${n + 2}.1`;
      await run(post({ ts: fresh, user }));
      const edited = `${n + 2}.2`;
      fake.seed({ channel: "C1", ts: edited, user, text: "FS" });
      await run(goodEdit({ ts: edited, user }));
    }
    const replies = fake.calls.filter((c) => c.method === "chat.postMessage");
    assert.deepStrictEqual(
      replies.map((c) => c.args.thread_ts).sort(),
      authors.flatMap((_, n) => [`${n + 2}.1`, `${n + 2}.2`]).sort(),
    );
  });

  test("every ignored event gets no calls", async () => {
    for (const event of Object.values(ignored)) await run(event);
    assert.strictEqual(fake.calls.length, 0);
  });

  test("member text cannot reach the reply", async () => {
    await run(post({ text: "FS <@U123> <!channel> [x](https://evil.example)" }));
    const text = reply().markdown_text;
    for (const bad of ["<@U123>", "<!channel>", "[x](https://evil.example)", "evil.example"]) {
      assert.ok(!text.includes(bad), bad);
    }
  });

  test("resolves when every Slack method fails", async () => {
    for (const name of ["reactions.add", "chat.postMessage", "chat.delete", "reactions.remove"]) {
      fake.fail(name, 1);
    }
    await assert.doesNotReject(run(post()));
  });

  describe("an edit resolves when any Slack call it makes fails", () => {
    const changing = ["reactions.add", "chat.postMessage", "chat.delete", "reactions.remove"];
    const changes = () => fake.calls.map((c) => c.method).filter((m) => changing.includes(m));

    test("a failed refetch changes nothing and the next edit is judged afresh", async () => {
      brokenPost();
      fake.fail("conversations.history", 1);
      await assert.doesNotReject(run(goodEdit()));
      assert.deepStrictEqual(changes(), []);

      await run(goodEdit());
      assert.ok(changes().includes("chat.postMessage"));
    });

    test("failed cleanup calls leave the lamp up until the retries finish", async () => {
      nudgedFixedPost();
      fake.fail("conversations.replies", 1);
      fake.fail("chat.delete", 1);
      fake.fail("reactions.remove", 1);
      for (let i = 0; i < 3; i++) await assert.doesNotReject(run(goodEdit()));
      assert.strictEqual(fake.thread("1.1").length, 0);
      assert.strictEqual(fake.message("1.1").reactions.length, 1);

      await run(goodEdit());
      assert.strictEqual((fake.message("1.1").reactions ?? []).length, 0);
    });

    test("a failed lamp, delete and lamp removal after an unconfirmed reply", async () => {
      brokenPost();
      fake.fail("reactions.add", 1);
      unconfirmedReply();
      fake.fail("chat.delete", 1);
      fake.fail("reactions.remove", 1);
      await assert.doesNotReject(run(goodEdit()));
      const methods = fake.calls.map((c) => c.method);
      assert.deepStrictEqual(methods.slice(methods.indexOf("reactions.add"), methods.indexOf("reactions.add") + 2), [
        "reactions.add",
        "chat.postMessage",
      ]);
      assert.ok(methods.includes("chat.delete") && methods.includes("reactions.remove"));
    });
  });

  // An error as the Slack client raises it, with the token in its message and in
  // the request it keeps. Each Slack call the handler makes gets one in turn, and
  // the guard checks that no log line carries the token, the texts or the error.
  describe("a token-bearing error from each Slack call", () => {
    const tokenError = () =>
      Object.assign(new Error(`An API error occurred: invalid_auth ${SECRET}`), {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "invalid_auth" },
        original: { config: { headers: { Authorization: `Bearer ${SECRET}` } } },
      });
    const failWithToken = (name) => {
      const [group, fn] = name.split(".");
      fake.client[group][fn] = async (args) => {
        fake.calls.push({ method: name, args: { ...args } });
        throw tokenError();
      };
    };
    const cases = [
      ["auth.test", "auth.test", () => brokenPost(), () => goodEdit()],
      ["conversations.history", "conversations.history", () => brokenPost(), () => goodEdit()],
      ["reactions.add", "reactions.add", () => brokenPost(), () => post()],
      ["chat.postMessage", "chat.postMessage", () => brokenPost(), () => post()],
      ["chat.delete after an unconfirmed reply", "chat.delete", () => (brokenPost(), unconfirmedReply()), () => post()],
      ["reactions.remove after an unconfirmed reply", "reactions.remove", () => (brokenPost(), unconfirmedReply()), () => post()],
      ["conversations.replies during cleanup", "conversations.replies", () => nudgedFixedPost(), () => goodEdit()],
      ["chat.delete during cleanup", "chat.delete", () => nudgedFixedPost(), () => goodEdit()],
      ["reactions.remove during cleanup", "reactions.remove", () => nudgedFixedPost(), () => goodEdit()],
    ];

    for (const [name, method, setup, event] of cases) {
      test(`${name} is logged by its code alone`, async () => {
        setup();
        failWithToken(method);
        await assert.doesNotReject(run(event()));
        assert.ok(guard.lines().some((line) => /failed: invalid_auth$/.test(line)));
      });
    }
  });
});
