import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { createMessageHandler } from "../src/handlers.js";
import { changeEvent } from "./helpers/events.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { createLogGuard } from "./helpers/log-guard.js";

const RULES = "https://example.com/rules";
const image = { id: "F1", mimetype: "image/png", filetype: "png" };
const GOOD = { text: "FS [US] Widget $10", files: [image] };
const BAD = { text: "FS", files: [] };

const P = "100.000001";
const R = "100.000002";
const M = "100.000003";
const EVENT_TS = "200.000001";

// Events that overlap on one post: one event is held part-way through a Slack
// call while another runs, then the first goes on.
describe("events racing on one post", { timeout: 5000 }, () => {
  let fake;
  let handler;
  let guard;
  const run = (event) => {
    guard.watch(event);
    return handler({ event, client: fake.client });
  };

  // Updates the post and returns the event Slack sends for that edit.
  const edit = (fields) => {
    const before = fake.message(P);
    fake.update(P, fields);
    const edited = { edited: { user: "UMEMBER", ts: EVENT_TS } };
    return changeEvent(before, fake.message(P), edited, EVENT_TS);
  };

  // The event for a change to the thread's reply count; it is not an edit.
  const threadChanged = (replyCount) => {
    const before = fake.message(P);
    fake.update(P, { reply_count: replyCount, reply_users_count: 1 });
    return changeEvent(before, fake.message(P), {}, EVENT_TS);
  };

  const botReplies = () => fake.thread(P).filter((m) => m.user === "UBOT");
  const lamped = () => fake.message(P).reactions ?? [];
  const calls = (name) => fake.calls.filter((c) => c.method === name);

  const lamp = (...users) => [{ name: "rotating_light", users, count: users.length }];

  // A non-compliant post carrying the bot's lamp, with one bot reply and one
  // member reply in its thread.
  const nudgedPost = () => {
    fake.seed({
      channel: "C1",
      ts: P,
      user: "UMEMBER",
      ...BAD,
      thread_ts: P,
      reply_count: 2,
      reply_users_count: 2,
      reactions: lamp("UBOT"),
    });
    fake.seed({ channel: "C1", ts: R, thread_ts: P, user: "UBOT", bot_id: "BBOT", text: "BOT REPLY TEXT" });
    fake.seed({ channel: "C1", ts: M, thread_ts: P, user: "UMEMBER", text: "INTERESTED" });
  };

  // Every case ends with the member's reply in place, the post still there,
  // and nothing of the bot's left in its thread.
  const cleanedUp = () => {
    assert.ok(fake.message(P));
    assert.deepStrictEqual(
      fake.thread(P).map((m) => m.ts),
      [M],
    );
    assert.strictEqual(botReplies().length, 0);
    assert.strictEqual(lamped().length, 0);
  };

  beforeEach((t) => {
    guard = createLogGuard(t);
    fake = guard.track(createFakeSlack());
    handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });
    nudgedPost();
  });

  afterEach(() => guard.check());

  test("a fix delivered twice, overlapping, deletes only the bot's reply and ends clean", async () => {
    const fix = edit(GOOD);
    const held = fake.hold("chat.delete", 1);
    const first = run(fix);
    await held.reached;
    await run(fix);
    cleanedUp();

    held.release();
    await first;
    cleanedUp();
    for (const call of calls("chat.delete")) {
      assert.strictEqual(call.args.ts, R);
    }
  });

  test("the thread change that deleting the reply causes does not repeat the cleanup", async () => {
    const fix = edit(GOOD);
    const held = fake.hold("chat.delete", 1, { after: true });
    const first = run(fix);
    await held.reached;
    assert.deepStrictEqual(
      fake.thread(P).map((m) => m.ts),
      [M],
    );
    await run(threadChanged(1));
    cleanedUp();

    held.release();
    await first;
    cleanedUp();
    assert.strictEqual(calls("chat.delete").length, 1);
    assert.strictEqual(calls("chat.delete")[0].args.ts, R);
  });

  test("a post broken again while its cleanup is in flight ends clean and is nudged by its next edit", async () => {
    const fix = edit(GOOD);
    const held = fake.hold("conversations.replies", 1);
    const first = run(fix);
    await held.reached;
    await run(edit(BAD));
    assert.strictEqual(calls("chat.postMessage").length, 0);

    held.release();
    await first;
    assert.strictEqual(fake.message(P).text, BAD.text);
    cleanedUp();
    assert.strictEqual(calls("chat.postMessage").length, 0);

    await run(edit({ text: "FS Widget" }));
    assert.strictEqual(botReplies().length, 1);
    assert.strictEqual(lamped().length, 1);
    assert.deepStrictEqual(lamped()[0].users, ["UBOT"]);
    assert.ok(fake.thread(P).some((m) => m.ts === M));
  });
});

// A new post's nudge is in flight (held part-way through a Slack call) when
// the member edits the post. Each case holds the nudge at one call, runs the
// edit to completion, then lets the nudge go on.
describe("an edit racing a new post's nudge", { timeout: 5000 }, () => {
  let fake;
  let handler;
  let guard;
  const run = (event) => {
    guard.watch(event);
    return handler({ event, client: fake.client });
  };

  const newPost = () => ({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "UMEMBER",
    ts: P,
    event_ts: P,
    text: BAD.text,
  });

  const edit = (fields) => {
    const before = fake.message(P);
    fake.update(P, fields);
    const edited = { edited: { user: "UMEMBER", ts: EVENT_TS } };
    return changeEvent(before, fake.message(P), edited, EVENT_TS);
  };

  const botReplies = () => fake.thread(P).filter((m) => m.user === "UBOT");
  const lamped = () => (fake.message(P).reactions ?? []).length > 0;
  const calls = (name) => fake.calls.filter((c) => c.method === name);

  const BROKEN = { text: "FS Widget" };

  // Holds the nudge's nth call of a method, runs the edit while it waits,
  // then releases it. What every case must keep: both events resolve, the
  // post and the member's reply stay, the bot deletes nothing of anyone
  // else's, and the post gets at most 3 nudges.
  async function race(method, after, fields) {
    const held = fake.hold(method, 1, { after });
    const nudge = run(newPost());
    await held.reached;
    await run(edit(fields));
    held.release();
    await nudge;

    assert.ok(fake.message(P));
    assert.ok(fake.thread(P).some((m) => m.ts === M));
    for (const call of calls("chat.delete")) {
      assert.notStrictEqual(call.args.ts, P);
      assert.notStrictEqual(call.args.ts, M);
    }
    assert.ok(calls("chat.postMessage").length <= 3);
  }

  const noBotTrace = () => {
    assert.strictEqual(botReplies().length, 0);
    assert.strictEqual(lamped(), false);
  };

  beforeEach((t) => {
    guard = createLogGuard(t);
    fake = guard.track(createFakeSlack());
    handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });
    fake.seed({ channel: "C1", ts: P, user: "UMEMBER", ...BAD });
    fake.seed({ channel: "C1", ts: M, thread_ts: P, user: "UMEMBER", text: "INTERESTED" });
  });

  afterEach(() => guard.check());

  test("a post fixed before the nudge's lamp lands keeps the lamp and the nudge until its next edit", async () => {
    await race("reactions.add", false, GOOD);
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 1);

    await run(edit(GOOD));
    noBotTrace();
    assert.ok(fake.thread(P).some((m) => m.ts === M));
  });

  test("a post broken again before the nudge's lamp lands is nudged twice, within the cap", async () => {
    await race("reactions.add", false, BROKEN);
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 2);
    assert.strictEqual(calls("chat.postMessage").length, 2);
  });

  test("a post fixed after the lamp lands but before the reply is asked for ends with an orphan reply and no lamp", async () => {
    await race("reactions.add", true, GOOD);
    assert.strictEqual(lamped(), false);
    assert.strictEqual(botReplies().length, 1);

    await run(edit(GOOD));
    assert.strictEqual(botReplies().length, 1);

    await run(edit(BROKEN));
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 2);
    await run(edit(GOOD));
    noBotTrace();
    assert.ok(fake.thread(P).some((m) => m.ts === M));
  });

  test("a post left broken after the lamp lands but before the reply is asked for keeps its lamp and one reply", async () => {
    await race("reactions.add", true, BROKEN);
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 1);
  });

  test("a post fixed before the reply is posted ends with an orphan reply and no lamp", async () => {
    await race("chat.postMessage", false, GOOD);
    assert.strictEqual(lamped(), false);
    assert.strictEqual(botReplies().length, 1);

    await run(edit(BROKEN));
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 2);
    await run(edit(GOOD));
    noBotTrace();
    assert.ok(fake.thread(P).some((m) => m.ts === M));
  });

  test("a post left broken before the reply is posted keeps its lamp and one reply", async () => {
    await race("chat.postMessage", false, BROKEN);
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 1);
  });

  test("a post fixed after the reply is posted but before Slack answers loses the reply and the lamp", async () => {
    await race("chat.postMessage", true, GOOD);
    noBotTrace();
  });

  test("a post left broken after the reply is posted but before Slack answers keeps its lamp and one reply", async () => {
    await race("chat.postMessage", true, BROKEN);
    assert.strictEqual(lamped(), true);
    assert.strictEqual(botReplies().length, 1);
  });
});
