import {
  cleanUpNudge,
  fetchMessage,
  hasBotLamp,
  logFailure,
  nudgeProblems,
  nudgeText,
  postNudge,
} from "./nudge.js";

const MAX_NUDGES_PER_POST = 3;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Returns "new", "edit", or null for an event the bot must ignore. Pure; never
// throws. Admins and owners are not exempt, so nothing here reads the author.
export function classifyEvent(event, channelId) {
  if (!isObject(event)) return null;
  if (event.channel !== channelId) return null;

  let message;
  let kind;
  if (event.subtype === undefined || event.subtype === "file_share") {
    message = event;
    kind = "new";
  } else if (event.subtype === "message_changed") {
    message = event.message;
    kind = "edit";
    if (!isObject(message) || typeof message.text !== "string" || message.text === "") {
      return null;
    }
  } else {
    return null;
  }

  if (typeof message.ts !== "string" || message.ts === "") return null;
  if (message.thread_ts != null && message.thread_ts !== message.ts) return null;
  if (message.bot_id || message.subtype === "bot_message") return null;
  return kind;
}

export function createMessageHandler({ channelId, rulesUrl }) {
  let botUserId = null;
  const nudgeAttempts = new Map();

  // Every attempt counts, confirmed or rolled back, and is counted before the
  // await so concurrent events for one post still add up. Past the cap it makes
  // no Slack call and says so once per post.
  async function nudge(client, ts, problems) {
    const attempts = nudgeAttempts.get(ts) ?? 0;
    if (attempts >= MAX_NUDGES_PER_POST) {
      if (attempts === MAX_NUDGES_PER_POST) {
        nudgeAttempts.set(ts, attempts + 1);
        console.error("nudge cap reached");
      }
      return;
    }
    nudgeAttempts.set(ts, attempts + 1);
    await postNudge(client, channelId, ts, nudgeText(problems, rulesUrl));
  }

  // The bot's own user id, cached once Slack gives one. Null on failure, so the
  // caller fails closed and the next event retries.
  async function knownBotUserId(client) {
    if (botUserId) return botUserId;
    try {
      const response = await client.auth.test();
      if (typeof response?.user_id === "string" && response.user_id !== "") {
        botUserId = response.user_id;
        return botUserId;
      }
      console.error("bot id failed: no_user_id");
    } catch (err) {
      logFailure("bot id", err);
    }
    return null;
  }

  // Decides from the refetched message alone: the event's copy has no reactions
  // or files. Does nothing when the bot id or the message can't be had.
  async function handleEdit(event, client) {
    const ts = event.message.ts;
    const self = await knownBotUserId(client);
    if (self === null) return;
    const current = await fetchMessage(client, channelId, ts);
    if (current === null) return;

    const lamped = hasBotLamp(current, self);
    const problems = nudgeProblems(current);
    if (problems.length > 0) {
      if (!lamped) await nudge(client, ts, problems);
    } else if (lamped) {
      await cleanUpNudge(client, channelId, ts, self);
    }
  }

  return async ({ event, client }) => {
    const kind = classifyEvent(event, channelId);
    if (kind === "edit") {
      await handleEdit(event, client);
    } else if (kind === "new") {
      const problems = nudgeProblems(event);
      if (problems.length === 0) return;
      await nudge(client, event.ts, problems);
    }
  };
}
