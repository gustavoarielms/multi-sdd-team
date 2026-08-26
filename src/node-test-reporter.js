const MAX_FAILURES = 20;
const MAX_NAME_LENGTH = 200;

function boundedName(value) {
  return [...String(value ?? "unnamed test")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, MAX_NAME_LENGTH);
}

function recordTestEvent(event, counted, failures) {
  if (event.type !== "test:pass" && event.type !== "test:fail") return;
  if (event.data?.details?.type === "suite") {
    counted.suites += 1;
    return;
  }
  counted.tests += 1;
  if (event.data?.skip !== undefined) counted.skipped += 1;
  else if (event.data?.todo !== undefined) counted.todo += 1;
  else if (event.type === "test:pass") counted.passed += 1;
  else {
    counted.failed += 1;
    if (failures.length < MAX_FAILURES) failures.push({ name: boundedName(event.data?.name) });
  }
}

function normalizedCounts(summary, counted) {
  const sourceCounts = summary?.counts ?? counted;
  return Object.fromEntries(Object.keys(counted).map((key) => [
    key,
    Number.isInteger(sourceCounts[key]) && sourceCounts[key] >= 0 ? sourceCounts[key] : counted[key],
  ]));
}

export default async function* nodeTestReporter(source) {
  const suite = process.env.SDD_TEST_SUITE;
  const counted = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const failures = [];
  let summary;

  for await (const event of source) {
    if (event.type === "test:summary" && event.data?.counts) summary = event.data;
    recordTestEvent(event, counted, failures);
  }

  const counts = normalizedCounts(summary, counted);
  const status = counts.failed === 0 && counts.cancelled === 0 ? "pass" : "fail";
  yield `${JSON.stringify({ protocol_version: "1.0.0", suite, status, counts, failures })}\n`;
}
