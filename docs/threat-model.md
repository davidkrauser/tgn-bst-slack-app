# Threat model

The bot watches one Slack channel and replies once, in thread, to listing posts
that break the posting format. It runs as a single Node process on a host the
operator controls. This document lists what is worth protecting, what is
trusted, and each threat with its mitigation and the test that proves it. A
threat that is not fully mitigated is marked as an accepted risk, with the
reason.

This is the technical version. [SECURITY.md](../SECURITY.md) covers the same
ground without the jargon. The two must agree: when a mitigation, an accepted risk
or a proving test changes here, update SECURITY.md in the same commit.

Terms used below:

- **The lamp:** the bot's `:rotating_light:` reaction on a post. The bot's own lamp
  is the only record that a post has been nudged.
- **A nudge:** the lamp plus the bot's one thread reply listing what is missing.
- **ts:** a Slack message timestamp, which is also its id within a channel.
- **Operator:** whoever runs the host and holds the tokens.

## Assets

- **`SLACK_BOT_TOKEN`.** Grants the scopes `chat:write`, `channels:history` and
  `reactions:write`: post replies, read channel history, and add or remove the
  `:rotating_light:` lamp.
- **`SLACK_APP_TOKEN`.** Opens the Socket Mode connection over which the bot
  receives events.
- **Channel content.** The bot reads public channel history and the text of
  posts it is shown.
- **The bot's ability to post and delete its own messages.** Misused, it could
  spam the channel or remove other people's replies.

The bot's only in-memory state is the per-post nudge counter and the cached bot
user id. Both reset on restart. The bot writes nothing to disk.

## Trust boundaries

- Every field of every Slack event is untrusted input: text, files, channel,
  subtype, timestamps, thread ids and author ids.
- The Slack API answers the bot uses are shape-checked before use. A refetched
  message or bot id answer with the wrong shape is a failure, and the bot does
  nothing for that event. A reply page with no message list counts as empty,
  and a post reply counts as confirmed only when it carries the thread ts. A
  successful answer to `reactions.add`, `reactions.remove` or `chat.delete` is
  never read. For a failed call only the error code is read, to log it and, in
  cleanup, to treat a `chat.delete` that fails with `message_not_found` as
  already clean.
- The host and its operator are trusted. Anyone with root on the host, or with
  read access to the environment file, can already do everything the bot can.

## Threats

### 1. Token disclosure in the repo

**Mitigation:** Tokens come only from the environment. The env template holds
empty values only, and a missing required variable stops the process with a
line that names the variable and never a value.

**Proof:** `test/deploy.test.js` "the env example names exactly the four
variables, all empty" and "neither file holds a token-shaped string";
`test/app.test.js` "missing names are reported without leaking any value".

### 2. Token disclosure in logs and error output

**Mitigation:** Every Slack-call failure is logged as `<what> failed: <code>`,
never as an error object, a token or message text. Startup and fatal errors are
logged the same way, and the process exits 1. An uncaught error or rejection
with no code logs its error name instead, but only when it is an `Error` whose
name is a plain identifier (for example `process failed: TypeError`);
otherwise it logs `unknown_error`, and never the message.

**Proof:** `test/post-nudge.test.js` "a token-bearing error from `<method>` logs
only its code" (for `reactions.add`, `chat.postMessage`, `chat.delete` and
`reactions.remove`) and "a plain error logs unknown_error, not its message";
`test/edit-lookup.test.js` "a token-bearing error logs only its code" and "no
failure line contains the message text"; `test/clean-up-nudge.test.js` "a
token-bearing error from `<method>` logs only its code" (for
`conversations.replies`, `chat.delete` and `reactions.remove`);
`test/handlers.test.js` "a token-bearing error from each Slack call" (every
Slack call the handler makes, including `auth.test`);
`test/app.test.js` "a failed start logs only the error code and exits 1", "an
unhandled rejection logs only the error code and exits 1", "an uncaught
exception logs only the error code and exits 1", "an uncaught error with no
code logs only its name and exits 1", "an uncaught error with only a code logs
that code and exits 1", "an odd error name logs unknown_error and exits 1", "an
error name that is not a string logs unknown_error and exits 1", "a
non-Error rejection logs unknown_error and exits 1" and "an unhandled rejection
with no code logs only its name and exits 1". In the three Slack-call test
files, every test also checks that nothing it logs carries the message text, a
reply's text or a token. In `test/handlers.test.js` and `test/scenarios.test.js`
(through `test/helpers/log-guard.js`), every test also checks that each log call
is a single string argument on one line, ending in one code token when it is a
`<what> failed: <code>` failure line, with no extra argument, that no line is
empty or starts with a space, and that no line carries an event, message,
canned response or reply text or a token, or any run of 12 characters of one.
The three Slack-call test files apply the same run-of-12 rule to the texts they
watch.

**Accepted risk:** Bolt's own logger lines interpolate error messages (for
example `Failed to retrieve a new WSS URL (error: ...)`). At Bolt's default
level, which the bot never raises, they carry no token or message text.

### 3. Token disclosure on the host

**Mitigation:** The unit reads `EnvironmentFile=/etc/bst/env` and has no
`Environment=` line, because systemd shows those values to every local user
over D-Bus.

**Proof:** `test/deploy.test.js` "the unit reads configuration only from
/etc/bst/env".

The env file's `root:root` mode `0600` is operator setup, stated in the
template header. No test covers it.

### 4. Acting outside the configured channel

**Mitigation:** The handler ignores every event whose channel is not
`SLACK_CHANNEL_ID`, and every subtype other than none, `file_share` and
`message_changed`.

**Proof:** `test/handlers.test.js` "a non-compliant post in another channel
gets no calls" and "every ignored event gets no calls".

### 5. Reply-text injection

**Mitigation:** The reply is built only from fixed sentences and the operator's
rules URL. No member text, mention, link or title reaches it.

**Proof:** `test/nudge.test.js` "mentions, links and the title stay out of the
reply"; `test/handlers.test.js` "member text cannot reach the reply";
`test/properties.test.js` "reply text depends only on the problems and the rules
URL" (random messages with markers in every member field, run with and without a
rules URL).

### 6. Parser denial of service

**Mitigation:** The parser runs in linear time, avoids backtracking-prone
patterns and never throws.

**Proof:** `test/parse-robustness.test.js` "adversarial input stays fast and
deterministic: ..." (a parameterized test, one case per input), "seeded random
messages never throw, are deterministic and have a known shape", "seeded random
100,000-character texts parse in under 200 ms" and "odd input returns null
without throwing"; `test/nudge.test.js` "near misses of ... answer quickly" (also
parameterized).

### 7. Edit-toggle amplification

**Mitigation:** A post gets at most 3 nudge attempts per process, new posts and
edits alike, whether or not Slack confirms the reply. After that, non-compliant
edits add no lamp and post no reply (they may still look up the bot id and refetch
the message), and the cap is logged once. Cleanup of a fixed post is unaffected.

**Proof:** `test/scenarios.test.js` "a post toggled between broken and fixed is
nudged at most 3 times", "a failed nudge attempt counts toward the cap", "the
cap is per post" and "a restart starts every post's count afresh";
`test/handlers.test.js` "a repeated new-post event is nudged at most 3 times"
and "simultaneous repeated new-post events are nudged at most 3 times";
`test/scenarios.test.js` "the cap is logged once for each capped post";
`test/properties.test.js` "the handler never rejects, deletes only bot replies and
nudges a post at most 3 times" (random event sequences, with and without injected
Slack failures).

**Accepted risk:**

- Two edits racing before the lamp lands can double-nudge.
- A failed lamp add means the next non-compliant edit nudges again.
- The cap resets on restart.

All three are bounded by the cap.

**Accepted risk:** The counter keeps one entry per nudged post until restart.
`MemoryMax=256M` and `Restart=on-failure` in the unit bound the effect.

### 8. Deleting content the bot did not author

**Mitigation:** Cleanup deletes only replies whose author is the bot's own user
id, never the post itself, members' replies or other bots' messages. Edits are
decided from a fresh copy of the message in channel history, never the event's
copy, and fail closed when that copy or the bot's user id cannot be had, so
forged event fields cannot steer a decision.

**Proof:** `test/clean-up-nudge.test.js` "deletes the bot's replies, spares
others', removes the lamp" and "a parent entry authored by the bot is
never deleted"; `test/scenarios.test.js` "another user's lamp is left alone when
the post is fixed", "the decision uses the refetched copy, not the event's" and
"a failed bot id lookup fails closed, retries, then caches";
`test/properties.test.js` "the handler never rejects, deletes only bot replies and
nudges a post at most 3 times" (every `chat.delete` in random event sequences,
with and without injected Slack failures, targets a message the bot posted) and
"a post carries the bot's lamp exactly when its thread holds a bot reply".

### 9. Excessive OAuth scopes

**Mitigation:** The manifest requests exactly three bot scopes, no user scopes,
and one event subscription.

**Proof:** `test/manifest.test.js` "requests exactly the three bot scopes and no
user scopes" and "subscribes only to message.channels".

**Accepted risk:** `channels:history` reads any public channel the bot is a
member of. The bot acts only in one, and the operator should invite it only
there.

### 10. Supply chain

**Mitigation:** `@slack/bolt` is the only runtime dependency, there are no
dev dependencies, and the lockfile is committed.

What the deploy script puts on the host is exactly one committed commit.
`deploy/deploy.sh` resolves the ref to a full commit SHA, and it refuses to
deploy `HEAD` from a tree whose tracked files have staged or unstaged changes.
It ships that commit with `git archive`, so untracked, ignored and excluded
files never reach the host.

On the host the script installs with `npm ci --omit=dev --ignore-scripts`. That
gives the lockfile's exact versions, no dev dependencies, and no package
install script run as root (checked by review, no test: the host side never
runs in a test).

**Proof:** `test/package.test.js` "Bolt is the only runtime dependency and there
are no dev dependencies". For the commit-only claim,
`test/deploy-script.test.js` "an unstaged change to a tracked file refuses the
default ref" and "a staged change refuses the default ref" (the dirty-tree
refusals, each before any ssh call), "a clean tree ships only the committed
files of HEAD" (the archive's exact file list, with an untracked file, an
ignored directory and an excluded directory present in the tree) and "a dirty
tree can still deploy another ref, shipping that commit" (the explicit-ref
archive).

`npm audit --omit=dev --audit-level=moderate` is a release check (see Operator
checks).

**Accepted risk:** Bolt's transitive dependencies are trusted as Bolt's
maintainers ship them, and are covered only by the audit check above.

### 11. A compromised bot process

**Mitigation:** The process runs as the non-root `bst` user under the unit's
sandbox: `ProtectSystem=strict` (code and system read-only), `NoNewPrivileges`,
an empty capability set, `SystemCallFilter=@system-service`, restricted address
families and `MemoryMax`. It has no `ReadWritePaths`. Besides its own private
`/tmp` and `/var/tmp`, `/dev/shm` stays writable and is shared with the host.

After install, the deploy script makes each release under `/opt/bst/releases/`
owned `root:root` with no group or other write bits, and `/opt/bst/app` is a
link to the release in use. So the `bst` user cannot change the code it runs,
even outside the unit's read-only view (checked by review, no test). Because
the install uses `--ignore-scripts`, no dependency code runs as root at install
time (checked by review, no test).

**Proof:** `test/deploy.test.js` "the unit sets every sandbox directive", "the
unit runs as a non-root user with an absolute ExecStart" and "the unit has no
ReadWritePaths or MemoryDenyWriteExecute".

**Accepted risk:** The sandbox limits address families, not destinations, so a
compromised process could connect anywhere the host can reach. The bot's code
connects only to Slack. Restricting destinations would need per-host firewall rules
for Slack's changing addresses, which a sample unit can't ship.

### 12. Events racing on one post

**Mitigation:** The lamp goes on before the reply, so a post the bot is about
to answer is already marked. Cleanup deletes only the bot's own replies, so
two overlapping cleanups cannot reach anything else. A reply that is already
gone counts as clean. Overlapping cleanups still end with the lamp off,
whichever finishes first. The per-post cap bounds how many nudges any mix of
events can add.

**Proof:** `test/interleavings.test.js` "a fix delivered twice, overlapping,
deletes only the bot's reply and ends clean", "the thread change that deleting
the reply causes does not repeat the cleanup" and "a post broken again while its
cleanup is in flight ends clean and is nudged by its next edit". Each runs one
event while another is held part-way through a Slack call. In all of them
every handler resolves, the post and the member's reply are still there, and
the bot's lamp and reply are gone together. The double nudge race is listed
under threat 7.

The same file also runs an edit while a new post's nudge is held at one of
three points: before the lamp lands, between the lamp and the reply, and while
the reply posts. Each point is tried once with the edit fixing the post and
once with the post still broken. In all of them every handler resolves, the
post and the member's reply stay, the bot deletes nothing but its own replies,
and the post gets at most 3 nudges. The tests are "a post fixed before the
nudge's lamp lands keeps the lamp and the nudge until its next edit", "a post
broken again before the nudge's lamp lands is nudged twice, within the cap",
"a post fixed after the lamp lands but before the reply is asked for ends with
an orphan reply and no lamp", "a post left broken after the lamp lands but
before the reply is asked for keeps its lamp and one reply", "a post fixed
before the reply is posted ends with an orphan reply and no lamp", "a post left
broken before the reply is posted keeps its lamp and one reply", "a post fixed
after the reply is posted but before Slack answers loses the reply and the
lamp" and "a post left broken after the reply is posted but before Slack
answers keeps its lamp and one reply".

That a reply already gone counts as clean is proven by
`test/clean-up-nudge.test.js` "a reply that is already gone counts as clean". The
cap on how many nudges any mix of events can add is proven under threat 7, by
`test/handlers.test.js` "simultaneous repeated new-post events are nudged at most
3 times" and `test/properties.test.js` "the handler never rejects, deletes only
bot replies and nudges a post at most 3 times".

**Accepted risk:** A post broken again while its cleanup is in flight is left
un-nudged. The edit that broke it sees the lamp and does nothing, then the
cleanup removes the lamp and the reply. The worst outcome is a non-compliant
post with no nudge until its next edit. The next edit repairs it, and
preventing it would need state beyond the lamp, which the design forbids.

**Accepted risk:** A post fixed before the first nudge's lamp lands keeps the
lamp and the nudge. The edit sees no lamp and a compliant post, so it does
nothing, and the nudge then goes on. The worst outcome is a stale nudge on a
fixed post until its next edit, which cleans it up (the test shows this).
Preventing it would need a re-check after the lamp, which means more Slack
calls for every nudge.

**Accepted risk:** A post fixed after the first nudge's lamp lands but before
its reply posts ends with an orphan bot reply and no lamp. The edit finds no
reply to delete and removes the lamp, then the reply posts. Later fixes leave
it, because there is no lamp. The worst outcome is an orphan nudge on a fixed
post until it is broken and fixed again, which removes every bot reply and the
lamp (the test shows this). The lamp is the only nudge state, and re-checking
after the reply would need more Slack calls per nudge.

## Operator checks

These are checks to run by hand, not tests:

- After installing the unit, run `systemd-analyze security bst` on the host and
  review what it reports.
- Before each release, run `npm audit --omit=dev --audit-level=moderate`.
