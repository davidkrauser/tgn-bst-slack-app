import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realScript = new URL("../deploy/deploy.sh", import.meta.url).pathname;

let tmp;
let repo;
let calls;
let env;
let firstSha;
let secondSha;

function git(...args) {
  const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "bst-deploy-"));
  repo = join(tmp, "repo");
  calls = join(tmp, "calls");
  mkdirSync(join(tmp, "bin"));
  mkdirSync(calls);
  mkdirSync(join(repo, "deploy"), { recursive: true });
  // A fake ssh: record argv (NUL-separated) and stdin per call, then succeed.
  const fakeSsh = join(tmp, "bin", "ssh");
  writeFileSync(
    fakeSsh,
    [
      "#!/bin/sh",
      `n=$(ls "${calls}" | wc -l)`,
      `printf '%s\\0' "$@" > "${calls}/$n.argv"`,
      `cat > "${calls}/$n.stdin"`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeSsh, 0o755);
  env = {
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    HOME: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  // The real ssh must never run: ssh has to resolve to the fake here.
  const which = spawnSync("bash", ["-c", "command -v ssh"], { env, encoding: "utf8" });
  assert.equal(which.stdout.trim(), fakeSsh);

  git("init", "-q");
  copyFileSync(realScript, join(repo, "deploy", "deploy.sh"));
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git("add", "deploy/deploy.sh", "package.json", ".gitignore");
  git("commit", "-q", "-m", "first");
  firstSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "later.txt"), "later\n");
  git("add", "later.txt");
  git("commit", "-q", "-m", "second");
  secondSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "x.js"), "ignored\n");
  mkdirSync(join(repo, ".planning"));
  writeFileSync(join(repo, ".planning", "x.md"), "excluded\n");
  appendFileSync(join(repo, ".git", "info", "exclude"), ".planning/\n");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function clearCalls() {
  for (const f of readdirSync(calls)) rmSync(join(calls, f));
}

function deploy(...args) {
  clearCalls();
  return spawnSync("bash", [join(repo, "deploy", "deploy.sh"), ...args], {
    cwd: tmp,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function sshCalls() {
  return readdirSync(calls)
    .filter((f) => f.endsWith(".argv"))
    .map((f) => {
      const id = f.slice(0, -".argv".length);
      return {
        argv: readFileSync(join(calls, f), "utf8").split("\0").slice(0, -1),
        stdin: join(calls, `${id}.stdin`),
      };
    });
}

function tarFiles(file) {
  if (readFileSync(file).length === 0) return null;
  const r = spawnSync("tar", ["-tf", file], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").filter((name) => name && !name.endsWith("/")).sort();
}

function assertRefused(r) {
  assert.notEqual(r.status, 0);
  assert.equal(sshCalls().length, 0);
}

test("no arguments is refused before any ssh call", () => {
  assertRefused(deploy());
});

test("a target beginning with a dash is refused before any ssh call", () => {
  assertRefused(deploy("-oProxyCommand=true"));
});

test("an empty target is refused before any ssh call", () => {
  assertRefused(deploy(""));
});

test("a third argument is refused before any ssh call", () => {
  assertRefused(deploy("host.example.com", "HEAD", "extra"));
});

test("a ref beginning with a dash is refused before any ssh call", () => {
  assertRefused(deploy("host.example.com", "-x"));
});

test("an unstaged change to a tracked file refuses the default ref", () => {
  appendFileSync(join(repo, "package.json"), " \n");
  try {
    assertRefused(deploy("host.example.com"));
  } finally {
    git("checkout", "--", "package.json");
  }
});

test("a staged change refuses the default ref", () => {
  appendFileSync(join(repo, "package.json"), " \n");
  git("add", "package.json");
  try {
    assertRefused(deploy("host.example.com"));
  } finally {
    git("reset", "-q", "--hard", "HEAD");
  }
});

test("a ref that does not resolve is refused before any ssh call", () => {
  assertRefused(deploy("host.example.com", "no-such-ref"));
});

test("a clean tree ships only the committed files of HEAD", () => {
  const r = deploy("host.example.com");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(secondSha));
  const all = sshCalls();
  assert.ok(all.length > 0);
  for (const call of all) assert.ok(call.argv.includes("host.example.com"));
  const archives = all.filter((call) => tarFiles(call.stdin) !== null);
  assert.equal(archives.length, 1);
  assert.deepEqual(tarFiles(archives[0].stdin), [
    ".gitignore",
    "deploy/deploy.sh",
    "later.txt",
    "package.json",
  ]);
  assert.ok(archives[0].argv.join(" ").includes(`/opt/bst/releases/${secondSha}`));
});

test("a dirty tree can still deploy another ref, shipping that commit", () => {
  appendFileSync(join(repo, "package.json"), " \n");
  try {
    const r = deploy("host.example.com", firstSha.slice(0, 8));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(firstSha));
    const archives = sshCalls().filter((call) => tarFiles(call.stdin) !== null);
    assert.equal(archives.length, 1);
    const files = tarFiles(archives[0].stdin);
    assert.ok(!files.includes("later.txt"));
    assert.ok(files.includes("package.json"));
    assert.ok(archives[0].argv.join(" ").includes(`/opt/bst/releases/${firstSha}`));
  } finally {
    git("checkout", "--", "package.json");
  }
});
