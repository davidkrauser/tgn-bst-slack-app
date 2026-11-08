# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting. On the repository's **Security** tab,
choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

## Supported versions

Only the latest commit on the default branch gets fixes.

## Threat summary

The full threat model is in [docs/threat-model.md](docs/threat-model.md). This is a
short version of it.

What is at stake: the two Slack tokens, the channel's content, and the bot's ability
to post and to delete its own messages.

Every field of every Slack event is untrusted input. The host and its operator are
trusted.

The main mitigations:

- Tokens come only from the environment and an `EnvironmentFile`, never from the
  repo or an `Environment=` line.
- Slack-call failures and fatal errors are logged as error codes, never as error
  objects, tokens or message text.
- The bot acts only in the configured channel.
- Reply text is built from fixed sentences and the operator's rules URL. It never
  quotes members.
- The parser runs in linear time and never throws.
- A post gets at most 3 nudge attempts per process.
- Cleanup deletes only the bot's own replies.
- The manifest asks for three bot scopes and no user scopes.
- `@slack/bolt` is the only runtime dependency, and the lockfile is committed.
- The sample systemd unit runs the bot as a non-root user in a sandbox.
- The deploy script ships one committed commit and installs it with install scripts
  off, into a root-owned release tree. The install flags and the release tree are
  checked by review, not by a test.

Accepted risks, in short: Bolt's own log lines can carry error messages, Bolt's
dependencies are trusted as Bolt ships them, `channels:history` covers any public
channel the bot has joined, and a few races on one post can leave a stale, extra or
missing nudge until later edits clear it. The nudge cap resets on restart. The threat
model lists each one with its reason.
