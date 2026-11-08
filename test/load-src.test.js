import { test } from "node:test";
import { readdir } from "node:fs/promises";

// Node's coverage only sees files a test loads, so import every src module here;
// an untested module then counts against the gate instead of dropping out of it.
test("every src module loads", async () => {
  const dir = new URL("../src/", import.meta.url);
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const modules = names.filter((n) => n.endsWith(".js") && n !== "app.js").sort();
  for (const name of modules) {
    await import(new URL(name, dir).href);
  }
});
