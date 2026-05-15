# CLAUDE.md

Notes for future agents working in this repo. The user-facing project doc is [project_context.md](project_context.md); this file is for things that aren't obvious from the code but matter when making changes.

## What this is

A Slack bot that posts a daily standup for each configured **sub-event** (e.g. a city meetup), attaches a PNG stats dashboard for that sub-event, pings the sub-event's Slack subteam, and follows up in-thread to nag anyone in the subteam who hasn't posted yet.

Each sub-event is a row in the `SUB_EVENTS` env var. The Horizons platform exposes per-sub-event stats over an authenticated REST endpoint, which this bot polls when posting.

## Architecture (one-screen view)

```
.env  ─►  src/config.js  ─┬─► src/index.js (cron registration + debug-startup)
                          │     │
                          │     ├─► src/eventStatsImage.js
                          │     │      ↳ fetches API, builds SVG, rasterizes
                          │     │        with @resvg/resvg-js, composites with sharp
                          │     │
                          │     ├─► src/slack.js
                          │     │      ↳ files.uploadV2, subteam lookup, thread
                          │     │        replies, history polling for parent ts
                          │     │
                          │     └─► src/reminders.js
                          │            ↳ in-memory ReminderTracker that sweeps
                          │              tracked threads, pings missing members
                          │
                          └─► tests/  (run_all.js auto-discovers test_*.js)
```

## Conventions that bit us already — don't re-learn them

### Image rendering uses resvg, NOT sharp, for the SVG-to-PNG step
We tried using sharp's `svgload` (which wraps librsvg) with `@font-face` data-URI fonts. **librsvg silently ignores embedded fonts.** Don't reintroduce the @font-face approach. If you need a different font, drop the file in `assets/` and update [BUNDLED_FONT_PATH](src/eventStatsImage.js) — resvg loads it via `font.fontFiles` directly, no fontconfig.

Sharp is still used for the **logo backdrop composite** (dim + blur + center the event logo behind the dashboard). The pipeline is:
1. SVG → PNG via resvg (text renders here)
2. If logo present: sharp `composite()` the resvg PNG over a dim/blurred logo on a solid bg

### Font family is read from the font file at startup
[readFontFamilyName](src/eventStatsImage.js) parses the SFNT or WOFF `name` table to extract the canonical family. Don't hardcode "Comic Neue" or "Inter" — the SVG `font-family=` attrs interpolate `BUNDLED_FONT_FAMILY`. Swapping the font file is the only change needed.

WOFF2 is **not** supported by the parser (Brotli compression, out of scope). Use TTF, OTF, or WOFF v1.

### The ISO 8601 time format does NOT follow DST
`SUB_EVENTS` entries like `09:00-04:00` get converted to a fixed UTC hour/minute and scheduled with `cron.schedule(..., { timezone: "UTC" })`. The offset is locked at parse time, so an event configured at `-04:00` (EDT) will fire one wallclock-hour later when its region switches to `-05:00` (EST). This was an explicit user decision — don't "fix" it by reintroducing IANA timezone names without checking first.

### File-upload parent ts comes from history polling
`files.uploadV2`'s response **does not reliably include the share message's ts**. We:
1. Pull the file id out of the upload response.
2. Poll `conversations.history` up to 8 × 400ms looking for a message containing that file id.
3. Use that message's ts as the parent for the thread + reminder tracking.

If you see "Uploaded file X did not appear in channel history within the retry window," the bot is missing `groups:history` on the channel or isn't a member of it.

### Reminder state is in-memory by design
A restart wipes pending follow-ups. Confirmed acceptable. Don't add JSON-file persistence without asking — the user explicitly chose ephemeral state.

### Reminders stop at end of *next* calendar day (in `TZ`)
Computed via [endOfNextDay](src/reminders.js) using `Intl.DateTimeFormat` to handle DST correctly. There are tests for this in `tests/test_reminder_logic.js` — keep them green if you touch the date math.

### DEBUG=true does two things
1. Posts every sub-event's standup immediately on startup (in addition to the daily cron).
2. Cuts the reminder grace window to 15 seconds and the sweeper interval to 5 seconds.

Use it for end-to-end testing. The interval (gap between repeated reminders) is **not** shortened — only the grace period before the first one. If a user wants the interval shortened too, that's a config change in [src/config.js](src/config.js).

## Deployment notes

- The repo deploys to Coolify via nixpacks. **Do not** create a `pnpm-workspace.yaml` unless it has a real `packages:` list — pnpm v9+ fails the install otherwise. We hit this exact bug ("packages field missing or empty") when an old `pnpm approve-builds` had written `allowBuilds: sharp: false` to the workspace file. Use `.npmrc` for pnpm settings instead.
- Set `NIXPACKS_NODE_VERSION=22` in Coolify env. Node 18 (the nixpacks default) is EOL and several deps (`sharp`, `AbortSignal.timeout`, etc.) want ≥20.
- Sharp and resvg both ship prebuilt Linux binaries via optional dependencies. No `apt-get install` of native deps needed.
- The bundled font in `assets/` ships with the repo — no font packages on the host required.

## Slack manifest gotchas

Scopes needed by current code paths:
- `chat:write` — post messages and thread replies
- `files:write` — `files.uploadV2`
- `groups:write` / `groups:history` / `groups:read` — private-channel ops + history polling for parent ts
- `usergroups:read` — `usergroups.users.list` for subteam membership
- `channels:join` — leftover from V1; safe to keep

The bot must be invited to each sub-event's private channel **before** its first scheduled run — otherwise `files.uploadV2` and `conversations.history` both fail.

## Testing

- `pnpm test` runs `tests/run_all.js`, which auto-discovers `test_*.js`.
- Tests don't touch the network — `test_reminder_logic.js` stubs `./slack` via a `Module._load` patch to inject fake responders/replies.
- There's no integration test for the Slack post path. If you're touching `src/slack.js`, the only validation today is running the bot in `DEBUG=true` against a real workspace.

## When in doubt

Read `project_context.md` first — it's the user-facing description of what each file does. This file is for "why" things are the way they are. If you find yourself reverting something this file says not to, double-check by searching the git history for the original conversation.
