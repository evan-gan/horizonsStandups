const REQUIRED_ENV_VARS = [
  "SLACK_BOT_TOKEN",
  "EVENT_STATS_API_URL",
  "EVENT_STATS_API_KEY",
  "SUB_EVENTS",
];

function assertRequiredEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. See .env.example for reference.`
    );
  }
}

/**
 * Parse the SUB_EVENTS env var into structured sub-event configs.
 *
 * Format: name,subteamId,channelId,ISO8601_TIME | ... (pipe-separated)
 * ISO8601_TIME accepts HH:MM[:SS] followed by an offset (±HH:MM, ±HHMM, or Z).
 * The offset is fixed; the bot will fire at the corresponding UTC instant every
 * day, so daylight-saving shifts are NOT applied automatically.
 */
function parseSubEvents(rawValue) {
  const entries = rawValue
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("SUB_EVENTS must contain at least one entry.");
  }

  return entries.map((entry, index) => {
    const parts = entry.split(",").map((part) => part.trim());
    if (parts.length !== 4) {
      throw new Error(
        `SUB_EVENTS entry #${index + 1} is malformed — expected "name,subteamId,channelId,ISO8601_TIME". Got: "${entry}"`
      );
    }
    const [name, subteamId, channelId, isoTime] = parts;
    if (!name || !subteamId || !channelId || !isoTime) {
      throw new Error(
        `SUB_EVENTS entry #${index + 1} has empty fields. Got: "${entry}"`
      );
    }

    const { hourUtc, minuteUtc, displayTime, offsetMinutes } = parseIso8601Time(isoTime, index);
    const cronSchedule = `${minuteUtc} ${hourUtc} * * *`;
    return {
      name,
      subteamId,
      channelId,
      isoTime: displayTime,
      offsetMinutes,
      hourUtc,
      minuteUtc,
      cronSchedule,
    };
  });
}

/**
 * Parse an ISO 8601 time-with-offset string and return its UTC wallclock
 * components. We only care about hour + minute since the bot fires daily.
 */
function parseIso8601Time(value, entryIndex) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) {
    throw new Error(
      `SUB_EVENTS entry #${entryIndex + 1} has invalid ISO 8601 time "${value}". Use e.g. "09:00-04:00" or "13:30:00Z".`
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] !== undefined ? Number(match[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(
      `SUB_EVENTS entry #${entryIndex + 1} time "${value}" is out of range.`
    );
  }

  const offsetMinutes = parseOffset(match[4]);
  // Convert local-with-offset to UTC: UTC = local - offset.
  const totalLocalMinutes = hour * 60 + minute;
  const totalUtcMinutes = ((totalLocalMinutes - offsetMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const hourUtc = Math.floor(totalUtcMinutes / 60);
  const minuteUtc = totalUtcMinutes % 60;

  return { hourUtc, minuteUtc, displayTime: value, offsetMinutes };
}

function parseOffset(raw) {
  if (raw === "Z") return 0;
  const normalized = raw.includes(":") ? raw : `${raw.slice(0, 3)}:${raw.slice(3)}`;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(normalized);
  if (!m) throw new Error(`Invalid offset "${raw}".`);
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid offset "${raw}".`);
  return sign * (hours * 60 + minutes);
}

function loadConfig() {
  assertRequiredEnv();
  const timezone = process.env.TZ || "America/New_York";
  const subEvents = parseSubEvents(process.env.SUB_EVENTS);
  const debug = /^(1|true|yes|on)$/i.test(process.env.DEBUG || "");

  const standupMessageTemplate =
    process.env.STANDUP_MESSAGE_TEMPLATE ||
    ":sunrise: Standup for {date} — {ping}";
  const threadMessage =
    process.env.THREAD_MESSAGE ||
    ":thread: Reply here with your standup update!";
  const reminderMessageTemplate =
    process.env.REMINDER_MESSAGE_TEMPLATE ||
    "{mentions} — still need your standup update. 🙏";

  const graceMinutes = debug
    ? 15 / 60 // 15 seconds, expressed in minutes so the rest of the code is unchanged.
    : Number(process.env.REMINDER_GRACE_MINUTES ?? 120);
  const intervalMinutes = Number(process.env.REMINDER_INTERVAL_MINUTES ?? 120);

  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    timezone,
    debug,
    subEvents,
    standupMessageTemplate,
    threadMessage,
    reminderMessageTemplate,
    reminder: { graceMinutes, intervalMinutes },
    statsApi: {
      url: process.env.EVENT_STATS_API_URL,
      key: process.env.EVENT_STATS_API_KEY,
    },
  };
}

module.exports = { loadConfig, parseSubEvents, REQUIRED_ENV_VARS };
