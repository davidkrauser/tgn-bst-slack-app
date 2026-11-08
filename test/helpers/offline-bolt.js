// A `node --import` preload for child-process tests of src/app.js. It makes the
// Slack Web API fail locally and refuses every network connection, so the child
// can run with token-shaped env values and never reach a real host.
import net from "node:net";
import { createRequire } from "node:module";

net.Socket.prototype.connect = function () {
  throw new Error("offline: network connections are disabled");
};

const { webApi } = createRequire(import.meta.url)("@slack/bolt");

const bot = process.env.SLACK_BOT_TOKEN;
const app = process.env.SLACK_APP_TOKEN;
const error = Object.assign(new Error(`An API error occurred: invalid_auth ${bot}`), {
  code: "slack_webapi_platform_error",
  data: { ok: false, error: "invalid_auth" },
  original: {
    config: { headers: { Authorization: `Bearer ${bot}` } },
    request: { _header: `Authorization: Bearer ${app}` },
  },
});

const mode = process.env.OFFLINE_MODE;
const never = () => new Promise(() => {});

// "started": init and start succeed without a connection, and the child
// reports the event names registered and that start was called.
if (mode === "started") {
  const { App } = createRequire(import.meta.url)("@slack/bolt");
  const events = [];
  const event = App.prototype.event;
  App.prototype.event = function (name, ...rest) {
    events.push(name);
    return event.call(this, name, ...rest);
  };
  App.prototype.init = async () => {};
  App.prototype.start = async () => {
    console.log("started");
  };
  process.on("exit", () => console.log(`events:${JSON.stringify(events)}`));
}

webApi.WebClient.prototype.apiCall = function () {
  if (mode === "rejection") {
    setTimeout(() => Promise.reject(error), 50);
    return never();
  }
  if (mode === "exception") {
    setTimeout(() => {
      throw error;
    }, 50);
    return never();
  }
  if (mode === "plain") {
    setTimeout(() => {
      throw new TypeError(`boom ${bot}`);
    }, 50);
    return never();
  }
  if (mode === "coded") {
    setTimeout(() => {
      throw Object.assign(new Error(`boom ${bot}`), { code: "ECONNRESET" });
    }, 50);
    return never();
  }
  if (mode === "odd-name") {
    setTimeout(() => {
      throw Object.assign(new Error(`boom ${bot}`), { name: `Bad name ${bot}` });
    }, 50);
    return never();
  }
  if (mode === "named") {
    setTimeout(() => {
      throw Object.assign(new Error(`boom ${bot}`), { name: process.env.OFFLINE_ERROR_NAME });
    }, 50);
    return never();
  }
  if (mode === "object-name") {
    setTimeout(() => {
      throw Object.assign(new Error(`boom ${bot}`), { name: { toString: () => "Foo" } });
    }, 50);
    return never();
  }
  if (mode === "non-error") {
    setTimeout(() => Promise.reject({ name: "TypeError", message: bot }), 50);
    return never();
  }
  if (mode === "plain-rejection") {
    setTimeout(() => Promise.reject(new TypeError(`boom ${bot}`)), 50);
    return never();
  }
  return Promise.reject(error);
};
