import { parsePost, hasImage } from "./parse.js";

const LISTING_LIKE_RE = /\b(?:for sale|selling|looking for)\b/i;

const SENTENCES = {
  title: "It's missing a short line describing the item",
  location: "It's missing a location tag like [US]",
  price: "It's missing a price",
  photo: "It's missing a photo. Sale and trade posts need exactly *one* photo showing the item plus a handwritten note with your Slack name and the date of the post.",
  photos: "It has more than one photo. Extra photos must go in a thread reply only.",
  wtb_photo: "WTB/ISO posts can't include images. Photos are for sale listings only.",
  no_tag: "It has no leading tag (FS, FT, WTS, WTT, WTB, or ISO).",
};

export function nudgeProblems(message) {
  if (message === null || typeof message !== "object") return [];

  const parsed = parsePost(message);
  if (parsed) return parsed.missing;

  const listingLike =
    typeof message.text === "string" && LISTING_LIKE_RE.test(message.text);
  return hasImage(message.files) || listingLike ? ["no_tag"] : [];
}

const CLOSING = "This reply will be removed once you edit your post to fix every item above.";

// Takes only codes and the operator's URL, so no member text can reach the reply.
export function nudgeText(problems, rulesUrl) {
  const rules = rulesUrl ? `[rules](${rulesUrl})` : "rules";
  const bullets = problems.map((code) => `- ${SENTENCES[code]}`).join("\n");
  return `Hi! This looks like a listing, but it doesn't follow the posting ${rules}:\n\n${bullets}\n\n${CLOSING}`;
}

const LAMP = "rotating_light";

function errorCode(err) {
  return err?.data?.error ?? err?.code ?? "unknown_error";
}

export function logFailure(what, err) {
  console.error(`${what} failed: ${errorCode(err)}`);
}

// Lamp first, so a post the bot is about to reply to is already marked. Never
// rejects. Resolves true only when Slack confirms the reply landed in the thread;
// otherwise it deletes the reply it may have created, removes the lamp, and
// resolves false.
export async function postNudge(client, channel, ts, text) {
  try {
    await client.reactions.add({ channel, timestamp: ts, name: LAMP });
  } catch (err) {
    logFailure("lamp add", err);
  }

  let response = null;
  try {
    response = await client.chat.postMessage({
      channel,
      thread_ts: ts,
      markdown_text: text,
    });
    if (response?.thread_ts === ts || response?.message?.thread_ts === ts) {
      return true;
    }
    console.error("nudge post unconfirmed");
  } catch (err) {
    response = null;
    logFailure("nudge post", err);
  }

  if (typeof response?.ts === "string") {
    try {
      await client.chat.delete({ channel, ts: response.ts });
    } catch (err) {
      logFailure("nudge delete", err);
    }
  }

  try {
    await client.reactions.remove({ channel, timestamp: ts, name: LAMP });
  } catch (err) {
    logFailure("lamp remove", err);
  }
  return false;
}

// Resolves the current copy of a message, or null when Slack can't give exactly
// that message. Never rejects. The event's nested copy lacks reactions and
// files, so edits are decided from this one.
export async function fetchMessage(client, channel, ts) {
  let response;
  try {
    response = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
  } catch (err) {
    logFailure("edit refetch", err);
    return null;
  }
  const message = response?.messages?.[0];
  if (message === null || typeof message !== "object" || Array.isArray(message) || message.ts !== ts) {
    console.error("edit refetch mismatch");
    return null;
  }
  return message;
}

// True only when the bot's own user put the lamp on this message.
export function hasBotLamp(message, botUserId) {
  if (!botUserId || message === null || typeof message !== "object") return false;
  const { reactions } = message;
  if (!Array.isArray(reactions)) return false;
  return reactions.some(
    (r) =>
      r !== null &&
      typeof r === "object" &&
      r.name === LAMP &&
      Array.isArray(r.users) &&
      r.users.includes(botUserId),
  );
}

// Deletes every reply the bot made in the post's thread, then removes the lamp.
// Lists the whole thread before deleting anything. The lamp stays unless every
// page was listed and every bot reply is gone, so the next edit retries.
// Never rejects. Resolves true only when the lamp was removed.
export async function cleanUpNudge(client, channel, ts, botUserId) {
  const replies = [];
  let cursor;
  try {
    do {
      const request = { channel, ts };
      if (cursor) request.cursor = cursor;
      const response = await client.conversations.replies(request);
      const messages = Array.isArray(response?.messages) ? response.messages : [];
      for (const message of messages) {
        if (
          message !== null &&
          typeof message === "object" &&
          message.user === botUserId &&
          typeof message.ts === "string" &&
          message.ts !== ts
        ) {
          replies.push(message.ts);
        }
      }
      const next = response?.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next !== "" ? next : undefined;
    } while (cursor);
  } catch (err) {
    logFailure("reply list", err);
    return false;
  }

  let complete = true;
  for (const replyTs of replies) {
    try {
      await client.chat.delete({ channel, ts: replyTs });
    } catch (err) {
      if (errorCode(err) === "message_not_found") continue;
      logFailure("reply delete", err);
      complete = false;
    }
  }
  if (!complete) return false;

  try {
    await client.reactions.remove({ channel, timestamp: ts, name: LAMP });
  } catch (err) {
    logFailure("lamp remove", err);
    return false;
  }
  return true;
}
