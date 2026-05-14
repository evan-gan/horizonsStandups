const { WebClient } = require("@slack/web-api");

function createSlackClient(token) {
  return new WebClient(token);
}

function formatToday() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Replace {date} and {ping} tokens and unescape literal "\n" sequences that
 * arrive from .env files.
 */
function renderTemplate(template, { ping = "", date = formatToday() } = {}) {
  return template
    .replace(/\{date\}/g, date)
    .replace(/\{ping\}/g, ping)
    .replace(/\\n/g, "\n");
}

function subteamMention(subteamId) {
  return `<!subteam^${subteamId}>`;
}

/**
 * Post a standup parent message (with the event stats PNG attached), then post
 * the thread starter reply.
 *
 * Returns { parentTs, replyTs } so the caller can register the thread for
 * follow-up reminders.
 */
async function postStandupWithImage(client, {
  channelId,
  subteamId,
  messageTemplate,
  threadMessageTemplate,
  pngBuffer,
  filename,
}) {
  const ping = subteamMention(subteamId);
  const parentText = renderTemplate(messageTemplate, { ping });
  const threadText = renderTemplate(threadMessageTemplate, { ping });

  // files.uploadV2 posts the file as its own message in the channel; we use
  // it as the parent (initial_comment renders as the message body) so the
  // stats image and the @-mention appear together rather than as a follow-up.
  const upload = await client.files.uploadV2({
    channel_id: channelId,
    file: pngBuffer,
    filename,
    initial_comment: parentText,
  });

  // The upload response doesn't reliably include the share message's ts, so
  // look up the message in channel history by file id.
  const fileId = extractFirstFileId(upload);
  if (!fileId) {
    throw new Error("files.uploadV2 did not return a file id.");
  }
  const parentTs = await findMessageTsByFileId(client, channelId, fileId);
  if (!parentTs) {
    throw new Error(
      `Uploaded file ${fileId} did not appear in channel history within the retry window.`
    );
  }

  const threadReply = await client.chat.postMessage({
    channel: channelId,
    thread_ts: parentTs,
    text: threadText,
  });

  return { parentTs, replyTs: threadReply.ts };
}

/**
 * files.uploadV2 returns a nested structure that varies by SDK version. The
 * file id is reliable; we use it to look up the share message's timestamp via
 * conversations.history.
 */
function extractFirstFileId(uploadResponse) {
  const files = uploadResponse?.files;
  if (!Array.isArray(files)) return null;
  for (const fileEntry of files) {
    if (fileEntry?.id) return fileEntry.id;
    if (Array.isArray(fileEntry?.files)) {
      for (const inner of fileEntry.files) {
        if (inner?.id) return inner.id;
      }
    }
  }
  return null;
}

/**
 * Poll conversations.history for a message that contains the just-uploaded
 * file. Slack creates the share message asynchronously, so we retry briefly.
 */
async function findMessageTsByFileId(client, channelId, fileId, { attempts = 8, delayMs = 400 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const history = await client.conversations.history({ channel: channelId, limit: 10 });
    for (const message of history.messages || []) {
      if (Array.isArray(message.files) && message.files.some((f) => f.id === fileId)) {
        return message.ts;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function getSubteamMembers(client, subteamId) {
  const res = await client.usergroups.users.list({ usergroup: subteamId });
  return res.users || [];
}

/**
 * Return the set of user IDs that have replied in the given thread (excluding
 * the original parent message author and bot replies).
 */
async function getThreadResponders(client, channelId, threadTs) {
  const responders = new Set();
  let cursor;
  do {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      cursor,
    });
    for (const message of res.messages || []) {
      // Skip the parent message itself.
      if (message.ts === threadTs) continue;
      // Skip bot replies (no real user) and our own reminder pings.
      if (message.subtype === "bot_message") continue;
      if (message.bot_id) continue;
      if (message.user) responders.add(message.user);
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return responders;
}

async function postThreadReply(client, channelId, threadTs, text) {
  return client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}

module.exports = {
  createSlackClient,
  postStandupWithImage,
  getSubteamMembers,
  getThreadResponders,
  postThreadReply,
  renderTemplate,
  subteamMention,
};
