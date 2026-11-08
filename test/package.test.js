import { test } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
// Quote characters are shell syntax, not part of any flag's value.
const testScript = pkg.scripts.test.replace(/['"]/g, "");

test("Bolt is the only runtime dependency and there are no dev dependencies", () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies), ["@slack/bolt"]);
  assert.ok(!("devDependencies" in pkg));
});

test("the test script enforces the coverage gate", () => {
  for (const flag of [
    "--experimental-test-coverage",
    "--test-coverage-lines=95",
    "--test-coverage-branches=90",
    "--test-coverage-functions=95",
    "--test-coverage-include=src/**",
  ]) {
    assert.ok(testScript.includes(flag), `missing ${flag}`);
  }
});

test("the coverage gate excludes only app.js and the tests", () => {
  const excludes = [...testScript.matchAll(/--test-coverage-exclude=(\S+)/g)].map(
    (m) => m[1],
  );
  assert.deepStrictEqual(excludes.sort(), ["src/app.js", "test/**"]);
});

test("the lockfile records the same dependencies and no dev dependencies", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const root = lock.packages[""];
  assert.deepStrictEqual(root.dependencies, pkg.dependencies);
  assert.ok(!("devDependencies" in root));
  for (const [path, entry] of Object.entries(lock.packages)) {
    assert.ok(!entry.dev, `${path} is a dev dependency`);
  }
});

test("the package is released under the Unlicense", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const licence = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
  const lines = licence.split("\n").filter((line) => line.trim() !== "");
  assert.strictEqual(pkg.license, "Unlicense");
  assert.strictEqual(lock.packages[""].license, "Unlicense");
  assert.strictEqual(
    lines[0],
    "This is free and unencumbered software released into the public domain.",
  );
  assert.strictEqual(
    lines.at(-1),
    "For more information, please refer to <https://unlicense.org/>",
  );
});
