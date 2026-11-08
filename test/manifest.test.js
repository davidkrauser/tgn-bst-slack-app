import { test } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("Socket Mode is on and no request URL is configured", () => {
  assert.strictEqual(manifest.settings.socket_mode_enabled, true);
  assert.ok(!("request_url" in manifest.settings.event_subscriptions));
});

test("subscribes only to message.channels", () => {
  assert.deepStrictEqual(manifest.settings.event_subscriptions.bot_events, [
    "message.channels",
  ]);
  assert.ok(!("user_events" in manifest.settings.event_subscriptions));
});

test("requests exactly the three bot scopes and no user scopes", () => {
  const bot = [...manifest.oauth_config.scopes.bot].sort();
  assert.deepStrictEqual(bot, ["channels:history", "chat:write", "reactions:write"]);
  assert.ok(!("user" in manifest.oauth_config.scopes));
});

test("Home and Messages tabs are off", () => {
  const { app_home } = manifest.features;
  assert.strictEqual(app_home.home_tab_enabled, false);
  assert.strictEqual(app_home.messages_tab_enabled, false);
});
