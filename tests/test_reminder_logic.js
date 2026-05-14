const assert = require("assert");
const Module = require("module");

// Stub ./slack so reminders.js doesn't require the real Slack SDK at import.
const slackPath = require.resolve("../src/slack");
const originalLoad = Module._load;
const threadReplyCalls = [];
let responders = new Set();
Module._load = function patchedLoad(request, parent, ...rest) {
  if (parent && request === "./slack" && parent.filename.endsWith("reminders.js")) {
    return {
      getThreadResponders: async () => responders,
      postThreadReply: async (_client, channelId, threadTs, text) => {
        threadReplyCalls.push({ channelId, threadTs, text });
        return { ok: true };
      },
    };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { ReminderTracker, endOfNextDay } = require("../src/reminders");

function makeTracker(currentTime) {
  return new ReminderTracker({}, {
    graceMinutes: 120,
    intervalMinutes: 120,
    timezone: "America/New_York",
    now: () => currentTime.value,
  });
}

async function testSkipsBeforeGracePeriod() {
  threadReplyCalls.length = 0;
  responders = new Set();
  const current = { value: new Date("2026-05-13T09:00:00Z") };
  const tracker = makeTracker(current);
  tracker.track({
    parentTs: "1.0",
    channelId: "C1",
    subteamId: "S1",
    eventName: "Test",
    members: ["U1", "U2"],
  });
  // 60 minutes later — still inside the 120-minute grace window.
  current.value = new Date("2026-05-13T10:00:00Z");
  await tracker.sweep();
  assert.strictEqual(threadReplyCalls.length, 0, "no reminder before grace");
  console.log("PASS: skips reminders during grace period");
}

async function testPingsMissingMembersAfterGrace() {
  threadReplyCalls.length = 0;
  responders = new Set(["U1"]); // Only U1 has posted.
  const current = { value: new Date("2026-05-13T09:00:00Z") };
  const tracker = makeTracker(current);
  tracker.track({
    parentTs: "1.0",
    channelId: "C1",
    subteamId: "S1",
    eventName: "Test",
    members: ["U1", "U2", "U3"],
  });
  current.value = new Date("2026-05-13T11:30:00Z"); // 2.5h later
  await tracker.sweep();

  assert.strictEqual(threadReplyCalls.length, 1, "should send one reminder");
  const text = threadReplyCalls[0].text;
  assert.ok(text.includes("<@U2>"), "pings U2");
  assert.ok(text.includes("<@U3>"), "pings U3");
  assert.ok(!text.includes("<@U1>"), "does not ping U1 (responded)");
  console.log("PASS: pings only missing members after grace");
}

async function testRespectsIntervalBetweenReminders() {
  threadReplyCalls.length = 0;
  responders = new Set();
  const current = { value: new Date("2026-05-13T09:00:00Z") };
  const tracker = makeTracker(current);
  tracker.track({
    parentTs: "1.0",
    channelId: "C1",
    subteamId: "S1",
    eventName: "Test",
    members: ["U1"],
  });
  current.value = new Date("2026-05-13T11:30:00Z");
  await tracker.sweep(); // first reminder
  current.value = new Date("2026-05-13T12:30:00Z"); // only 1h later
  await tracker.sweep(); // should be suppressed
  assert.strictEqual(threadReplyCalls.length, 1, "second reminder suppressed");

  current.value = new Date("2026-05-13T13:45:00Z"); // > 2h after first
  await tracker.sweep();
  assert.strictEqual(threadReplyCalls.length, 2, "third reminder fires");
  console.log("PASS: respects reminder interval");
}

async function testStopsAfterEveryoneResponds() {
  threadReplyCalls.length = 0;
  responders = new Set(["U1"]);
  const current = { value: new Date("2026-05-13T09:00:00Z") };
  const tracker = makeTracker(current);
  tracker.track({
    parentTs: "1.0",
    channelId: "C1",
    subteamId: "S1",
    eventName: "Test",
    members: ["U1"],
  });
  current.value = new Date("2026-05-13T11:30:00Z");
  await tracker.sweep();
  assert.strictEqual(threadReplyCalls.length, 0, "no reminder when complete");
  assert.strictEqual(tracker.entries.size, 0, "entry removed when complete");
  console.log("PASS: stops tracking once everyone responds");
}

async function testStopsAtEndOfNextDay() {
  threadReplyCalls.length = 0;
  responders = new Set();
  const current = { value: new Date("2026-05-13T13:00:00Z") };
  const tracker = makeTracker(current);
  tracker.track({
    parentTs: "1.0",
    channelId: "C1",
    subteamId: "S1",
    eventName: "Test",
    members: ["U1"],
  });
  // Jump 3 days forward — well past the end-of-next-day deadline.
  current.value = new Date("2026-05-16T13:00:00Z");
  await tracker.sweep();
  assert.strictEqual(threadReplyCalls.length, 0, "no reminder past deadline");
  assert.strictEqual(tracker.entries.size, 0, "entry evicted past deadline");
  console.log("PASS: stops at end of next day");
}

function testEndOfNextDayInTimezone() {
  // 2026-05-13 18:00 UTC = 14:00 America/New_York. End of next day in NY is
  // 2026-05-14 23:59:59.999 NY = 2026-05-15 03:59:59.999 UTC.
  const result = endOfNextDay(new Date("2026-05-13T18:00:00Z"), "America/New_York");
  assert.strictEqual(result.toISOString(), "2026-05-15T03:59:59.999Z");
  console.log("PASS: endOfNextDay computes timezone-aware boundary");
}

(async () => {
  await testSkipsBeforeGracePeriod();
  await testPingsMissingMembersAfterGrace();
  await testRespectsIntervalBetweenReminders();
  await testStopsAfterEveryoneResponds();
  await testStopsAtEndOfNextDay();
  testEndOfNextDayInTimezone();
})();
