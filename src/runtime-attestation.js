const SAFE_PROFILE_IDS = Object.freeze({
  "read-only": ":read-only",
});

function numericVersion(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  return match ? match.slice(1).map(Number) : undefined;
}

export function assertSupportedNodeRuntime(version = process.version) {
  const parsed = numericVersion(version);
  const supported = parsed && (
    (parsed[0] === 22 && parsed[1] >= 14)
    || parsed[0] === 24
    || parsed[0] >= 26
  );
  if (!supported) throw new Error(`The broker requires a supported Node runtime; received ${version}.`);
}

export const BROKER_PERMISSION_PROFILE_IDS = SAFE_PROFILE_IDS;
