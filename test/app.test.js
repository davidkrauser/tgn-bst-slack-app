import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const entry = new URL("../src/app.js", import.meta.url).pathname;

const offline = new URL("./helpers/offline-bolt.js", import.meta.url).pathname;

// A run with all three required variables set must use the offline preload, or
// the child would connect to Slack.
function run(vars, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, entry], {
    env: { PATH: process.env.PATH, ...vars },
    encoding: "utf8",
    timeout: 10_000,
  });
}

const REQUIRED = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_CHANNEL_ID"];

// One stderr line that names every missing variable, never a present one, then exit 1.
function assertMissingLine(r, missing) {
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^[^\r\n]*\n$/);
  for (const name of REQUIRED) {
    assert.equal(r.stderr.includes(name), missing.includes(name), name);
  }
}

test("no variables set exits 1 naming all three", () => {
  assertMissingLine(run({}), REQUIRED);
});

test("missing names are reported without leaking any value", () => {
  const r = run({
    SLACK_BOT_TOKEN: "xoxb-test-secret",
    SLACK_APP_TOKEN: "",
    BST_RULES_URL: "https://example.com/rules",
  });
  assertMissingLine(r, ["SLACK_APP_TOKEN", "SLACK_CHANNEL_ID"]);
  for (const out of [r.stdout, r.stderr]) {
    assert.ok(!out.includes("xoxb-test-secret"));
    assert.ok(!out.includes("https://example.com/rules"));
  }
});

test("only SLACK_CHANNEL_ID missing names exactly that variable", () => {
  const r = run({ SLACK_BOT_TOKEN: "xoxb-x", SLACK_APP_TOKEN: "xapp-y" });
  assertMissingLine(r, ["SLACK_CHANNEL_ID"]);
  assert.ok(!r.stderr.includes("xoxb-x") && !r.stderr.includes("xapp-y"));
});

const SECRETS = ["xoxb-test-secret", "xapp-test-secret"];

function runOffline(mode, extra = {}) {
  return run(
    {
      SLACK_BOT_TOKEN: "xoxb-test-secret",
      SLACK_APP_TOKEN: "xapp-test-secret",
      SLACK_CHANNEL_ID: "C1",
      OFFLINE_MODE: mode,
      ...extra,
    },
    ["--import", offline],
  );
}

function assertNoLeak(r) {
  assert.ok(!r.stdout.includes("connected"));
  for (const out of [r.stdout, r.stderr]) {
    for (const secret of SECRETS) assert.ok(!out.includes(secret));
  }
}

test("a failed start logs only the error code and exits 1", () => {
  const r = runOffline("start");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "start failed: invalid_auth\n");
  assertNoLeak(r);
});

test("an unhandled rejection logs only the error code and exits 1", () => {
  const r = runOffline("rejection");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: invalid_auth\n");
  assertNoLeak(r);
});

test("an uncaught exception logs only the error code and exits 1", () => {
  const r = runOffline("exception");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: invalid_auth\n");
  assertNoLeak(r);
});

test("an uncaught error with no code logs only its name and exits 1", () => {
  const r = runOffline("plain");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: TypeError\n");
  assertNoLeak(r);
});

test("an odd error name logs unknown_error and exits 1", () => {
  const r = runOffline("odd-name");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: unknown_error\n");
  assertNoLeak(r);
});

// An identifier starts with a letter, "_" or "$" and runs to at most 64 characters.
for (const [label, name, logged] of [
  ["a 64-character identifier", "A".repeat(64), "A".repeat(64)],
  ["a 65-character identifier", "A".repeat(65), "unknown_error"],
  ["a name that starts with a digit", "1Error", "unknown_error"],
  ["a name with a dash", "Type-Error", "unknown_error"],
  ["a name with a dollar and an underscore", "_$Err9", "_$Err9"],
]) {
  test(`${label} as an error name logs ${logged === name ? "the name" : "unknown_error"}`, () => {
    const r = runOffline("named", { OFFLINE_ERROR_NAME: name });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `process failed: ${logged}\n`);
    assertNoLeak(r);
  });
}

test("an error name that is not a string logs unknown_error and exits 1", () => {
  const r = runOffline("object-name");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: unknown_error\n");
  assertNoLeak(r);
});

test("a non-Error rejection logs unknown_error and exits 1", () => {
  const r = runOffline("non-error");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: unknown_error\n");
  assertNoLeak(r);
});

test("an unhandled rejection with no code logs only its name and exits 1", () => {
  const r = runOffline("plain-rejection");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: TypeError\n");
  assertNoLeak(r);
});

test("an uncaught error with only a code logs that code and exits 1", () => {
  const r = runOffline("coded");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "process failed: ECONNRESET\n");
  assertNoLeak(r);
});

test("a successful start registers the message event, starts the app and exits 0", () => {
  const r = runOffline("started");
  assert.equal(r.status, 0);
  const lines = r.stdout.split("\n");
  assert.ok(lines.includes("started"));
  assert.ok(lines.includes('events:["message"]'));
  assert.equal(r.stderr, "");
  for (const out of [r.stdout, r.stderr]) {
    for (const secret of SECRETS) assert.ok(!out.includes(secret));
  }
});
