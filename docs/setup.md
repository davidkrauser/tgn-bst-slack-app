# Setup and deployment

How to create the Slack app, configure and run the bot, and deploy it to a Linux
host as a sandboxed systemd service. This is for whoever runs the bot. For what the
bot does, see the [README](../README.md); for why it's built this way, see
[SECURITY.md](../SECURITY.md) and the [threat model](threat-model.md).

## How the pieces fit

```
 Slack workspace                          Linux host
 ┌──────────────────────┐   Socket Mode   ┌────────────────────────────────┐
 │ BST channel          │◄───(outbound)───│ bst.service                    │
 │ BST App (Slack app)  │   WebSocket +   │   user bst, sandboxed          │
 │   3 bot scopes       │   Web API calls │   node /opt/bst/app/src/app.js │
 └──────────────────────┘                 │ /etc/bst/env    (root, 0600)   │
                                          │ /opt/bst/releases/<sha>/       │
                                          └───────────────▲────────────────┘
                                                          │ deploy.sh over ssh
                                                  your machine (a git clone)
```

- **The Slack app** is defined by `manifest.json`. It holds the bot's identity and
  permissions.
- **Two tokens** connect the process to the app: the bot token (`xoxb-`) authorises
  Web API calls, and the app-level token (`xapp-`) opens the Socket Mode connection.
- **The process** is a single Node.js program (`src/app.js`). It dials out to Slack
  over a WebSocket, so it needs outbound HTTPS and no inbound port or public URL.
- **On the host**, systemd runs it as the unprivileged `bst` user, reading the tokens
  from `/etc/bst/env`. Each deployed version lives in its own directory under
  `/opt/bst/releases/`, and the `/opt/bst/app` symlink points at the live one.
- **`deploy/deploy.sh`** ships one committed version from your clone to the host over
  ssh, switches the link, and rolls back if the new version doesn't start.

## 1. Create the Slack app from the manifest

1. Go to <https://api.slack.com/apps> and choose **Create New App**, then **From an
   app manifest**.
2. Pick your workspace and paste the contents of `manifest.json`.

The manifest turns on Socket Mode, subscribes only to the `message.channels` event,
asks for exactly the bot scopes `chat:write`, `channels:history` and
`reactions:write`, and turns off the Home and Messages tabs. It asks for no user
scopes.

## 2. Generate the tokens

- **Bot token:** install the app to your workspace, then copy the **Bot User OAuth
  Token** from **OAuth & Permissions**. It starts with `xoxb-`.
- **App-level token:** under **Basic Information**, **App-Level Tokens**, generate a
  token with the `connections:write` scope. It starts with `xapp-`.

Treat both like passwords: don't paste them into Slack, issues, commits or shell
history you share.

Then invite the bot to the one channel it should watch, and only that one (for
example, `/invite @BST Reply Bot` in that channel). Copy the
channel's id from the channel's details (it starts with `C`). The channel must be
public: the manifest subscribes only to `message.channels`, so the bot sees nothing
in a private channel.

## 3. Configuration

Configuration is environment variables only. There is no config file in the repo.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | The bot token (`xoxb-`). |
| `SLACK_APP_TOKEN` | yes | The app-level token (`xapp-`) for Socket Mode. |
| `SLACK_CHANNEL_ID` | yes | The id of the one channel the bot watches. |
| `BST_RULES_URL` | no | The link for the word "rules" in replies, such as `https://example.com/rules`. |

Without `BST_RULES_URL`, "rules" in the reply is plain text. Set it to your
channel's rules page so members can click through.

A missing or empty required variable stops the process with one line naming it
(never its value), before it connects:

```
Missing env var(s): SLACK_APP_TOKEN, SLACK_CHANNEL_ID
```

## 4. Run it locally

You need Node.js 22.8 or later: the test script uses coverage-threshold flags added
in that release.

```sh
npm ci
export SLACK_BOT_TOKEN=...
export SLACK_APP_TOKEN=...
export SLACK_CHANNEL_ID=...
export BST_RULES_URL=https://example.com/rules   # optional
npm start
```

It prints `connected` once the Socket Mode connection is up. To run the tests (they
never touch the network):

```sh
npm test
```

[development.md](development.md) covers the tests and the code in more detail.

## 5. Deploy to a server

The sample unit `deploy/bst.service` runs the bot as an unprivileged `bst` user
under a strict sandbox, and `deploy/deploy.sh` ships a committed version of the code
to the host over ssh.

### One-time host setup

Run these as root on the host. The host needs Node.js 22.8 or later (from a distro
package or installed by hand), plus `npm`, `tar` and systemd. If you install Node by
hand, put it somewhere outside any home directory, such as `/usr/local`, because the
unit sets `ProtectHome=yes`.

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

Then edit `/etc/bst/env` as root. It holds the variables from
[Configuration](#3-configuration), one `NAME=value` per line with no quotes or
`export`. Filled in, the settings look like this (the template's comments can stay):

```sh
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C...
BST_RULES_URL=https://example.com/rules
```

Leave `BST_RULES_URL=` empty if there is no rules page. After changing the file
later, run `systemctl restart bst`; systemd reads it only at start.

Copy `deploy/bst.service` to `/etc/systemd/system/`. Its `ExecStart` runs
`/usr/bin/node`; if `command -v node` prints another path, edit `ExecStart` to
match. Then:

```sh
systemctl daemon-reload
systemctl enable bst
```

Don't start it yet. `/opt/bst/app` exists only after the first deploy, which starts
the service.

### Deploying a version

Run this from a clone of the repository on your own machine:

```sh
deploy/deploy.sh <ssh-target> [git-ref]
```

The ssh login must be root, and the script checks this before it writes anything to
the host. `git-ref` defaults to `HEAD`, which must have no staged or unstaged
changes to tracked files. Run `npm test` first: the script doesn't run the tests.

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
it suits your host. [development.md](development.md#reading-the-logs) explains the
log lines.

## Day-to-day operations

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

Do this whenever a token may have leaked, or someone who had access to
`/etc/bst/env` steps away.

- **App-level token:** revoke and regenerate it under **Basic Information**,
  **App-Level Tokens**.
- **Bot token:** reinstalling the app may not change it, so revoke the old one first
  (for example with Slack's `auth.revoke` method), then reinstall the app and copy
  the new **Bot User OAuth Token**.

Then edit `/etc/bst/env` and run `systemctl restart bst`.

If you need the bot stopped immediately and can't reach the host, a workspace admin
can uninstall the app in Slack. That revokes the bot token, and an app that isn't
installed gets no events. Reinstalling issues a new bot token.

### Turning it off

- Remove the bot from the channel: it stops acting there at once.
- `systemctl stop bst` (and `systemctl disable bst` to keep it off after a reboot).
- Uninstall the app from the workspace: this also revokes the bot token.
