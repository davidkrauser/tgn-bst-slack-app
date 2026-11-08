# BST reply bot

A small Slack bot that watches one buy/sell/trade channel and replies once, in
thread, to listing posts that break the posting format. It is advice only: it never
deletes members' posts and never bans anyone.

## What the bot does

The bot watches a single channel. A top-level post counts as a listing when one of
the tags `FS`, `WTS`, `FT`, `WTT`, `WTB` or `ISO` is among its first six words.

A listing should have:

- a title;
- a location in `[...]` or `(...)`;
- a price, for a sale or trade post;
- exactly one photo, for a sale or trade post, or no photo at all for a want post
  (`WTB`, `ISO`).

A post with no tag is also nudged when it has an image, or when its text says "for
sale", "selling" or "looking for".

When a new post, or an edit of a post, breaks the format, the bot adds a
`:rotating_light:` reaction to the post and replies once in its thread. The reply
lists what is missing. When `BST_RULES_URL` is set, the word "rules" in the reply
links to it. The reply never quotes the post.

When the post is edited into shape, the bot deletes its own replies in the thread
and removes its reaction. The reaction is the only record that a post was nudged.

The bot never deletes members' posts or replies. A post gets at most 3 nudges per
run of the bot. Thread replies, posts in other channels and posts by bots are
ignored.

The exact rules, including the reply wording and what counts as a price, are in
[docs/spec.md](docs/spec.md). [docs/threat-model.md](docs/threat-model.md) covers
the security design.

## Creating the Slack app from the manifest

1. Go to <https://api.slack.com/apps> and choose Create New App, then From an app
   manifest.
2. Pick your workspace and paste the contents of `manifest.json`.

The manifest turns on Socket Mode, subscribes only to the `message.channels` event,
asks for exactly the bot scopes `chat:write`, `channels:history` and
`reactions:write`, and turns off the Home and Messages tabs.

## Generating the tokens

- Bot token: install the app to your workspace, then copy the Bot User OAuth Token
  from OAuth & Permissions. It starts with `xoxb-`.
- App-level token: under Basic Information, App-Level Tokens, generate a token with
  the `connections:write` scope. It starts with `xapp-`.

Then invite the bot to the one channel it should watch, and only that one. Copy the
channel's id from the channel's details. The channel must be public: the manifest
subscribes only to `message.channels`, so the bot sees nothing in a private channel.

## Environment variables

Configuration is environment only.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | The bot token (`xoxb-`). |
| `SLACK_APP_TOKEN` | yes | The app-level token (`xapp-`) for Socket Mode. |
| `SLACK_CHANNEL_ID` | yes | The id of the one channel the bot watches. |
| `BST_RULES_URL` | no | The link for the word "rules" in replies, such as `https://example.com/rules`. |

A missing or empty required variable stops the process with one line naming it,
before it connects.

## Running it

Clone this repository. You need Node.js 22.8 or later: the test script uses
coverage-threshold flags added in that release.

```sh
npm ci
export SLACK_BOT_TOKEN=...
export SLACK_APP_TOKEN=...
export SLACK_CHANNEL_ID=...
npm start
```

The bot connects over Socket Mode, so it needs no public URL and no open port.

## Running the tests

```sh
npm test
```

This runs every test offline and enforces a coverage gate over `src/`, excluding the
entry point: lines 95%, branches 90%, functions 95%. To run one file:

```sh
node --test test/parse.test.js
```

## Design constraints

- A single runtime dependency, `@slack/bolt`, with a committed lockfile. There is no
  build step and there are no dev dependencies.
- Stateless apart from the reaction. The per-post nudge count and the cached bot
  user id live in memory and reset on restart. Nothing is written to disk and there
  is no database.
- Advisory only: it never deletes members' posts and never bans.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability. The code is under
the [Unlicense](LICENSE) and is in the public domain.

## Deploying

This section sets the bot up as a systemd service on a Linux host. The sample unit
`deploy/bst.service` runs it as an unprivileged `bst` user under a strict sandbox,
and `deploy/deploy.sh` ships a committed version of the code to the host over ssh.

### One-time host setup

Run these as root on the host. The host needs Node.js 22.8 or later (as in "Running
it", from a distro package or installed by hand), plus `npm`, `tar` and systemd. If
you install Node by hand, put it somewhere outside any home directory, such as
`/usr/local`, because the unit sets `ProtectHome=yes`.

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin bst
install -d -m 0755 /opt/bst /opt/bst/releases
install -d -m 0755 /etc/bst
```

The unit runs as `User=bst` and `Group=bst`. On most systems `useradd --system` also
creates the group `bst`; check with `getent group bst`, and create it with
`groupadd --system bst` if it is missing.

Copy `deploy/bst.env.example` to the host, then install it as the environment file
and fill in the values:

```sh
install -m 0600 -o root -g root bst.env.example /etc/bst/env
```

Then edit `/etc/bst/env` as root. It holds the same variables as "Environment
variables" above.

Copy `deploy/bst.service` to `/etc/systemd/system/`. Its `ExecStart` runs
`/usr/bin/node`; if `command -v node` prints another path, edit `ExecStart` to
match. Then:

```sh
systemctl daemon-reload
systemctl enable bst
```

Do not start it yet. `/opt/bst/app` exists only after the first deploy, which
starts the service.

### Deploying

Run this from a clone of the repository on your own machine:

```sh
deploy/deploy.sh <ssh-target> [git-ref]
```

The ssh login must be root, and the script checks this before it writes anything to
the host. `git-ref` defaults to `HEAD`, which must have no staged or unstaged
changes to tracked files.

The script prints the commit SHA it ships. Then it:

1. sends only the files committed at that SHA (it uses `git archive`) to
   `/opt/bst/releases/<sha>` on the host;
2. runs `npm ci --omit=dev --ignore-scripts` there, so the host needs to reach the
   npm registry, and then makes the tree root-owned and not group- or world-writable;
3. points the `/opt/bst/app` link at the release and restarts `bst`;
4. waits about 10 seconds and checks that `bst` is active. If it is not, the script
   prints the last 30 journal lines, points the link back at the previous release,
   restarts `bst` and exits with a failure. A first deploy has nothing to roll back
   to: the link stays on the failed release, and `bst`, which you enabled during
   setup, keeps restarting. Run `systemctl stop bst` to stop it until you deploy a
   working release;
5. keeps the newest 3 releases and removes older ones, never the one the link points
   at.

If `/opt/bst/app` exists and is not a symlink, the script stops after copying the
release and before installing it. It refuses to redeploy the SHA that is already
live, before it writes anything; run `systemctl restart bst` instead. It never
touches the unit or `/etc/bst/env`.

`NODE_DIR` is the directory holding `node` and `npm` on the host. It defaults to
`/usr/bin`. For example:

```sh
NODE_DIR=/usr/local/bin deploy/deploy.sh <ssh-target>
```

### Rolling back

Deploy an older version the same way:

```sh
deploy/deploy.sh <ssh-target> <older-sha-or-tag>
```

The ref is resolved and shipped like any other. The automatic rollback above covers
only a release that fails to start.

### Checking the result

```sh
systemctl status bst
journalctl -u bst
systemd-analyze security bst
```

The last command rates the unit's sandbox. Read what it reports and decide whether
it suits your host.

### Why the tokens live in an environment file

systemd shows `Environment=` values to every local user over D-Bus
(`systemctl show`), whatever the unit file's permissions. So the unit has no
`Environment=` line. It reads `EnvironmentFile=/etc/bst/env`, which only root can
read, and systemd reads it as root before it drops to `bst`.

### Updating Node

- Installed from a distro package: the system's package updates cover it. Restart
  `bst` afterwards with `systemctl restart bst`.
- Installed by hand, for example from a tarball: install the new version and make
  sure the unit's `ExecStart` still points at `command -v node`. If you edit the
  unit, run `systemctl daemon-reload`. Pass the matching `NODE_DIR` to the next
  deploy, and run `systemctl restart bst`.

### Rotating tokens

Replace the token in the app's settings at <https://api.slack.com/apps>. App-level
tokens can be revoked and regenerated under Basic Information. Reinstalling the app
may not change the bot token, so revoke the old one first (for example with Slack's
`auth.revoke` method), then reinstall the app and copy the new Bot User OAuth Token.
Then edit `/etc/bst/env` and run `systemctl restart bst`.
