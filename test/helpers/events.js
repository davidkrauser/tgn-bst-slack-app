// The message_changed event Slack sends. Its own ts is new; the nested message
// keeps the original ts and leaves out the reactions and files, so that only the
// refetched copy can show them.
export function changeEvent(before, after, extra = {}, ts = "100.999999") {
  const strip = ({ reactions, files, channel, ...message }) => message;
  return {
    type: "message",
    subtype: "message_changed",
    hidden: true,
    channel: "C1",
    channel_type: "channel",
    ts,
    event_ts: ts,
    message: { type: "message", ...strip(after), ...extra },
    previous_message: strip(before),
  };
}
