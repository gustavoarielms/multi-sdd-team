import { parentPort, workerData } from "node:worker_threads";

function scanJsonDepth(source) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > workerData.maxDepth) throw new Error("coverage map nesting limit");
    } else if (character === "}" || character === "]") depth -= 1;
    if (depth < 0) throw new Error("coverage map shape");
  }
  if (inString || depth !== 0) throw new Error("coverage map shape");
}

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCounters(counters, itemMap) {
  if (!objectRecord(counters) || !objectRecord(itemMap)) throw new Error("coverage map shape");
  const identifiers = Object.keys(itemMap);
  if (identifiers.some((identifier) => !Object.hasOwn(counters, identifier))) throw new Error("coverage map shape");
  for (const identifier of identifiers) {
    const hits = counters[identifier];
    if (Array.isArray(hits)) {
      if (hits.length > workerData.maxBranchItems
        || hits.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("coverage map counter");
      }
    } else if (!Number.isSafeInteger(hits) || hits < 0) throw new Error("coverage map counter");
  }
  return identifiers.length;
}

function parseAndValidate(source) {
  scanJsonDepth(source);
  const value = JSON.parse(source);
  if (!objectRecord(value) || Object.keys(value).length > workerData.maxFiles) throw new Error("invalid coverage map");
  let items = 0;
  for (const coverage of Object.values(value)) {
    if (!objectRecord(coverage) || typeof coverage.path !== "string") throw new Error("coverage map shape");
    items += validateCounters(coverage.s, coverage.statementMap);
    items += validateCounters(coverage.f, coverage.fnMap);
    items += validateCounters(coverage.b, coverage.branchMap);
    if (!Number.isSafeInteger(items) || items > workerData.maxItems) throw new Error("coverage map item limit");
  }
  return value;
}

try {
  parentPort.postMessage({ ok: true, value: parseAndValidate(workerData.source) });
} catch {
  parentPort.postMessage({ ok: false });
}
