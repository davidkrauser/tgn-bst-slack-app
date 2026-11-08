import { describe, test } from "node:test";
import assert from "node:assert";
import { createMessageHandler } from "../src/handlers.js";
import { nudgeProblems, nudgeText } from "../src/nudge.js";
import { changeEvent } from "./helpers/events.js";
import { createFakeSlack } from "./helpers/fake-slack.js";
import { int, mulberry32, pick } from "./helpers/random.js";

const RULES = "https://example.com/rules";
const CODES = ["title", "location", "price", "photo", "photos", "wtb_photo", "no_tag"];
const MARKER_PREFIX = "zq";

// Fixed in the file, so a failure can be replayed from the seed and the case.
const NUDGE_TEXT_SEED = 20260118;
const MESSAGES_PER_SETTING = 400;

const marker = (rand) => MARKER_PREFIX + String(int(rand, 0, 99999999)).padStart(8, "0");

const PLAIN_PIECES = [
  "FS", "WTB", "WTS", "WTT", "FT", "ISO", "[US]", "(EU)", "$50", "900 EUR", "~$5~",
  "for sale", "selling", "looking for", "Widget", "mint", "boxed", "keyboard", "cable",
];
const TAGS = ["FS", "WTB", "WTS", "WTT", "FT", "ISO"];

const hostilePiece = (rand, m) =>
  pick(rand, [`<@U${m}>`, "<!channel>", `[x](https://${m}.example)`, `*${m}*`, m]);

function randomText(rand, markers) {
  const pieces = [];
  if (rand() < 0.65) pieces.push(pick(rand, TAGS));
  const count = int(rand, 1, 6);
  for (let i = 0; i < count; i++) pieces.push(pick(rand, PLAIN_PIECES));
  for (const m of markers) {
    pieces.splice(int(rand, 0, pieces.length), 0, hostilePiece(rand, m));
  }
  return pieces.join(" ");
}

function randomFiles(rand, markers) {
  const kind = int(rand, 0, 3);
  if (kind === 0) return undefined;
  if (kind === 1) return [];
  const files = [];
  for (let i = int(rand, 1, 3); i > 0; i--) {
    const m = pick(rand, markers);
    files.push({
      mimetype: pick(rand, ["image/png", "application/pdf"]),
      name: `${m}.png`,
      title: `${m} photo`,
      url_private: `https://files.example/${m}/private`,
      permalink: `https://files.example/${m}/permalink`,
    });
  }
  return files;
}

// A new-post event as Slack sends it, with a marker in every field a member
// controls. Returns the event and the markers it carries.
function randomPost(rand, n) {
  const markers = Array.from({ length: int(rand, 1, 3) }, () => marker(rand));
  const m = () => pick(rand, markers);
  const event = {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: `U${m()}`,
    ts: `1700000100.${String(n).padStart(6, "0")}`,
    text: randomText(rand, markers),
    user_profile: { real_name: m(), display_name: m() },
    blocks: [{ type: "rich_text", block_id: m(), text: m() }],
    attachments: [{ text: m(), title_link: `https://${m()}.example/page` }],
    edited: { user: `U${m()}`, ts: "1700000099.000000" },
  };
  event.event_ts = event.ts;
  const files = randomFiles(rand, markers);
  if (files !== undefined) event.files = files;
  return { event, markers };
}

// Every nudge the handler posted, keyed by the post it replied to.
function postedNudges(fake) {
  const nudges = new Map();
  for (const call of fake.calls) {
    if (call.method === "chat.postMessage") {
      nudges.set(call.args.thread_ts, call.args.markdown_text);
    }
  }
  return nudges;
}

describe("nudge text property", () => {
  test("no fixed sentence carries the marker prefix", () => {
    const subsets = [];
    for (let mask = 1; mask < 1 << CODES.length; mask++) {
      subsets.push(CODES.filter((_, i) => mask & (1 << i)));
    }
    for (const rulesUrl of [RULES, null]) {
      for (const problems of subsets) {
        assert.ok(
          !nudgeText(problems, rulesUrl).includes(MARKER_PREFIX),
          `${MARKER_PREFIX} appears in the text for ${JSON.stringify(problems)}`,
        );
      }
    }
  });

  for (const rulesUrl of [RULES, null]) {
    test(`reply text depends only on the problems and the rules URL (rulesUrl ${rulesUrl})`, async (t) => {
      t.mock.method(console, "error", () => {});
      const rand = mulberry32(NUDGE_TEXT_SEED);
      const fake = createFakeSlack();
      const handler = createMessageHandler({ channelId: "C1", rulesUrl });
      const cases = [];

      for (let n = 1; n <= MESSAGES_PER_SETTING; n++) {
        const { event, markers } = randomPost(rand, n);
        fake.seed(event);
        await handler({ event, client: fake.client });
        cases.push({ event, markers, n });
      }

      const nudges = postedNudges(fake);
      const groups = new Map();
      let nudged = 0;
      for (const { event, markers, n } of cases) {
        const text = nudges.get(event.ts);
        if (text === undefined) continue;
        nudged += 1;
        const where = `seed ${NUDGE_TEXT_SEED}, case ${n}, event ${JSON.stringify(event)}`;

        for (const m of markers) {
          assert.ok(!text.includes(m), `marker ${m} reached the reply; ${where}`);
        }
        assert.ok(!text.includes(MARKER_PREFIX), `a marker reached the reply; ${where}`);
        assert.ok(!text.includes("<@"), `a mention reached the reply; ${where}`);
        assert.ok(!text.includes("<!"), `a broadcast reached the reply; ${where}`);
        for (const url of text.match(/https?:\/\/[^\s)\]]+/g) ?? []) {
          assert.strictEqual(url, rulesUrl, `a foreign URL reached the reply; ${where}`);
        }

        const key = JSON.stringify(nudgeProblems(event));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ text, where });
      }

      assert.ok(nudged >= 50, `only ${nudged} messages were nudged; seed ${NUDGE_TEXT_SEED}`);

      let shared = 0;
      for (const [key, members] of groups) {
        if (members.length >= 2) shared += 1;
        for (const member of members) {
          assert.strictEqual(
            member.text,
            members[0].text,
            `same problems ${key} but different text; ${member.where}`,
          );
        }
      }
      assert.ok(
        shared >= 5,
        `only ${shared} problem lists were shared by 2 or more messages; seed ${NUDGE_TEXT_SEED}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Random event sequences

const SEQUENCE_SEED = 20260119;
const SEQUENCES = 300;
const LAMP = "rotating_light";
const image = { id: "F1", mimetype: "image/png", filetype: "png" };
const GOOD = { text: "FS [US] Widget $10", files: [image] };
const BAD_POSTS = [
  { text: "FS", files: [] },
  { text: "FS [US] Widget", files: [image] },
  { text: "WTB [US] Widget", files: [image] },
];

const ERROR_CODES = ["fatal_error", "message_not_found", "no_reaction", "already_reacted"];
const ERROR_KINDS = ["rate_limited", "request", "http", "exhausted"];
const METHODS = [
  "auth.test",
  "conversations.history",
  "conversations.replies",
  "chat.postMessage",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
];

// Each call index 1-20 of each method fails with a 30% chance, in a way picked at
// random. A reply is made to look unconfirmed with a response that has no thread.
function injectFailures(rand, fake) {
  let unconfirmed = 0;
  for (const name of METHODS) {
    for (let n = 1; n <= 20; n++) {
      if (rand() >= 0.3) continue;
      const how = int(rand, 0, name === "chat.postMessage" ? 2 : 1);
      if (how === 0) fake.fail(name, n, pick(rand, ERROR_CODES));
      else if (how === 1) fake.failWith(name, n, pick(rand, ERROR_KINDS));
      else {
        unconfirmed += 1;
        fake.respond(name, n, { ok: true, channel: "C1", ts: `1700000900.${String(unconfirmed).padStart(6, "0")}`, message: {} });
      }
    }
  }
}

// Plays one random sequence of events through one handler and one fake, one event
// at a time and logging each into events before it runs. afterEvent(state) runs
// after every event. Returns the fake and the author of every message that was
// seeded or posted.
async function playSequence(seed, { failures, events, afterEvent = () => {} }) {
  const rand = mulberry32(seed);
  const fake = createFakeSlack();
  const authors = new Map();
  const handler = createMessageHandler({ channelId: "C1", rulesUrl: RULES });

  const post = fake.client.chat.postMessage;
  fake.client.chat.postMessage = async (args) => {
    const response = await post(args);
    authors.set(response.ts, "UBOT");
    return response;
  };
  if (failures) injectFailures(rand, fake);

  const posts = Array.from({ length: int(rand, 1, 3) }, (_, i) => ({
    ts: `1700000100.${String(i + 1).padStart(6, "0")}`,
    delivered: false,
    compliant: false,
    badIndex: 0,
    otherLamp: false,
  }));
  let replyCount = 0;

  const deliver = (event) => handler({ event, client: fake.client });
  const seedReply = (p, user, extra) => {
    replyCount += 1;
    const ts = `1700000200.${String(replyCount).padStart(6, "0")}`;
    const reply = { channel: "C1", ts, thread_ts: p.ts, user, text: "FS", ...extra };
    fake.seed(reply);
    authors.set(ts, user);
    return { ...reply, type: "message", channel_type: "channel", event_ts: ts };
  };
  const edit = async (p, fields) => {
    const before = fake.message(p.ts);
    fake.update(p.ts, fields);
    await deliver(changeEvent(before, fake.message(p.ts), { edited: { user: "UMEMBER", ts: "100.999999" } }));
  };

  const actions = {
    async new(p) {
      p.compliant = rand() < 0.5;
      p.badIndex = int(rand, 0, BAD_POSTS.length - 1);
      const message = { channel: "C1", ts: p.ts, user: "UMEMBER", ...(p.compliant ? GOOD : BAD_POSTS[p.badIndex]) };
      fake.seed(message);
      authors.set(p.ts, "UMEMBER");
      p.delivered = true;
      await deliver({ ...message, type: "message", channel_type: "channel", event_ts: p.ts });
    },
    async edit(p) {
      p.badIndex = (p.badIndex + int(rand, 1, BAD_POSTS.length - 1)) % BAD_POSTS.length;
      await edit(p, BAD_POSTS[p.badIndex]);
    },
    async fix(p) {
      p.compliant = true;
      await edit(p, GOOD);
    },
    async rebreak(p) {
      p.compliant = false;
      p.badIndex = int(rand, 0, BAD_POSTS.length - 1);
      await edit(p, BAD_POSTS[p.badIndex]);
    },
    async touch(p) {
      const before = fake.message(p.ts);
      await deliver(changeEvent(before, before));
    },
    async memberReply(p) {
      await deliver(seedReply(p, "UMEMBER"));
    },
    async botReply(p) {
      await deliver(seedReply(p, "UOTHERBOT", { bot_id: "BOTHER" }));
    },
    async otherLamp(p) {
      const reactions = fake.message(p.ts).reactions ?? [];
      const entry = reactions.find((r) => r.name === LAMP);
      if (entry) {
        entry.users.push("UOTHER");
        entry.count = entry.users.length;
      } else {
        reactions.push({ name: LAMP, users: ["UOTHER"], count: 1 });
      }
      p.otherLamp = true;
      fake.update(p.ts, { reactions });
    },
  };

  const choices = () => {
    const list = [];
    const add = (weight, action, p) => {
      for (let i = 0; i < weight; i++) list.push({ action, p });
    };
    for (const p of posts) {
      if (!p.delivered) {
        add(3, "new", p);
        continue;
      }
      if (p.compliant) {
        add(3, "rebreak", p);
      } else {
        add(1, "edit", p);
        add(3, "fix", p);
      }
      add(1, "touch", p);
      add(1, "memberReply", p);
      add(1, "botReply", p);
      if (!p.otherLamp) add(1, "otherLamp", p);
    }
    return list;
  };

  for (let i = int(rand, 1, 15); i > 0; i--) {
    const { action, p } = pick(rand, choices());
    events.push(`${action} ${p.ts}`);
    await actions[action](p);
    afterEvent({ fake, posts: posts.filter((x) => x.delivered) });
  }
  return { fake, authors };
}

const botLamped = (fake, ts) =>
  (fake.message(ts).reactions ?? []).some((r) => r.name === LAMP && r.users.includes("UBOT"));
const botReplied = (fake, ts) => fake.thread(ts).some((m) => m.user === "UBOT");

// Runs play(n, seed) for every sequence, and names the seed, the sequence number
// and the events so far when anything throws.
async function overSequences(seedBase, setting, play) {
  for (let n = 1; n <= SEQUENCES; n++) {
    const seed = seedBase + n;
    const events = [];
    try {
      await play(seed, events);
    } catch (err) {
      throw new Error(
        `${err.message}\n(${setting}: seed ${seed}, sequence ${n}, events so far: ${JSON.stringify(events)})`,
        { cause: err },
      );
    }
  }
}

describe("random event sequences", () => {
  test("a post carries the bot's lamp exactly when its thread holds a bot reply", async (t) => {
    t.mock.method(console, "error", () => {});
    let lampedEvents = 0;
    let cleanups = 0;

    await overSequences(SEQUENCE_SEED, "no failures", async (seed, events) => {
      const before = new Map();
      await playSequence(seed, {
        failures: false,
        events,
        afterEvent({ fake, posts }) {
          for (const p of posts) {
            const lamp = botLamped(fake, p.ts);
            assert.strictEqual(
              lamp,
              botReplied(fake, p.ts),
              `post ${p.ts}: bot lamp ${lamp}, bot reply in thread ${!lamp}`,
            );
            if (lamp) lampedEvents += 1;
            if (before.get(p.ts) && !lamp) cleanups += 1;
            before.set(p.ts, lamp);
          }
        },
      });
    });

    assert.ok(lampedEvents >= 50, `only ${lampedEvents} events left a post lamped`);
    assert.ok(cleanups >= 50, `only ${cleanups} cleanups happened`);
  });

  for (const failures of [false, true]) {
    test(`the handler never rejects, deletes only bot replies and nudges a post at most 3 times (${failures ? "with" : "without"} injected failures)`, async (t) => {
      t.mock.method(console, "error", () => {});
      let atCap = 0;
      let deletes = 0;

      await overSequences(SEQUENCE_SEED + 1000, failures ? "failures" : "no failures", async (seed, events) => {
        const { fake, authors } = await playSequence(seed, { failures, events });

        for (const call of fake.calls.filter((c) => c.method === "chat.delete")) {
          deletes += 1;
          assert.strictEqual(
            authors.get(call.args.ts),
            "UBOT",
            `chat.delete of ${call.args.ts}, a message by ${authors.get(call.args.ts)}`,
          );
        }

        const nudges = new Map();
        for (const call of fake.calls.filter((c) => c.method === "chat.postMessage")) {
          const ts = call.args.thread_ts;
          nudges.set(ts, (nudges.get(ts) ?? 0) + 1);
        }
        let reached = false;
        for (const [ts, count] of nudges) {
          assert.ok(count <= 3, `post ${ts} got ${count} nudges`);
          if (count === 3) reached = true;
        }
        if (reached) atCap += 1;
      });

      assert.ok(atCap >= 1, "no sequence reached 3 nudges on a post");
      assert.ok(deletes >= 1, "no chat.delete happened");
    });
  }
});
