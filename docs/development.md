# Development guide

For people fixing, changing or extending the bot. It covers how the code fits
together, what the logs mean, how to track down a problem, and how to make a change
without breaking the promises in [SECURITY.md](../SECURITY.md).

The companion documents:

- [spec.md](spec.md): the behaviour, rule by rule. The tests pin it.
- [threat-model.md](threat-model.md): each threat, its mitigation and the test that
  proves it.
- [setup.md](setup.md): creating the app, configuring, deploying.
- [AGENTS.md](../AGENTS.md): the full list of hard constraints and invariants, and a
  file-by-file map of the repo. Read it before your first change.

## How it works

The whole bot is about 600 lines in `src/`, with one runtime dependency
(`@slack/bolt`).

Every `message` event from Slack goes through one handler (`src/handlers.js`):

1. **Classify.** `classifyEvent` returns `new`, `edit` or nothing. It ignores other
   channels, thread replies, bot authors, malformed events, and every subtype except
   `file_share` and `message_changed` (a plain message has no subtype). An ignored
   event makes no Slack call.
2. **New post.** `nudgeProblems` runs the parser on the event. No problems: done.
   Otherwise, if the post is under its cap of 3 attempts, `postNudge`:
   1. `reactions.add`: the lamp goes on;
   2. `chat.postMessage`: the reply goes into the post's thread;
   3. if Slack doesn't confirm the reply landed in that thread, `chat.delete` it and
      `reactions.remove` the lamp.
3. **Edit.**
   1. Get the bot's own user id (`auth.test`, cached after the first success).
   2. Refetch the post (`conversations.history`, `latest` = the post's ts,
      `inclusive`, `limit: 1`).
   3. Decide from the refetched copy:

      | | Bot's lamp on it | No bot lamp |
      | --- | --- | --- |
      | **Still broken** | do nothing | nudge, as in step 2 |
      | **Fixed** | `cleanUpNudge` | do nothing |

   `cleanUpNudge` lists every page of the thread (`conversations.replies`), deletes
   each reply authored by the bot's user id (`chat.delete`), and only if all of that
   worked removes the lamp (`reactions.remove`).

The ideas that hold it together:

- **The lamp is the state.** The 🚨 reaction from the bot's own user id is the only
  record that a post has been nudged. There is no database, so after a restart the
  bot reads the lamp to know where it stands.
- **Edits fail closed.** An edit is judged on a fresh copy fetched from channel
  history, not the event's copy (which lacks reactions and files, and could be
  forged). If that fetch fails, or the bot doesn't know its own user id yet, the bot
  does nothing; the next edit retries.
- **Lamp first, roll back on doubt.** The lamp goes on before the reply, so a racing
  edit already sees the post as nudged. A reply Slack doesn't confirm is deleted and
  its lamp removed.
- **Never throw.** Every Slack call is wrapped. A failure is logged as a code and the
  handler moves on.

| File | Role |
| --- | --- |
| `src/app.js` | Entry point: reads the environment, starts Bolt in Socket Mode, wires `message` events, handles fatal errors. The only file that touches Bolt or `process.env`. |
| `src/config.js` | `readConfig(env)` and the "missing env var" line. |
| `src/handlers.js` | `classifyEvent` and `createMessageHandler`: the decision tree above, the nudge cap and the cached bot id. |
| `src/nudge.js` | Reply text, and the Slack-call sequences: `postNudge`, `fetchMessage`, `hasBotLamp`, `cleanUpNudge`, `logFailure`. |
| `src/parse.js` | The pure parser: tags, title, location, price, photos. No I/O. |

## Reading the logs

On the host, `journalctl -u bst`. Every line is one of the following. Failures are
always `<what> failed: <code>`, and the code is Slack's error code (`data.error`),
else the client's `code`, else `unknown_error`. Lines never contain message text,
error messages or tokens, by design. Bolt also writes a few lines of its own about
the connection.

| Line | Meaning | Effect |
| --- | --- | --- |
| `connected` | Socket Mode is up. | Normal start. |
| `Missing env var(s): …` | A required variable is empty or unset. | Exits 1 before connecting; systemd retries every 5 s. Check `/etc/bst/env`. |
| `start failed: <code>` | Bolt couldn't initialise or connect. | Exits 1; systemd retries every 5 s. |
| `process failed: <code or ErrorName>` | An uncaught error or rejection. | Exits 1; restarted. This is a bug: every Slack call should be caught. |
| `lamp add failed: <code>` | `reactions.add` failed on a nudge. | The reply is still posted. The next broken edit may nudge again. |
| `nudge post failed: <code>` | `chat.postMessage` failed. | Lamp is rolled back. |
| `nudge post unconfirmed` | Slack's answer didn't show the reply in the post's thread. | The reply (if any) is deleted and the lamp rolled back. |
| `nudge delete failed: <code>` | Rolling back an unconfirmed reply failed. | A stray reply may be left. |
| `lamp remove failed: <code>` | Removing the lamp failed (rollback or cleanup). | After a rollback, the post keeps a lamp with no reply, so later broken edits aren't nudged until it is fixed. After cleanup, the lamp stays and the next fixing edit retries. |
| `bot id failed: <code>` / `bot id failed: no_user_id` | `auth.test` failed or returned no user id. | That edit is skipped; the next event retries. |
| `edit refetch failed: <code>` | `conversations.history` failed. | That edit is skipped. |
| `edit refetch mismatch` | History didn't return exactly the edited message. | That edit is skipped. |
| `reply list failed: <code>` | `conversations.replies` failed during cleanup. | Nothing is deleted; the lamp stays; the next edit retries. |
| `reply delete failed: <code>` | `chat.delete` of a bot reply failed. | The lamp stays; the next edit retries. |
| `nudge cap reached` | A post hit 3 nudge attempts. Logged once per post. | Further broken edits of that post are not nudged until restart. |

Codes you are likely to see:

| Code | Usual cause |
| --- | --- |
| `invalid_auth`, `not_authed`, `token_revoked`, `account_inactive` | A token is wrong, revoked or from another app. Check `/etc/bst/env`; see [rotating tokens](setup.md#rotating-tokens). |
| `missing_scope` | The app's scopes don't match `manifest.json`, or it wasn't reinstalled after a manifest change. |
| `not_in_channel` | The bot isn't a member of `SLACK_CHANNEL_ID`. Invite it. |
| `channel_not_found` | `SLACK_CHANNEL_ID` is wrong, or the channel is private. |
| `already_reacted`, `no_reaction` | The lamp was already on, or already off. Harmless. |
| `message_not_found` | The message is gone, for example the member deleted the post. When cleanup deletes a reply that is already gone, it counts as clean and isn't logged. |
| `cant_delete_message` | The bot tried to delete a message it can't. Should not happen; cleanup only targets its own replies. |
| `slack_webapi_request_error` | A network problem reaching Slack. |
| `slack_webapi_http_error` | Slack answered with an HTTP error status. |
| `unknown_error` | An error with no code. Rate limiting usually ends up here: the client waits and retries a rate-limited call for up to about 30 minutes, then gives up with an uncoded error. A burst of these after slow replies means heavy traffic. |

## Troubleshooting

**The bot never replies.** Check, in order: `systemctl status bst` shows it active;
the journal has `connected`; the bot is a member of the channel; `SLACK_CHANNEL_ID`
is that channel's id; the channel is public; the post is top-level (not a thread
reply) and actually breaks a rule in [spec.md](spec.md) (items 5–12). Failures will
show up as log lines from the table above.

**A post was nudged twice.** A post that is fixed and then broken again is nudged
again by design. Otherwise, two edits raced before the first lamp landed, or a
`lamp add failed` line means the post wasn't marked. Both are accepted risks bounded
by the cap (threat 7 in the [threat model](threat-model.md)), and the cap resets on
restart.

**A reply stayed after the post was fixed.** Look for `reply list failed`,
`reply delete failed` or `lamp remove failed`: the next edit retries. If the post
has no lamp, the reply is an orphan from a race (threat 12); breaking and fixing the
post again clears it. Cleanup only runs on a post that carries the bot's lamp.

**The bot keeps restarting.** Look for `Missing env var(s)`, `start failed` or
`process failed` lines. A `process failed` line is a bug worth a test.

**Reproducing an event sequence.** Don't connect to Slack. Write a scenario in
`test/scenarios.test.js`: seed messages into `test/helpers/fake-slack.js`, build
edits with `changeEvent` from `test/helpers/events.js`, run them through one handler
and assert on the fake's state. A failing seeded random test prints its seed and
case, so you can replay it.

## Tests

```sh
npm test                          # everything, plus the coverage gate
node --test test/parse.test.js    # one file
node --check src/nudge.js         # syntax check (there is no linter)
bash -n deploy/deploy.sh          # syntax check the deploy script
```

`npm test` enforces lines ≥ 95%, branches ≥ 90%, functions ≥ 95% over `src/`
(excluding `src/app.js`). Never lower the thresholds; add tests. No test touches
the network: `test/helpers/offline-bolt.js` blocks it for tests that start
`src/app.js`, and the deploy-script test puts a fake `ssh` first on `PATH`.

The test helpers:

- `fake-slack.js`: a stateful fake of every Web API method the bot calls. It raises
  Slack's real error codes, can inject failures (`failWith`) and pause a call
  (`hold`) for race tests. Assert on its call log and state.
- `log-guard.js`: fails a handler test whose log lines carry message text, reply
  text, a Slack response or a token.
- `events.js`, `random.js`, `reference-parse.js`: event builders, seeded random
  helpers and slow reference parsers for property tests.

Rules for writing tests (spec items 36–41): test behaviour the spec asks for, not
how the code works today; work expected values out by hand, never paste them from a
run; fix seeds in the file; assert no call order except lamp-before-reply, the
rollback, and list-and-delete before lamp removal.

## Making a change

1. **Write the behaviour down first.** Change [spec.md](spec.md). If it touches a
   security property, change [threat-model.md](threat-model.md) too, including the
   test that proves it.
2. **Change the tests**, then the code. All of it lands in one commit.
3. **If the change affects what [SECURITY.md](../SECURITY.md) or the
   [README](../README.md) say, update them** in the same commit, in the same plain,
   non-technical style. See below.
4. **Keep setup in step.** New environment variables, scopes or deploy steps go in
   `src/config.js`, `manifest.json`, `deploy/` and [setup.md](setup.md) together.
5. Run `npm test`. Before a release, also run
   `npm audit --omit=dev --audit-level=moderate` and record any accepted finding in
   the threat model.

Things that are permanently out of scope, so don't build them: deleting or editing
members' posts, bans or any enforcement beyond advice; a composer, slash commands or
message metadata; an external database. Adding a dependency, build step, linter or
formatter needs the maintainer's approval first.

### Changes that need a heads-up

The community relies on [SECURITY.md](../SECURITY.md) to describe what the bot can
see and do, so keep it true. Give a heads-up in Slack before deploying, and update
SECURITY.md, if a change would:

- add a scope or event subscription, or need the bot in another channel;
- read anything new (private channels, profiles, files' contents);
- put anything from a member's message into a reply or a log line;
- store anything (on disk, in a database, or in memory beyond a restart);
- connect anywhere other than Slack, or add a dependency;
- loosen the systemd sandbox or change who can read `/etc/bst/env`.

If you're unsure, ask. It costs one message.

## Releasing

1. `npm test` and `npm audit --omit=dev --audit-level=moderate`.
2. Set `version` in `package.json`, commit, and tag the commit.
3. `deploy/deploy.sh <ssh-target> <tag>` (see [setup.md](setup.md#5-deploy-to-a-server)).
4. Watch `journalctl -u bst -f` for `connected` and a quiet log.
