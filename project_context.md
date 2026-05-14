# Standups Bot

A Slack bot that posts a daily standup to one or more private channels, attaches a Horizons event-stats PNG, pings the configured subteam, and follows up with thread reminders for anyone in the subteam who hasn't posted yet. Each sub-event has its own channel, subteam, and cron schedule.

## Codebase Structure

```
horizonsStandups/
├── src/
│   ├── index.js             — entry: loads config, schedules a cron per sub-event, starts the reminder sweeper
│   ├── config.js            — env loading + SUB_EVENTS parser (returns [{ name, subteamId, channelId, cronSchedule }])
│   ├── slack.js             — Slack helpers: image upload, subteam member lookup, thread replies, template rendering
│   ├── eventStatsImage.js   — fetches /api/integrations/event-stats and renders the SVG/PNG dashboard
│   │                         exports generateStatsPng(eventName) for the bot; still runnable as a CLI
│   └── reminders.js         — in-memory ReminderTracker that pings missing subteam members every interval
├── tests/
│   ├── run_all.js                   — auto-discovers and runs every test_*.js file (pnpm test)
│   ├── test_subevent_parser.js      — SUB_EVENTS env parser cases (multi-entry, commas in cron, validation)
│   └── test_reminder_logic.js       — grace window, interval, completion, end-of-next-day deadline, TZ math
├── output/                  — generated SVG/PNG dashboards (gitignored)
├── manifest.yaml            — Slack app manifest with bot scopes
├── .env.example             — template for required environment variables
├── .gitignore
└── package.json
```

## Configuration (.env)

- `SLACK_BOT_TOKEN` — Bot token with the scopes listed below.
- `TZ` — IANA timezone (default `America/New_York`). Affects cron firing and the reminder cutoff.
- `EVENT_STATS_API_URL` — Base URL for the Horizons stats endpoint.
- `EVENT_STATS_API_KEY` — `x-api-key` header value.
- `SUB_EVENTS` — Pipe-separated entries: `name,subteamId,channelId,cron|...`. Commas inside the cron expression are preserved (last field absorbs all trailing commas).
- `STANDUP_MESSAGE_TEMPLATE` — Parent message; `{ping}` → `<!subteam^ID>`, `{date}` → today's long-form date.
- `THREAD_MESSAGE` — Thread starter reply.
- `REMINDER_GRACE_MINUTES` — Default `120`. How long to wait after posting before the first reminder.
- `REMINDER_INTERVAL_MINUTES` — Default `120`. Minimum gap between reminders.

## Reminder Behavior

1. When a standup posts, the tracker snapshots the subteam's member list and stores `{ parentTs, channelId, members, postedAt, deadline }` in memory.
2. A sweeper runs every 5 minutes. For each tracked entry past its grace window, it fetches `conversations.replies`, computes `members - responders`, and posts a single thread reply tagging every missing user.
3. Entries are removed when everyone responds or when the deadline (end of the calendar day **after** the post date in `TZ`) passes.
4. State lives in memory — a restart wipes pending follow-ups. By design.

## Stats Image

`generateStatsPng(eventName)` calls `GET /api/integrations/event-stats?name=…`, renders an SVG dashboard (tiles, two timelines, donut, qualification funnel), rasterizes to PNG via `sharp` at 2× density, and returns `{ buffer, filename, stats }`. The CLI path (`node src/eventStatsImage.js "Event Name"`) also writes SVG + PNG to `/output`.

## Slack Scopes (manifest.yaml)

- `chat:write` — post messages and thread replies
- `channels:join`, `groups:write`, `groups:history`, `groups:read` — operate in private channels, read thread replies
- `files:write` — upload the stats PNG with the standup message
- `usergroups:read` — list subteam members for reminder targeting

The bot must be invited to each sub-event's private channel before its first scheduled run.
