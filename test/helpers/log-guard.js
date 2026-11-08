// A guard for tests that drive the message handler: it records every
// console.error call and, after each test, checks that none of them carries
// member text, the reply text, a Slack response or a token. Every text a test
// feeds in (events, seeded and updated messages, canned responses, the replies
// the bot posts) is watched automatically, so a new test cannot add a text the
// guard does not see. It also checks the shape of each line: one string, one
// line, not empty and not starting with a space.

import assert from "node:assert";
import { inspect } from "node:util";

// The token every token-bearing error in these tests carries.
export const SECRET = "xoxb-test-secret";

// A log line is a single line, and a failure line ends in one error code.
const SINGLE_LINE = /^[^\r\n]*$/;
const NAMES_SOMETHING = /^\S/;
const FAILURE_MARK = " failed: ";
const ENDS_IN_CODE = / failed: [A-Za-z0-9_$]+$/;

// A text counts as logged when the log carries all of it or, for a text longer
// than this, any run of this many of its characters. A line that logs a text with
// its first or last character cut off still carries such a run. The fixed log
// labels and error codes are shorter than this or share no run with a test's text.
export const WINDOW = 12;

export function carries(rendered, text) {
  if (text.length <= WINDOW) return rendered.includes(text);
  for (let i = 0; i + WINDOW <= text.length; i++) {
    if (rendered.includes(text.slice(i, i + WINDOW))) return true;
  }
  return false;
}

// Message fields that hold member-written text.
const TEXT_KEYS = new Set(["text", "title", "from_url", "markdown_text"]);

// Fields that only describe a message's shape, so their values are not content.
const SHAPE_KEYS = new Set(["type", "subtype", "channel", "ts", "thread_ts"]);

function collect(value, into, every) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, every);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string") {
      const content = every ? !SHAPE_KEYS.has(key) : TEXT_KEYS.has(key);
      if (inner !== "" && content) into.add(inner);
    } else {
      collect(inner, into, every);
    }
  }
}

export const render = (arg) =>
  typeof arg === "string"
    ? arg
    : inspect(arg, { depth: Infinity, breakLength: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity });

export function createLogGuard(t) {
  const mock = t.mock.method(console, "error", () => {});
  const watched = new Set([SECRET]);
  const fakes = [];

  // The text fields of an event or message, however deeply nested.
  const watch = (value) => collect(value, watched, false);

  return {
    watch,
    // Every logged line, as the string it was logged as.
    lines: () => mock.mock.calls.map((call) => call.arguments[0]),
    // Watches what a fake is given, and the replies the bot posts through it.
    track(fake) {
      const { seed, update, respond } = fake;
      fake.seed = (message) => {
        watch(message);
        return seed(message);
      };
      fake.update = (ts, fields) => {
        watch(fields);
        return update(ts, fields);
      };
      // A canned response is never to be logged, so every string in it counts.
      fake.respond = (name, n, response) => {
        collect(response, watched, true);
        return respond(name, n, response);
      };
      fakes.push(fake);
      return fake;
    },
    check() {
      const texts = new Set(watched);
      for (const fake of fakes) {
        for (const call of fake.calls) collect(call.args, texts, false);
      }
      const calls = mock.mock.calls.map((call) => call.arguments);
      for (const args of calls) {
        assert.strictEqual(args.length, 1, "a log call carries more than its one line");
        assert.strictEqual(typeof args[0], "string", "a log call is not a string");
        assert.match(args[0], SINGLE_LINE, "a log line spans more than one line");
        assert.match(args[0], NAMES_SOMETHING, "a log line is empty or starts with a space");
        if (args[0].includes(FAILURE_MARK)) {
          assert.match(args[0], ENDS_IN_CODE, "a failure line does not end in one error code");
        }
      }
      const rendered = calls.flat().map(render).join("\n");
      for (const text of texts) {
        assert.ok(!carries(rendered, text), "a log line carries watched text or a token");
      }
    },
  };
}
