const REQUIRED = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_CHANNEL_ID"];

export function readConfig(env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  return {
    missing,
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    channelId: env.SLACK_CHANNEL_ID,
    rulesUrl: env.BST_RULES_URL || null,
  };
}

export function missingLine(missing) {
  return `Missing env var(s): ${missing.join(", ")}`;
}
