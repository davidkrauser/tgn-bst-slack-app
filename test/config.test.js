import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, missingLine } from "../src/config.js";

const full = {
  SLACK_BOT_TOKEN: "xoxb-a",
  SLACK_APP_TOKEN: "xapp-b",
  SLACK_CHANNEL_ID: "C123",
};
const NAMES = Object.keys(full);

test("all three set returns the values and no missing names", () => {
  assert.deepEqual(readConfig(full), {
    missing: [],
    botToken: "xoxb-a",
    appToken: "xapp-b",
    channelId: "C123",
    rulesUrl: null,
  });
  const withUrl = readConfig({ ...full, BST_RULES_URL: "https://example.com/r" });
  assert.deepEqual(withUrl.missing, []);
  assert.equal(withUrl.rulesUrl, "https://example.com/r");
});

for (const name of NAMES) {
  test(`${name} absent is reported alone`, () => {
    const env = { ...full };
    delete env[name];
    assert.deepEqual(readConfig(env).missing, [name]);
  });

  test(`${name} empty is reported alone`, () => {
    assert.deepEqual(readConfig({ ...full, [name]: "" }).missing, [name]);
  });
}

test("all three missing are all listed", () => {
  assert.deepEqual([...readConfig({}).missing].sort(), [...NAMES].sort());
});

test("a whitespace-only token counts as present", () => {
  const config = readConfig({ ...full, SLACK_BOT_TOKEN: "   " });
  assert.deepEqual(config.missing, []);
  assert.equal(config.botToken, "   ");
});

test("BST_RULES_URL empty or absent gives null", () => {
  assert.equal(readConfig({ ...full, BST_RULES_URL: "" }).rulesUrl, null);
  assert.equal(readConfig(full).rulesUrl, null);
});

test("keys outside the four are ignored", () => {
  const config = readConfig({ ...full, OTHER: "x", PATH: "/bin" });
  assert.deepEqual(config.missing, []);
  assert.ok(!Object.values(config).includes("x"));
  assert.ok(!Object.values(config).includes("/bin"));
});

test("missingLine is one line naming each missing variable and no other", () => {
  const line = missingLine(["SLACK_APP_TOKEN", "SLACK_CHANNEL_ID"]);
  assert.ok(!line.includes("\n"));
  const names = (text) => text.match(/[A-Z][A-Z_]*[A-Z]/g) ?? [];
  assert.ok(names(line).includes("SLACK_APP_TOKEN"));
  assert.ok(names(line).includes("SLACK_CHANNEL_ID"));
  assert.ok(!names(line).includes("SLACK_BOT_TOKEN"));
});
