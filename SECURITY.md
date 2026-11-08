# Is this bot safe?

This page explains what the bot can see and do, what could go wrong, and what we've
done about it. If a word is unfamiliar, [Words you might see](#words-you-might-see)
at the bottom explains it.

## The short version

- **It has very little power.** It can read the channel it's in, post and delete its
  *own* replies, and add or remove its *own* 🚨 reaction. That's it. Slack itself
  stops it from doing anything else.
- **It doesn't keep anything.** No database, no saved files, no copies of messages.
- **It never repeats what members write.** Its replies are made only from a fixed set
  of sentences, so nobody can trick it into posting links, @-mentions or anything
  else.
- **Its passwords are locked away.** The bot's tokens (its passwords) aren't stored
  in the code. They live in a file on the server that only the server's
  administrator can read, and they never show up in logs.
- **It's checked automatically.** Most of these promises are backed by automated
  tests, and the whole test suite has to pass before a release. The few that can
  only be checked by hand, like the permissions on the server's token file, are
  part of the setup steps.

## What the bot can see

- Messages posted in the channel it has been added to, including whether a post has
  photos. It checks a photo's file type but never downloads or looks at the photo.
- The replies in a post's thread, when it tidies up. It only checks who wrote each
  one, so it can find and delete its own.
- Nothing in private channels or direct messages. It doesn't ask Slack for that
  permission, so Slack won't show it to the bot.
- No member profiles, email addresses or member lists.

The bot looks at each message as it arrives, decides whether to reply, and then
forgets it. The only things it holds in memory are a count of how many times it has
replied to each post (stored against the post's timestamp, not its text) and its own
Slack ID. Both are wiped when it restarts.

## What the bot can do

- Post replies in threads, and delete replies **it** wrote.
- Add and remove its **own** 🚨 reaction.

It can't delete or edit members' posts or replies, remove other people's reactions,
invite, kick or ban anyone, or change any settings. The design rules for the
project forbid adding any of that, too: the bot only ever gives advice.

## What could go wrong, and what we did about it

### Someone gets hold of the bot's tokens

A token works like a password. Someone who had the bot's tokens could act as the bot:
read the channels it's in, post messages under its name, delete the bot's own
messages and add reactions. They
**couldn't** read private channels or direct messages, or do anything an admin can
do, because the bot was never given those permissions.

What keeps the tokens safe:

- They are never in the code or the repository. A test checks the setup files for
  anything that looks like a token.
- On the server they live in one file that only the server's administrator account
  can read. The bot itself runs as a separate, limited account.
- The bot never writes a token to its logs, even when something fails. Tests check
  its log lines for this.
- The bot connects out to Slack and doesn't accept connections from the internet,
  so it adds nothing on the server for an outsider to poke at.

### Members' messages leak somewhere

- The bot doesn't save messages anywhere.
- Its logs record only short error codes (like `not_in_channel`), never message text,
  names or Slack's full responses. Tests check this for every kind of failure.
- Its replies never quote the member's post.
- The bot's code only ever talks to Slack.

### Someone tricks the bot with a crafted message

We treat every message, and every detail Slack sends with it, as possibly hostile.

- The reply can't be hijacked: it's built only from fixed sentences, so a post can't
  smuggle in links or @-mentions.
- A huge or strangely written message can't slow it down or crash it. Tests throw
  thousands of random and deliberately nasty messages at it.
- When a post is edited, the bot asks Slack for the real current post rather than
  trusting the details in the notification. If it can't get a clear answer, it does
  nothing.

### The bot misbehaves: spamming, or deleting the wrong thing

- It replies to a post at most 3 times, however often the post is edited.
- When it cleans up, it deletes only replies whose author is the bot itself. It never
  deletes the post, members' replies or other bots' messages. Tests run hundreds
  of random sequences of posts and edits and check this every time.
- It ignores every channel except the one it's set up for.

### Someone breaks into the server, or bad code sneaks into an update

- The bot runs as a limited user account inside a locked-down "sandbox": it can't
  change its own code or the server's system files, and can't give itself more
  power.
- It relies on just one outside package, Slack's own official toolkit, and installs
  the exact versions we've recorded.
- Only code that has been committed to the repository, and so can be reviewed, gets
  deployed. Nothing else on the deployer's computer is sent.

## What we're trusting, and the known gaps

No system is perfect. These are the things we rely on, and the small risks we've
decided to accept:

- **Whoever runs the server.** They can see the tokens and can change what runs, so
  pick someone the community trusts.
- **Slack's toolkit and the packages it uses.** We check them for known problems
  before each release, but we don't review their code ourselves.
- **Other channels.** Slack's read permission covers any public channel the bot has
  been added to. The bot ignores all but one, but if its tokens leaked, they could
  read those other channels. So add the bot to the BST channel only.
- **Where it can connect.** The sandbox limits what the bot can do on the server, not
  which internet addresses it can reach. Our code only connects to Slack, and every
  change to it is reviewable.
- **Rare timing hiccups.** If a member edits a post at the exact moment the bot is
  replying, a reply might be left behind or missed until a later edit. It's
  harmless and can't push the bot past 3 replies.
- **The 3-reply limit starts over when the bot restarts.**
- **Slack's toolkit writes a few log lines of its own.** At its normal settings they
  don't include tokens or message text, and we never change those settings.

## What you can do

- Add the bot to the BST channel and nowhere else.
- Agree on who runs the server, since that person holds the tokens.
- Know how to switch it off. From quickest to most complete:
  1. Remove the bot from the channel. It stops acting there straight away.
  2. A workspace admin can uninstall the app from Slack's app management page. This
     also cancels its main token, so even someone with a copy can no longer read or
     post as the bot.
  3. Whoever runs the server can stop the bot there (`systemctl stop bst`).

## If something goes wrong

Tell the person running the bot or the moderators in Slack.

- **The bot is doing something odd?** Remove it from the channel first, then let
  them know.
- **Think a token has leaked?** Tell them straight away. The token needs to be
  cancelled and replaced; [docs/setup.md](docs/setup.md#rotating-tokens) has the
  steps.

## The detailed version

[docs/threat-model.md](docs/threat-model.md) is the technical write-up of everything
above, for the people maintaining the bot. It names the test that backs up each
claim.

## Words you might see

- **Slack app / bot:** a program that connects to Slack and acts like a special
  member account. Ours is called "BST App", and its bot shows up in Slack as
  "BST Reply Bot".
- **Token:** a long secret string that works like a password for the bot. Anyone who
  has it can act as the bot, so it's kept secret. This bot has two.
- **Thread:** the replies under a post, which open on the side in Slack.
- **Server / host:** the computer the bot runs on. It's run by one of us, not by
  Slack.
- **Sandbox:** a set of locks the server puts around a program, limiting which files
  it can touch and what it's allowed to do, so that even a misbehaving program can't
  do much harm.
- **Deploy:** copying a new version of the bot onto the server and starting it.
- **Repository / repo:** this folder of code and documents, tracked with git.
- **Commit:** a saved snapshot of the repository, with a record of who changed what.
  Anyone can look back at exactly what each version contained.
