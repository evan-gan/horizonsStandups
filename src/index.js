require("dotenv").config();
const cron = require("node-cron");
const { loadConfig } = require("./config");
const {
  createSlackClient,
  postStandupWithImage,
  getSubteamMembers,
} = require("./slack");
const { generateStatsPng } = require("./eventStatsImage");
const { ReminderTracker } = require("./reminders");

async function runStandupForEvent(client, tracker, config, subEvent) {
  const stamp = new Date().toISOString();
  try {
    const { buffer, filename } = await generateStatsPng(subEvent.name);
    const members = await getSubteamMembers(client, subEvent.subteamId);

    const { parentTs } = await postStandupWithImage(client, {
      channelId: subEvent.channelId,
      subteamId: subEvent.subteamId,
      messageTemplate: config.standupMessageTemplate,
      threadMessageTemplate: config.threadMessage,
      pngBuffer: buffer,
      filename,
    });

    tracker.track({
      parentTs,
      channelId: subEvent.channelId,
      subteamId: subEvent.subteamId,
      eventName: subEvent.name,
      members,
    });

    console.log(
      `[${stamp}] Standup posted for "${subEvent.name}" in ${subEvent.channelId} (ts: ${parentTs}, ${members.length} members tracked)`
    );
  } catch (error) {
    console.error(
      `[${stamp}] Standup failed for "${subEvent.name}": ${error.message}`
    );
  }
}

function main() {
  const config = loadConfig();
  const client = createSlackClient(config.slackBotToken);
  const tracker = new ReminderTracker(client, {
    graceMinutes: config.reminder.graceMinutes,
    intervalMinutes: config.reminder.intervalMinutes,
    timezone: config.timezone,
    reminderMessageTemplate: config.reminderMessageTemplate,
    // In debug mode, sweep every 5s so the 15s grace window is actually exercised.
    sweepIntervalMs: config.debug ? 5_000 : undefined,
  });
  tracker.start();

  for (const subEvent of config.subEvents) {
    cron.schedule(
      subEvent.cronSchedule,
      () => runStandupForEvent(client, tracker, config, subEvent),
      { timezone: "UTC" }
    );
    console.log(
      `Scheduled "${subEvent.name}" → channel ${subEvent.channelId} daily at ${subEvent.isoTime}`
    );
  }

  console.log(
    `Reminder sweeper running — grace ${config.reminder.graceMinutes}m, interval ${config.reminder.intervalMinutes}m, deadline = end of next day in ${config.timezone}.`
  );

  if (config.debug) {
    console.log("[DEBUG] Posting every sub-event once at startup.");
    for (const subEvent of config.subEvents) {
      runStandupForEvent(client, tracker, config, subEvent);
    }
  }
}

main();
