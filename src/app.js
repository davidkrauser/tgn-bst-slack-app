import { App } from "@slack/bolt";
import { readConfig, missingLine } from "./config.js";
import { createMessageHandler } from "./handlers.js";
import { logFailure } from "./nudge.js";

const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

// Anything that escapes is logged as a code only, never as the error object:
// Slack errors carry the request, and its headers hold the bot token. An error
// with no code is logged by its class name when that is a plain identifier.
function die(err) {
  if (err instanceof Error && typeof err.name === "string" && ERROR_NAME.test(err.name)) {
    logFailure("process", { data: err.data, code: err.code ?? err.name });
  } else {
    logFailure("process", err);
  }
  process.exit(1);
}
process.on("uncaughtException", die);
process.on("unhandledRejection", die);

const config = readConfig(process.env);

if (config.missing.length > 0) {
  console.error(missingLine(config.missing));
  process.exit(1);
}

const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
  deferInitialization: true,
});

app.event(
  "message",
  createMessageHandler({ channelId: config.channelId, rulesUrl: config.rulesUrl }),
);

try {
  await app.init();
  await app.start();
} catch (err) {
  logFailure("start", err);
  process.exit(1);
}
console.log("connected");
