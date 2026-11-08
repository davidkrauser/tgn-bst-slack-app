# AGENTS.md — working on this repo

A small Slack bot (Bolt, Socket Mode) that watches one buy/sell/trade channel and
replies once, in thread, to listing-like posts that break the posting format. This
file is contributor context: invariants, constraints, and where things live.
Behaviour details belong in `docs/spec.md`, and the tests pin them.

## Hard constraints — do not violate

- `@slack/bolt` is the only runtime dependency. Everything else is Node stdlib.
  Tests use `node:test` + `node:assert`. The lockfile is committed.
- There is no build step, linter, formatter or dev dependency, by design. Adding
  any of them needs the maintainer's explicit approval.
- Permanently out of scope: no composer, slash commands or message metadata; no
  external database.
- Enforcement is advice only: the bot never deletes member posts and never bans.

## Layout

- `package.json` — `npm start` (runs `src/app.js`), the gated test script, the Node
  engine (`>=22.8`, as the README says) and the license field.
- `README.md` — operator docs, from creating the Slack app to deploying. Keep its env
  vars, scopes and deploy steps in step with `src/config.js`, `manifest.json` and
  `deploy/`.
- `SECURITY.md` — how to report a vulnerability, and a summary of the threat model.
- `LICENSE` — the Unlicense, which `package.json` declares.
- `manifest.json` — the Slack app manifest, the source of truth for scopes and
  events: `message.channels`, plus `chat:write`, `channels:history` and
  `reactions:write`. Keep it in sync with the code.
- `src/parse.js` — the pure parser. `parsePost` returns `null` for a non-listing,
  else `{ type, title, location, hasPrice, missing }`; also exports
  `missingFields`, `countImages` and `hasImage`.
- `src/app.js` — the entry point. It reads and validates the environment, builds
  the Bolt app (Socket Mode) and wires `message` events to the handler. It holds
  no event logic, and the coverage gate excludes it. It also logs a failed start,
  or any uncaught error, as one `<what> failed: <code>` line and exits 1.
- `src/config.js` — `readConfig(env)` and `missingLine`. Required: `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`. Optional: `BST_RULES_URL`.
- `src/handlers.js` — `classifyEvent` (which events are acted on) and
  `createMessageHandler`. The handler nudges new posts and acts on edits.
- `src/nudge.js` — `nudgeProblems`, `nudgeText`, `postNudge`, `fetchMessage`,
  `hasBotLamp`, `cleanUpNudge` and `logFailure`, the shared
  `<what> failed: <code>` logger.
- `deploy/bst.service` — the sample sandboxed systemd unit.
- `deploy/bst.env.example` — the env template for `/etc/bst/env`.
- `deploy/deploy.sh` — `deploy.sh <ssh-target> [git-ref]`. It ships one committed SHA
  with `git archive`, installs it root-owned with `npm ci --omit=dev --ignore-scripts`,
  switches the `/opt/bst/app` link, health-checks, and rolls back on failure.
- `test/deploy.test.js` — pins the unit and the env template, and checks the deploy
  files for token-shaped strings and the script for a root login.
- `test/deploy-script.test.js` — runs the script against a temp repo with a fake
  `ssh`. Only the local side is tested.
- `docs/spec.md` — the behaviour spec: what the bot does, the reply wording, the
  deploy files and the testing rules. A behaviour change updates it, the tests and,
  where it applies, the threat model in the same commit.
- `docs/threat-model.md` — the threats, their mitigations and the tests that prove
  them. Update it, and the summary in `SECURITY.md`, when a mitigation or its test
  changes.
- `test/helpers/offline-bolt.js` — a `--import` preload that blocks network access
  and stubs Bolt's Web API calls, so child-process tests of `src/app.js` never
  connect.
- `test/helpers/fake-slack.js` — a stateful recording fake of every Web API method
  the bot calls. Seeded messages, posts, deletes and reactions show up in history
  and replies. It raises Slack's own errors the way Slack would (an already-placed or
  missing reaction, a message that is gone), injects client-side errors (`failWith`)
  and can pause a call (`hold`) for race tests. It is checked against Slack's
  published docs. Tests assert on its call log and state, not on ad-hoc stubs.
- `test/helpers/log-guard.js` — records `console.error` in handler tests and fails a
  test whose log lines carry member text, reply text, a Slack response or a token.
- `test/helpers/events.js` — `changeEvent`, the builder for the `message_changed` events
  Slack sends, shared by the scenario, race and property tests.
- `test/helpers/random.js` — the seeded random helpers.
- `test/helpers/reference-parse.js` — slow reference versions of the parser rules;
  `test/parse-reference.test.js` compares them with the parser on random inputs.
- `test/scenarios.test.js` — whole event sequences (post, edit, fix, re-break) run
  through one handler and one fake.
- `test/properties.test.js` — seeded property tests over nudge text and random event
  sequences.
- `test/interleavings.test.js` — events racing on one post.
- `test/*.test.js` — plain `node:test`.

## Invariants

- **Coverage gate.** `npm test` runs every test and enforces lines >= 95,
  branches >= 90, functions >= 95 over `src/`, excluding the entry point
  `src/app.js` and `test/`. `test/load-src.test.js` imports every `src/*.js`
  except `app.js`, so an untested module counts against the gate. Never lower the
  thresholds or widen the exclusions to pass; add tests.
- **Parser stays pure.** `src/parse.js` never throws and runs in linear time, with
  no backtracking-prone regexes. `test/parse-robustness.test.js` enforces under
  200 ms on adversarial 100k-character inputs. Keep Slack API calls out of it.
- **Configuration is environment only.** A missing or empty required variable
  makes the process print one line naming the missing variables (never a value)
  and exit 1 before connecting.
- **Event logic needs no connection.** It is importable and testable with no Slack
  connection and no environment. In `src/`, only `app.js` imports `@slack/bolt` or
  reads `process.env`.
- **Where the bot acts.** Only in `SLACK_CHANNEL_ID`, and only on top-level
  messages with no subtype or `file_share`, and on `message_changed` edits of those
  messages. It never nudges bot-authored messages. Admins are not exempt.
- **Nudge text is injection-free.** It is built only from fixed sentences and the
  operator's rules URL, never from member text.
- **Edits fail closed.** An edit is judged on a fresh copy of the message from
  channel history, never the event's copy. If that refetch fails or returns another
  message, or the bot's own user id (from `auth.test`, cached after the first
  success) is unknown, the bot does nothing for that event.
- **The lamp is the only nudge state.** A post is nudged for its current episode iff
  this bot's own lamp is on it. Another user's lamp does not count. A non-compliant
  edit with no bot lamp is nudged again.
- **Cleanup deletes only the bot's own replies.** On a compliant edit of a lamped
  post, the bot lists every page of the thread, then deletes the replies authored by
  its own user id, never the post, members' replies or other bots'. It removes the
  lamp only when that cleanup is complete. A reply that is already gone counts as
  clean. Otherwise the lamp stays and the next edit retries.
- **Lamp first, roll back on doubt.** The lamp (`:rotating_light:`) goes on before
  the reply. A reply that Slack doesn't confirm in the thread is deleted, and its
  lamp removed. Slack-call failures are logged and never thrown.
- **Nudges are capped.** A post gets at most 3 nudge attempts per process, new posts
  and edits alike, confirmed or not. After that a non-compliant edit adds no lamp and
  posts no reply (it may still look up the bot id and refetch the message). Cleanup is
  unaffected. The per-post count and the cached bot user id are the only in-memory
  state, and both reset on restart. The bot writes nothing to disk.
- **Logs carry codes only.** Slack-call failures, a failed start and uncaught errors
  are logged as `<what> failed: <error code>`; an uncaught error with no code logs its
  error name (when it is a plain identifier) in place of the code, never its message.
  Never log error objects, message text or tokens.
- **Tests pin the behaviour, not the code.** A test asserts only what the bot is meant
  to do: no call order beyond lamp-before-reply, the rollback and list-and-delete
  before lamp removal; no log wording beyond `<what> failed: <code>`; no private
  helpers; no fake internals. Expected values are worked out by hand, never pasted
  from a run. Seeded random tests fix their seed and report it on failure.
- **Tests never connect.** A test that runs `src/app.js` with all required variables
  set must load the offline preload. The deploy-script test puts a fake `ssh` first on
  `PATH`, so no test reaches a host.
- **Deploy config has no secrets.** The unit reads only
  `EnvironmentFile=/etc/bst/env`, with no `Environment=` line, and the template's
  values stay empty. Nothing under `deploy/` names a host, a `root@` login, a token or
  a channel id; the deploy script takes the host only from its arguments.
- **The tree names no workspace.** The committed tree carries no workspace names, host
  names, personal email addresses, tokens or channel ids. Examples use example.com.

## Checks

```bash
npm test                          # all tests plus the coverage gate
node --test test/parse.test.js    # scope to the file you changed
node --check src/foo.js           # syntax check; there is no linter
bash -n deploy/deploy.sh          # syntax check the deploy script
```

Run `npm test` before claiming done.
