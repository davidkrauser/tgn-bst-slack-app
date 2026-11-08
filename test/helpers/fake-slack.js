// A recording fake of the Slack Web API methods the bot calls. It keeps every
// call in order, returns the response shapes Slack gives, and can make any
// single call of a method fail, resolve with a chosen response or wait to be
// released, so a test can run another event while a call is in flight. It also keeps
// the channel's messages, so posts, reactions and deletes show up in history and
// replies the way they do on Slack.

export function createFakeSlack({
  botUserId = "UBOT",
  botId = "BBOT",
  pageSize = 100,
} = {}) {
  const store = [];
  const calls = [];
  const counts = new Map();
  const failures = new Map();
  const responses = new Map();
  const holds = new Map();
  let postCount = 0;

  function method(name, defaultResponse) {
    return async (args) => {
      calls.push({ method: name, args: { ...args } });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const key = `${name}#${n}`;
      const held = holds.get(key);
      if (held && !held.after) {
        held.reach();
        await held.gate;
      }
      let outcome;
      if (failures.has(key)) {
        const failure = failures.get(key);
        outcome = {
          error: failure.kind
            ? clientError(failure.kind, name)
            : platformError(failure.code),
        };
      } else if (responses.has(key)) {
        outcome = { value: responses.get(key) };
      } else {
        try {
          outcome = { value: defaultResponse(args) };
        } catch (error) {
          outcome = { error };
        }
      }
      if (held?.after) {
        held.reach();
        await held.gate;
      }
      if (outcome.error) {
        throw outcome.error;
      }
      return outcome.value;
    };
  }

  // A new post never takes the ts of a message already in the store, seeded or
  // posted, so it cannot overwrite one.
  function nextTs() {
    let ts;
    do {
      postCount += 1;
      ts = `1700000000.${String(postCount).padStart(6, "0")}`;
    } while (find(ts));
    return ts;
  }

  function find(ts) {
    return store.find((message) => message.ts === ts);
  }

  function threadOf(ts) {
    return store.filter(
      (message) => message.thread_ts === ts && message.ts !== ts,
    );
  }

  const client = {
    auth: {
      test: method("auth.test", () => ({
        ok: true,
        user_id: botUserId,
        bot_id: botId,
        team_id: "T1",
      })),
    },
    chat: {
      postMessage: method("chat.postMessage", (args) => {
        const ts = nextTs();
        const message = {
          type: "message",
          user: botUserId,
          bot_id: botId,
          text: args.markdown_text,
          ts,
        };
        if (args.thread_ts !== undefined) {
          message.thread_ts = args.thread_ts;
        }
        store.push({ ...structuredClone(message), channel: args.channel });
        return { ok: true, channel: args.channel, ts, message };
      }),
      delete: method("chat.delete", (args) => {
        const index = store.findIndex((message) => message.ts === args.ts);
        if (index === -1) {
          throw platformError("message_not_found");
        }
        store.splice(index, 1);
        return { ok: true, channel: args.channel, ts: args.ts };
      }),
    },
    reactions: {
      add: method("reactions.add", (args) => {
        const message = find(args.timestamp);
        if (!message) {
          throw platformError("message_not_found");
        }
        let reaction = message.reactions?.find((r) => r.name === args.name);
        if (reaction?.users.includes(botUserId)) {
          throw platformError("already_reacted");
        }
        message.reactions ??= [];
        if (!reaction) {
          reaction = { name: args.name, users: [], count: 0 };
          message.reactions.push(reaction);
        }
        reaction.users.push(botUserId);
        reaction.count = reaction.users.length;
        return { ok: true };
      }),
      remove: method("reactions.remove", (args) => {
        const message = find(args.timestamp);
        if (!message) {
          throw platformError("message_not_found");
        }
        const reactions = message.reactions;
        const reaction = reactions?.find((r) => r.name === args.name);
        if (!reaction?.users.includes(botUserId)) {
          throw platformError("no_reaction");
        }
        reaction.users = reaction.users.filter((user) => user !== botUserId);
        reaction.count = reaction.users.length;
        if (reaction.users.length === 0) {
          reactions.splice(reactions.indexOf(reaction), 1);
        }
        return { ok: true };
      }),
    },
    conversations: {
      history: method("conversations.history", (args) => {
        const matching = store
          .filter(
            (message) =>
              message.channel === args.channel &&
              (message.thread_ts === undefined ||
                message.thread_ts === message.ts),
          )
          .filter((message) => {
            if (args.latest === undefined) {
              return true;
            }
            return args.inclusive
              ? Number(message.ts) <= Number(args.latest)
              : Number(message.ts) < Number(args.latest);
          })
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        return { ok: true, ...page(matching, args, 100) };
      }),
      replies: method("conversations.replies", (args) => {
        const parent = store.find(
          (message) => message.channel === args.channel && message.ts === args.ts,
        );
        if (!parent) {
          throw platformError("thread_not_found");
        }
        const thread = [parent, ...threadOf(args.ts)];
        return { ok: true, ...page(thread, args, pageSize) };
      }),
    },
  };

  return {
    client,
    calls,
    fail(name, n, code = "fatal_error") {
      failures.set(`${name}#${n}`, { code });
    },
    // Makes the nth call of a method throw an error the client raises itself,
    // not one Slack answered with: "rate_limited", "request", "http" or
    // "exhausted" (a rate limit that outlasted the client's retries).
    failWith(name, n, kind) {
      if (!CLIENT_ERROR_KINDS.includes(kind)) {
        throw new Error(`unknown client error kind: ${kind}`);
      }
      failures.set(`${name}#${n}`, { kind });
    },
    respond(name, n, response) {
      responses.set(`${name}#${n}`, response);
    },
    // Makes the nth call of a method wait for release(). With after false the
    // call waits before doing anything, so the store is untouched until
    // release. With after true the effect (or the failure) happens at once and
    // only the answer waits. `reached` resolves once the call is recorded and,
    // with after true, once its effect is in the store.
    hold(name, n, { after = false } = {}) {
      let reach;
      let release;
      const reached = new Promise((resolve) => {
        reach = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      holds.set(`${name}#${n}`, { after, reach, gate });
      return { reached, release };
    },
    seed(message) {
      const copy = structuredClone(message);
      const index = store.findIndex((m) => m.ts === copy.ts);
      if (index === -1) {
        store.push(copy);
      } else {
        store[index] = copy;
      }
    },
    update(ts, fields) {
      Object.assign(find(ts), structuredClone(fields));
    },
    message(ts) {
      const message = find(ts);
      return message && structuredClone(message);
    },
    thread(ts) {
      return structuredClone(threadOf(ts));
    },
  };
}

// One page of items, with the cursor Slack hands back: opaque to callers, and
// empty on the last page.
function page(items, args, defaultLimit) {
  const start = args.cursor ? decodeCursor(args.cursor) : 0;
  const end = start + (args.limit ?? defaultLimit);
  const more = end < items.length;
  return {
    messages: structuredClone(items.slice(start, end)),
    has_more: more,
    response_metadata: { next_cursor: more ? encodeCursor(end) : "" },
  };
}

function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`).toString("base64");
}

function decodeCursor(cursor) {
  const text = Buffer.from(String(cursor), "base64").toString();
  const match = /^offset:(\d+)$/.exec(text);
  if (!match || Buffer.from(text).toString("base64") !== cursor) {
    throw platformError("invalid_cursor");
  }
  return Number(match[1]);
}

const CLIENT_ERROR_KINDS = ["rate_limited", "request", "http", "exhausted"];

function clientError(kind, method) {
  let error;
  if (kind === "rate_limited") {
    error = new Error(
      "A rate-limit has been reached, you may retry this request in 1 seconds",
    );
    error.code = "slack_webapi_rate_limited_error";
    error.retryAfter = 1;
  } else if (kind === "request") {
    error = new Error("A request error occurred: socket hang up");
    error.code = "slack_webapi_request_error";
    error.original = new Error("socket hang up");
  } else if (kind === "http") {
    error = new Error("An HTTP protocol error occurred: statusCode = 500");
    error.code = "slack_webapi_http_error";
    error.statusCode = 500;
  } else {
    error = new Error(
      `A rate limit was exceeded (url: ${method}, retry-after: 1)`,
    );
  }
  return error;
}

function platformError(code) {
  const error = new Error(`An API error occurred: ${code}`);
  error.code = "slack_webapi_platform_error";
  error.data = { ok: false, error: code };
  return error;
}
