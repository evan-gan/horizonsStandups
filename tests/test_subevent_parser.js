const assert = require("assert");
const { parseSubEvents } = require("../src/config");

function testParsesNegativeOffset() {
  const parsed = parseSubEvents("Test Event,S08,C08,09:00-04:00");
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].name, "Test Event");
  assert.strictEqual(parsed[0].isoTime, "09:00-04:00");
  assert.strictEqual(parsed[0].offsetMinutes, -240);
  // 09:00 at -04:00 == 13:00 UTC.
  assert.strictEqual(parsed[0].cronSchedule, "0 13 * * *");
  console.log("PASS: parses ISO time with negative offset");
}

function testParsesPositiveOffset() {
  const parsed = parseSubEvents("Berlin,S09,C09,09:00+02:00");
  // 09:00 at +02:00 == 07:00 UTC.
  assert.strictEqual(parsed[0].cronSchedule, "0 7 * * *");
  assert.strictEqual(parsed[0].offsetMinutes, 120);
  console.log("PASS: parses ISO time with positive offset");
}

function testParsesZuluTime() {
  const parsed = parseSubEvents("UTC Event,S09,C09,13:30Z");
  assert.strictEqual(parsed[0].cronSchedule, "30 13 * * *");
  assert.strictEqual(parsed[0].offsetMinutes, 0);
  console.log("PASS: parses Z (UTC) suffix");
}

function testParsesWithSeconds() {
  const parsed = parseSubEvents("Event,S09,C09,09:00:00-05:00");
  // Seconds are ignored for cron (minute granularity), but the time must parse.
  assert.strictEqual(parsed[0].cronSchedule, "0 14 * * *");
  console.log("PASS: tolerates HH:MM:SS form");
}

function testParsesCompactOffset() {
  const parsed = parseSubEvents("Event,S09,C09,09:00-0400");
  assert.strictEqual(parsed[0].cronSchedule, "0 13 * * *");
  console.log("PASS: accepts ±HHMM offset without colon");
}

function testHandlesUtcWraparound() {
  // 23:00 at -04:00 == 03:00 UTC next day; cron just fires at 03:00 UTC daily.
  const parsed = parseSubEvents("Late,S09,C09,23:00-04:00");
  assert.strictEqual(parsed[0].cronSchedule, "0 3 * * *");
  // 02:00 at +05:00 == 21:00 UTC previous day; cron fires at 21:00 UTC daily.
  const parsedEarly = parseSubEvents("Early,S09,C09,02:00+05:00");
  assert.strictEqual(parsedEarly[0].cronSchedule, "0 21 * * *");
  console.log("PASS: wraps UTC hour across day boundaries");
}

function testParsesMultipleEntries() {
  const parsed = parseSubEvents(
    "Test Event,S08,C08,09:00-04:00|Boston,S09,C09,10:15-04:00"
  );
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[1].name, "Boston");
  assert.strictEqual(parsed[1].cronSchedule, "15 14 * * *");
  console.log("PASS: parses multiple entries");
}

function testRejectsMissingFields() {
  assert.throws(() => parseSubEvents("Test Event,S08,C08"), /malformed/i);
  console.log("PASS: rejects entries with too few fields");
}

function testRejectsTimeWithoutOffset() {
  assert.throws(
    () => parseSubEvents("Test Event,S08,C08,09:00"),
    /invalid ISO 8601/i
  );
  console.log("PASS: rejects time missing timezone offset");
}

function testRejectsOutOfRangeTime() {
  assert.throws(
    () => parseSubEvents("Test Event,S08,C08,25:00-04:00"),
    /out of range/i
  );
  console.log("PASS: rejects out-of-range hour");
}

function testRejectsEmptyInput() {
  assert.throws(() => parseSubEvents(""), /at least one/i);
  console.log("PASS: rejects empty SUB_EVENTS");
}

testParsesNegativeOffset();
testParsesPositiveOffset();
testParsesZuluTime();
testParsesWithSeconds();
testParsesCompactOffset();
testHandlesUtcWraparound();
testParsesMultipleEntries();
testRejectsMissingFields();
testRejectsTimeWithoutOffset();
testRejectsOutOfRangeTime();
testRejectsEmptyInput();
