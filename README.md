# BST reply bot

A small helper bot for our buy/sell/trade (BST) Slack channel. When someone posts a
listing that's missing something, like a price or a location, the bot leaves a
short, friendly reply in the post's thread saying what's missing. When the post is
fixed, the bot tidies up after itself.

That's all it does. It **only gives advice**: it can't delete members' posts or ban
anyone, and it only acts in the one channel it's set up for.

## What members see

Say someone posts:

> FS Mechanical keyboard, barely used

That's a sale post (`FS` means "for sale") with no location, price or photo. The bot
adds a 🚨 reaction to the post and replies in its thread:

> Hi! This looks like a listing, but it doesn't follow the posting rules:
>
> - It's missing a location tag like [US]
> - It's missing a price
> - It's missing a photo. Sale and trade posts need exactly *one* photo showing the
>   item plus a handwritten note with your Slack name and the date of the post.
>
> This reply will be removed once you edit your post to fix every item above.

"rules" can link to the channel's rules page if we give the bot one.

When the member edits the post to fix it, the bot deletes its reply and removes the
🚨. If they don't fix it, nothing else happens. The bot won't pester them: it replies
once, and only replies again if a fixed post is later broken again. Even then, it
never replies more than 3 times to the same post (that count starts over if the bot
restarts).

## What counts as a listing

A post counts as a listing when one of these tags appears near the start (in its
first six words):

| Tag | Meaning |
| --- | --- |
| `FS` or `WTS` | For sale / want to sell |
| `FT` or `WTT` | For trade / want to trade |
| `WTB` or `ISO` | Want to buy / in search of |

A good listing has a short title, a location in brackets like `[US-PA]`, and, for
sale and trade posts, a price and exactly one photo. "Want" posts (`WTB`, `ISO`)
shouldn't include photos.

The bot also replies to a post with no tag if it has a photo, or says "for sale",
"selling" or "looking for", because it's probably a listing that forgot its tag.

It leaves alone replies inside threads, posts by other bots, and everything in other
channels. Moderators and admins get the same reminders as everyone else.

## What the bot can and can't do

When a Slack app is installed, it asks for a fixed list of permissions (Slack calls
them **scopes**). This bot asks for exactly three:

| Permission | What it lets the bot do | Why it needs it |
| --- | --- | --- |
| `channels:history` | Read messages in public channels the bot has been added to | To look at listings and check edits |
| `chat:write` | Post messages, and delete its own | To reply in threads and tidy up |
| `reactions:write` | Add and remove its own emoji reactions | To put the 🚨 on and take it off |

It **can't** read private channels or direct messages, delete or edit anyone else's
messages, see member profiles or email addresses, invite, remove or ban people, or
change any workspace settings. Slack enforces this, not just our code: without
those permissions, Slack refuses the request.

The bot doesn't keep a database or save anything to disk. Everything it remembers
(how many times it has replied to each post) disappears when it restarts.

## Is it safe?

Short answer: we've designed it to have as little power as possible, to never repeat
what members write, and to keep its passwords locked down. [SECURITY.md](SECURITY.md)
explains the risks we thought about and what we did about each one, in plain
language.

## For the people running and changing the bot

The technical docs are in [`docs/`](docs/):

- [docs/setup.md](docs/setup.md): creating the Slack app, configuring it, running it
  and deploying it to a server.
- [docs/development.md](docs/development.md): how the code fits together, reading the
  logs, fixing problems and making changes safely.
- [docs/spec.md](docs/spec.md): exactly what the bot does, rule by rule.
- [docs/threat-model.md](docs/threat-model.md): the detailed security design, with
  the test that backs up each claim.

The code is in the public domain under the [Unlicense](LICENSE).
