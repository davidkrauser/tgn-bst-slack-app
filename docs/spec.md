# Specification

What the bot does, and the constraints it is built under. The tests pin this
behaviour, and [the threat model](threat-model.md) explains why the security rules
exist. When a behaviour changes, change this file, the tests and, where it applies,
the threat model in the same commit. If the change affects what `README.md` or
`SECURITY.md` say, update them too (see
[development.md](development.md#changes-that-need-a-heads-up)).

The lamp is the bot's `:rotating_light:` reaction; a nudge is the lamp plus the
bot's thread reply. [development.md](development.md#how-it-works) walks through the
code that implements these rules.

## Scope

The bot watches one buy/sell/trade channel. When a post looks like a listing but
breaks the posting format, the bot replies once in the post's thread and marks the
post with a `:rotating_light:` reaction (the lamp). When the post is fixed, the bot
removes its replies and the lamp.

In scope:

- format nudges for new top-level posts and for edits of them;
- the lamp as the only record of a nudge;
- cleanup when a lamped post is edited into shape;
- a sample sandboxed systemd unit, an env template and a deploy script.

Out of scope, permanently:

- a composer, slash commands or message metadata;
- an external database;
- any enforcement beyond advice: the bot never deletes members' posts and never
  bans.

## Behaviour

### Project

1. `@slack/bolt` is the only runtime dependency; everything else is Node stdlib.
   Tests use `node:test` and `node:assert`. There is no build step, linter,
   formatter or dev dependency. The lockfile is committed. `package.json` declares
   `"engines": { "node": ">=22.8" }`, the first release whose test runner has the
   coverage-threshold flags that item 2 uses.
2. `npm test` runs every test and enforces Node's built-in coverage gate: lines
   ≥ 95%, branches ≥ 90%, functions ≥ 95%, over `src/` excluding the entry point
   `src/app.js` and `test/`. A shortfall fails `npm test`. A test imports every
   `src/*.js` except the entry point, found by listing the directory, so an
   untested module counts against the gate instead of vanishing from it.
3. The Slack app manifest turns on Socket Mode, subscribes only to the
   `message.channels` bot event, asks for exactly the bot scopes `chat:write`,
   `channels:history` and `reactions:write`, and turns off the Home and Messages
   tabs. The app's name and description name no workspace.
4. Configuration comes only from environment variables: `SLACK_BOT_TOKEN`,
   `SLACK_APP_TOKEN` and `SLACK_CHANNEL_ID` (required), and `BST_RULES_URL`
   (optional). If a required variable is missing or empty, the process prints one
   line to stderr naming every missing variable, never a value, and exits 1 before
   it connects to Slack.

### Recognising a listing

5. A post is a listing only if one of the tags `FS`, `FT`, `WTS`, `WTT`, `WTB` or
   `ISO` is a whole word (case-insensitive) among the first six words of its text.
   A word is a maximal run of ASCII letters or digits, except that a `[...]` or
   `(...)` group counts as one word; an unclosed group runs to the end of the
   text. Tags may come in any order and any position in the window, so `FS/FT`,
   `FS[US-PA]` and `FS:` all work.
6. Listing type: any sale tag (`FS`, `WTS`) makes it a sale; otherwise any trade
   tag (`FT`, `WTT`) makes it a trade; otherwise (`WTB`, `ISO`) it is a want. Sales
   and trades are judged alike.
7. The location is the contents of the first closed, non-empty `[...]` or `(...)`
   group in the window. Empty (`[]`) and unclosed groups are skipped, so a later
   group in the window can still supply it.
8. A price-shaped token is either a currency symbol (`$`, `€`, `£`), at most one
   whitespace character, then a digit followed by any run of digits, `,` or `.`;
   or a digit and such a run, at most one whitespace character, then one of `USD`
   `EUR` `GBP` `CAD` `AUD` `CHF` `JPY` `SGD` `HKD` (case-insensitive). A tab,
   newline or no-break space counts as the one whitespace character; two in a row
   do not. A token that starts inside a Slack strikeout (`~...~`) is struck and
   does not count. A post has a price iff it has at least one unstruck token. The
   bot never parses a price into a number and never displays one.
9. The title is the text before the earliest price-shaped token (struck or not)
   or strikeout. The tag words and the location group found in the window are
   removed from it, runs of spaces are collapsed, and leading and trailing
   separators (whitespace, `—`, `-`, `,`, `:`, `/`) are trimmed. Nothing else is
   stripped, so `FS [US] Watch $50` has the title `Watch`.
10. A listing's missing-field report lists, in this order: `title` (empty title),
    `location` (no location); then, for a sale or trade, `price` (no price) and
    `photo` (no image file) or `photos` (more than one image file); for a want,
    `wtb_photo` (any image file). An image file is a file whose mimetype starts
    with `image/`.
11. The parser is pure (no I/O, no clock, no randomness) and deterministic. It
    never throws, whatever the text and whatever the shape of the message's other
    fields. It runs in time linear in the input, with no backtracking-prone
    regular expressions: any input up to 100,000 characters parses in under 200 ms.
    Slack caps message text at 40,000 characters.

### When the bot nudges, and what it says

12. A message gets a nudge when either it is a listing with a non-empty
    missing-field report, or it is not a listing but has an image file or its
    text contains `for sale`, `selling` or `looking for` as whole words
    (case-insensitive). The second case is reported as `no_tag`.
13. The nudge is sent as standard markdown (`markdown_text`), with no emoji. It
    reads `Hi! This looks like a listing, but it doesn't follow the posting
    rules:`, a blank line, then one `- ` bullet per problem in report order, then
    a blank line and the closing sentence `This reply will be removed once you
    edit your post to fix every item above.` When
    `BST_RULES_URL` is set, "rules" is a markdown link to it, `[rules](url)`;
    otherwise it is plain text. The bullets are:

    | Code | Sentence |
    | --- | --- |
    | `title` | It's missing a short line describing the item |
    | `location` | It's missing a location tag like [US] |
    | `price` | It's missing a price |
    | `photo` | It's missing a photo. Sale and trade posts need exactly \*one\* photo showing the item plus a handwritten note with your Slack name and the date of the post. |
    | `photos` | It has more than one photo. Extra photos must go in a thread reply only. |
    | `wtb_photo` | WTB/ISO posts can't include images. Photos are for sale listings only. |
    | `no_tag` | It has no leading tag (FS, FT, WTS, WTT, WTB, or ISO). |

14. The nudge text is built only from these fixed sentences and the operator's
    rules URL. It never contains text from the member's message (no titles,
    prices, names or links), so a post cannot inject markdown, mentions or links
    into the reply.

### Which events the bot acts on

15. Only events in `SLACK_CHANNEL_ID`. Events from any other channel cause no Slack
    call, even if the bot was invited there.
16. Only new messages with no subtype or the `file_share` subtype, and
    `message_changed` edits. Every other subtype is ignored. Thread replies (a
    `thread_ts` that differs from the message's own `ts`) and edits of them are
    ignored. A `message_changed` event with no nested message, or with empty text,
    is ignored.
17. Messages from any bot (`bot_id` set, or subtype `bot_message`), this one
    included, are never nudged. Admins and owners are not exempt.

### Posting a nudge

18. A nudge is a thread reply to the post (`thread_ts` is the post's `ts`). The bot
    does not look up the post first.
19. The bot adds the lamp to the post before it posts the reply, so an edit that
    races the reply already sees the post marked. If adding the lamp fails, the
    failure is logged and the reply is still posted.
20. If posting fails, or Slack's response does not confirm that the reply landed in
    the requested thread (a `thread_ts` equal to the post's `ts`, on the response or
    on its `message`), the bot deletes the message it posted, if one was created,
    and removes its lamp.
    Every failure is logged, and none crashes the process.

### Edits

21. On a `message_changed` event the bot refetches the message from channel
    history, because the event's nested copy has no reactions or files, and decides
    from the refetched copy alone. If the refetch fails, or returns no message or a
    different one, the bot logs it and does nothing for that event.
22. A post has been nudged for its current episode iff this bot's own lamp is on
    it. A lamp from another user does not count. There is no other nudge state.
23. A non-compliant edit of a lamped post does nothing. A non-compliant edit of a
    post with no bot lamp gets a fresh nudge (18–20, subject to the cap in 26), so a
    fixed post that is broken again is nudged again.
24. A compliant edit of a lamped post makes the bot list every page of the thread,
    delete every reply this bot authored, and then remove its lamp. It never
    deletes the post, members' replies or other bots' replies. A reply that is
    already gone counts as clean. The lamp comes off only when the cleanup is
    complete: if a page listing or a delete fails, the failure is logged, the lamp
    stays, and the next edit retries. A compliant edit of a post with no bot lamp
    does nothing.
25. The bot's own user id comes from `auth.test` and is cached after the first
    success. If it is unknown and `auth.test` fails or returns no user id, the bot
    logs it and does nothing for that edit, because treating the lamp as absent would nudge an
    already-lamped post again; the next event retries. New-post nudges do not need
    the id.

### Limits, state and logging

26. A post gets at most 3 nudge attempts per process, new posts and edits alike,
    confirmed or not. After that a non-compliant edit adds no lamp and posts no
    reply, and the bot logs this once for the post. It may still look up the bot
    id and refetch the message. Cleanup is unaffected.
27. The per-post attempt count and the cached bot user id are the bot's only
    in-memory state. Both reset on restart. The bot writes nothing to disk.
28. A failed Slack call, a failed start and an uncaught error are each logged as
    one line, `<what> failed: <code>`, where `<what>` is a
    short context and `<code>` is the error's `data.error`, else its `code`, else
    `unknown_error`. For an uncaught error or unhandled rejection
    (`process failed: …`) with no code, the code is the error's `name` when the
    error is an `Error` whose name is a plain identifier
    (`/^[A-Za-z_$][\w$]{0,63}$/`). A failed start and an uncaught error exit 1. A
    log line never carries an error message, an error object, message text or a
    token.

### Security and release

29. [`docs/threat-model.md`](threat-model.md) lists the assets, the trust
    boundaries (every field of every Slack event is untrusted) and each threat
    with its mitigation and the test that proves it, or marks it an accepted risk
    with the reason. Every test it cites exists and passes.
30. `npm audit --omit=dev --audit-level=moderate` passes before a release, or each
    finding is recorded as an accepted risk in the threat model.
31. The committed tree names no workspace, host, personal email address, token or
    channel id. Examples use example.com.
32. The top-level `README.md` and `SECURITY.md` are the non-technical overview:
    plain, informal language, with any jargon explained where it is used or in the
    glossary at the end of `SECURITY.md`. `README.md` says what the bot does and
    can't do, and `SECURITY.md` explains the threat model's assets, mitigations and
    accepted risks in those terms, including how to switch the bot off. `docs/` is
    technical, for the people who run and change the bot: `docs/setup.md` lets
    someone outside the original workspace create the app from `manifest.json`,
    generate both tokens, configure, run, test and deploy it, and
    `docs/development.md` explains the code, the logs and how to make a change.
    Problems are reported to the person running the bot or the moderators in Slack;
    there is no separate vulnerability reporting process. `LICENSE` holds the
    Unlicense, and `package.json` declares `"license": "Unlicense"`.

### Deployment

33. `deploy/bst.service` is a sample systemd unit with no secrets and nothing
    host- or workspace-specific. It runs `src/app.js` as the non-root `bst` user
    and group from `WorkingDirectory=/opt/bst/app`, with `Type=simple`, an absolute
    `ExecStart`, `Restart=on-failure`, `RestartSec=5` and
    `After=`/`Wants=network-online.target`. Configuration comes only from
    `EnvironmentFile=/etc/bst/env`. It has no `Environment=` line, because systemd
    shows those values to every local user over D-Bus. It sets:
    `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`,
    `PrivateDevices=yes`, `NoNewPrivileges=yes`, `ProtectKernelTunables=yes`,
    `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`,
    `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes`,
    `ProtectProc=invisible`, `ProcSubset=pid`,
    `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictNamespaces=yes`,
    `RestrictRealtime=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`,
    `SystemCallArchitectures=native`, `SystemCallFilter=@system-service`, an empty
    `CapabilityBoundingSet=`, `UMask=0077` and `MemoryMax=256M`. It has no
    `ReadWritePaths`, since the bot writes nothing, and no
    `MemoryDenyWriteExecute`, since Node's JIT needs writable executable memory.
34. `deploy/bst.env.example` lists exactly the variables in 4, one per line, each
    with an empty value and a one-line comment, `BST_RULES_URL` marked optional. A
    header says to install it as `/etc/bst/env`, owned `root:root`, mode `0600`.
35. `deploy/deploy.sh <ssh-target> [git-ref]` deploys one committed version over
    ssh, logged in as root:
    1. The host comes only from the arguments. `git-ref` defaults to `HEAD`. It
       refuses a missing or empty target, a third argument, a target or ref that
       begins with `-`, and `HEAD` when tracked files have staged or unstaged
       changes. It resolves the ref to a full SHA and prints it.
    2. It ships committed files only, `git archive <sha>` into
       `/opt/bst/releases/<sha>`, never untracked or ignored files. Before writing
       anything the host side checks that the login is root and that the SHA is
       not already live.
    3. On the host it refuses an `/opt/bst/app` that is not a symlink, runs
       `npm ci --omit=dev --ignore-scripts` with `NODE_DIR` (default `/usr/bin`)
       first on `PATH`, then makes the release owned `root:root` with no group or
       other write bits.
    4. It points `/opt/bst/app` at the release, restarts `bst`, and after about 10
       seconds checks that `bst` is active. If not, it prints the last 30 journal
       lines, points the link back at the previous release if there is one,
       restarts, reports whether that restart failed, and exits non-zero.
    5. When healthy, it keeps the newest 3 releases and removes older ones, never
       the one the link points at.

    It never installs or edits the unit or the env file; that is one-time host
    setup, described in `docs/setup.md`.

### Tests

36. A test checks behaviour this spec wants, not how the code happens to work
    today: a refactor that keeps every behaviour leaves it passing. It asserts no
    call order beyond the three this spec fixes (lamp before reply in 19, the
    rollback in 20, listing and deleting before lamp removal in 24), no log wording
    beyond `<what> failed: <code>`, no private helpers and no fake internals.
37. Every expected value comes from this spec or is worked out by hand from it,
    never pasted from a run of the code.
38. Seeded random tests fix their seed in the file and report it, with the failing
    case, on failure. They cover the parser's invariants (never throws,
    deterministic, linear), the nudge text depending only on the problem list and
    the rules URL, and random event sequences: the lamp is on a post after each
    event iff its thread holds a bot reply (with no injected failures), and the
    handler never rejects, never deletes a message the bot did not author and never
    nudges a post more than 3 times (with and without injected failures). Slow
    reference versions of the tag window, the price rule and the missing-field
    report are compared with the parser on random inputs.
39. The test fake of the Slack Web API is checked against Slack's published
    documentation (see Interfaces) and the installed Web API client's error types:
    success shapes, the error codes the bot meets, and how the client raises them
    (a platform error carries Slack's code in `data.error`; a rate-limit or request
    error has the client's own `code`).
40. Events racing on one post are tested, asserting only outcomes this spec allows,
    or recorded in the threat model as accepted risks with their worst outcome.
41. Tests never connect to Slack or any host.

## Interfaces

Slack Web API methods the bot calls:

- [`auth.test`](https://docs.slack.dev/reference/methods/auth.test)
- [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage)
  (`channel`, `thread_ts`, `markdown_text`)
- [`chat.delete`](https://docs.slack.dev/reference/methods/chat.delete)
- [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add) and
  [`reactions.remove`](https://docs.slack.dev/reference/methods/reactions.remove)
- [`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history)
  (`latest` set to the post's ts, `inclusive`, `limit: 1`)
- [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies)
  (cursor-paged)

Events: [`message`](https://docs.slack.dev/reference/events/message), with the
[`message_changed`](https://docs.slack.dev/reference/events/message/message_changed)
and [`file_share`](https://docs.slack.dev/reference/events/message/file_share)
subtypes.

Event logic is importable and testable with no Slack connection and no environment.
In `src/`, only the entry point imports `@slack/bolt` or reads `process.env`; it
reads and validates the environment, builds the Bolt app and wires `message` events
to the handler.

## Edge cases and known limits

- A message with missing or oddly shaped `text`, `files` or `reactions` (null, not
  an array) is treated as having none, never a crash.
- An unclosed `[` or `(` runs to the end of the text as one word and gives no
  location.
- Colliding or out-of-order timestamps get no special handling.
- Socket disconnects and rate limits are left to Bolt's own reconnect and retry.
  The process does not exit.
- A post whose lamp add failed is nudged again on its next non-compliant edit. That
  counts toward the cap.
- Two edits close enough that both refetches run before either lamp lands can
  nudge twice, bounded by the cap. The threat model lists the other accepted races.
- `message_changed` also fires for non-edits (link unfurls, thread replies added or
  removed). They take the same refetch-and-decide path, which the lamp makes
  idempotent.
- Cleanup finds the bot's replies by their `user` field. Slack's documentation does
  not say outright that a reply posted with a bot token carries it.
- A Slack Connect file share arrives with no mimetype, so a photo shared that way
  counts as no image and the post is nudged for a missing photo. Accepted: the bot
  is meant for a channel that is not shared.
