import { test } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";

const unit = await readFile(new URL("../deploy/bst.service", import.meta.url), "utf8");
const script = await readFile(new URL("../deploy/deploy.sh", import.meta.url), "utf8");
const envExample = await readFile(
  new URL("../deploy/bst.env.example", import.meta.url),
  "utf8",
);

function directives(text) {
  const byKey = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(line.slice(eq + 1));
  }
  return byKey;
}

const keys = directives(unit);

function values(key) {
  return keys.get(key) ?? [];
}

test("the unit reads configuration only from /etc/bst/env", () => {
  assert.ok(!keys.has("Environment"));
  assert.deepStrictEqual(values("EnvironmentFile"), ["/etc/bst/env"]);
});

test("the unit sets every sandbox directive", () => {
  const sandbox = {
    ProtectSystem: "strict",
    ProtectHome: "yes",
    PrivateTmp: "yes",
    PrivateDevices: "yes",
    NoNewPrivileges: "yes",
    ProtectKernelTunables: "yes",
    ProtectKernelModules: "yes",
    ProtectKernelLogs: "yes",
    ProtectControlGroups: "yes",
    ProtectClock: "yes",
    ProtectHostname: "yes",
    ProtectProc: "invisible",
    ProcSubset: "pid",
    RestrictAddressFamilies: "AF_INET AF_INET6 AF_UNIX",
    RestrictNamespaces: "yes",
    RestrictRealtime: "yes",
    RestrictSUIDSGID: "yes",
    LockPersonality: "yes",
    SystemCallArchitectures: "native",
    SystemCallFilter: "@system-service",
    CapabilityBoundingSet: "",
    UMask: "0077",
    MemoryMax: "256M",
  };
  for (const [key, value] of Object.entries(sandbox)) {
    assert.deepStrictEqual(values(key), [value], key);
  }
});

test("the unit has no ReadWritePaths or MemoryDenyWriteExecute", () => {
  assert.ok(!keys.has("ReadWritePaths"));
  assert.ok(!keys.has("MemoryDenyWriteExecute"));
});

test("the unit runs as a non-root user with an absolute ExecStart", () => {
  for (const key of ["User", "Group"]) {
    assert.deepStrictEqual(values(key), ["bst"], key);
  }
  const exec = values("ExecStart");
  assert.strictEqual(exec.length, 1);
  assert.ok(exec[0].split(/\s+/)[0].startsWith("/"));
});

test("the unit sets the expected service settings", () => {
  const expected = {
    Type: "simple",
    Restart: "on-failure",
    RestartSec: "5",
    WorkingDirectory: "/opt/bst/app",
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(values(key), [value], key);
  }
  for (const key of ["After", "Wants"]) {
    const targets = values(key).flatMap((value) => value.split(/\s+/));
    assert.ok(targets.includes("network-online.target"), key);
  }
});

test("the env example names exactly the four variables, all empty", () => {
  const lines = envExample
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort();
  assert.deepStrictEqual(lines, [
    "BST_RULES_URL=",
    "SLACK_APP_TOKEN=",
    "SLACK_BOT_TOKEN=",
    "SLACK_CHANNEL_ID=",
  ]);
  assert.ok(envExample.split("\n").some((line) => line.trim().startsWith("#")));
});

test("neither file holds a token-shaped string", () => {
  assert.doesNotMatch(unit, /xox[a-z]-|xapp-/i);
  assert.doesNotMatch(envExample, /xox[a-z]-|xapp-/i);
});

test("the deploy script holds no token-shaped string and no root login", () => {
  assert.doesNotMatch(script, /xox[a-z]-|xapp-/i);
  assert.ok(!script.includes("root@"));
});
