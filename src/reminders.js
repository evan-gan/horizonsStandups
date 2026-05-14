const { getThreadResponders, postThreadReply } = require("./slack");

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min normally; debug mode shortens this.

/**
 * In-memory tracker for active standup threads awaiting replies. State is
 * intentionally not persisted — a process restart wipes pending follow-ups.
 */
class ReminderTracker {
  constructor(client, {
    graceMinutes,
    intervalMinutes,
    timezone,
    sweepIntervalMs,
    reminderMessageTemplate,
    now = () => new Date(),
  }) {
    this.client = client;
    this.graceMs = graceMinutes * 60 * 1000;
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.timezone = timezone;
    this.sweepIntervalMs = sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.reminderMessageTemplate =
      reminderMessageTemplate || "{mentions} — still need your standup update. 🙏";
    this.now = now;
    this.entries = new Map(); // key: parentTs, value: entry
    this.sweepTimer = null;
  }

  /**
   * Register a freshly-posted standup so the sweeper begins watching it.
   * `members` is the array of user IDs from the subteam at post time.
   */
  track({ parentTs, channelId, subteamId, eventName, members }) {
    this.entries.set(parentTs, {
      parentTs,
      channelId,
      subteamId,
      eventName,
      members: new Set(members),
      postedAt: this.now(),
      lastReminderAt: null,
      deadline: endOfNextDay(this.now(), this.timezone),
    });
  }

  start() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((error) => {
        console.error(`[reminders] sweep failed: ${error.message}`);
      });
    }, this.sweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  stop() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async sweep() {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      try {
        await this.processEntry(entry, now);
      } catch (error) {
        console.error(
          `[reminders] entry ${entry.parentTs} (${entry.eventName}) failed: ${error.message}`
        );
      }
    }
  }

  async processEntry(entry, now) {
    if (now >= entry.deadline) {
      this.entries.delete(entry.parentTs);
      return;
    }
    if (now - entry.postedAt < this.graceMs) return;
    if (entry.lastReminderAt && now - entry.lastReminderAt < this.intervalMs) return;

    const responders = await getThreadResponders(this.client, entry.channelId, entry.parentTs);
    const missing = [...entry.members].filter((userId) => !responders.has(userId));
    if (missing.length === 0) {
      this.entries.delete(entry.parentTs);
      return;
    }

    const mentions = missing.map((userId) => `<@${userId}>`).join(" ");
    const text = this.reminderMessageTemplate
      .replace(/\{mentions\}/g, mentions)
      .replace(/\\n/g, "\n");
    await postThreadReply(this.client, entry.channelId, entry.parentTs, text);
    entry.lastReminderAt = now;
  }
}

/**
 * Compute the end (23:59:59.999) of the day *after* `from` in the given IANA
 * timezone. Used as the hard cap for when reminders stop firing.
 */
function endOfNextDay(from, timezone) {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [year, month, day] = dateFmt.format(from).split("-").map(Number);
  // We want the UTC instant that corresponds to (year, month, day+1) 23:59:59.999
  // in `timezone`. Start with a UTC "guess" of those wallclock numbers, then
  // shift by however far the timezone is from UTC at that instant.
  return utcInstantFromWallclock(year, month, day + 1, 23, 59, 59, 999, timezone);
}

function utcInstantFromWallclock(year, month, day, hour, minute, second, ms, timezone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  const parts = formatPartsInTz(guess, timezone);
  // `parts` is what `guess` looks like rendered in `timezone`. The difference
  // between that and our intended wallclock tells us the timezone offset.
  const renderedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = renderedUtc - intendedUtc;
  return new Date(guess.getTime() - offsetMs);
}

function formatPartsInTz(date, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

module.exports = { ReminderTracker, endOfNextDay };
