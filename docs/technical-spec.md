# Technical Specification — Issue #12: deterministic Node.js architecture adapter

## Architecture proposal

Add a package-owned `node_architecture` engineering-gate adapter and a separate
worker. The adapter follows the established Node lint/complexity pattern:
`listTrackedFiles()` produces the target-contained production inventory, and
`runBoundedCommand()` starts `process.execPath` with a fixed worker path,
`shell: false`, bounded input/output/time, and an empty/sanitized environment.
The adapter validates the worker's entire JSON result before translating it to
the existing canonical gate/evidence schema.

The worker dynamically imports a packaged `dependency-cruiser@18.2.0` runtime
graph only after integrity verification. It uses a repository-owned JSON policy at
`governance/adapters/v1/node-dependency-cruiser.json` (the final package asset
must be included in distribution), a package-owned runtime content manifest,
and an explicit package-owned entry URL. The trust binding contains the SHA-256
of the content manifest and policy. Before any dynamic import, the worker
realpaths the worker, policy, content manifest, runtime root, entry, and every
manifest member under the package root, then verifies every member's relative
path, size, and SHA-256 against the manifest. Only the verified contained entry
URL is dynamically imported. The imported API must identify as
`dependency-cruiser@18.2.0`.

The analyzer never resolves by package name, target, cwd, `PATH`, executable,
or consumer install topology. Hoisted/overridden consumer dependencies cannot
be selected because the entire runtime graph is packaged and imported by its
verified file URL. The worker never invokes the dependency-cruiser executable
or reads analyzer settings from the target.

The package-owned paths are exact: runtime root
`vendor/node-architecture-runtime/`, runtime manifest
`governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json`,
generator `scripts/generate-node-architecture-runtime.js`, and verifier
`scripts/verify-node-architecture-runtime.js`. The content manifest has
exactly `schema_version`, `entry`, and `files`.
`schema_version` is `1.0.0`; `entry` is one safe relative runtime path; and
`files` is a lexicographically sorted, duplicate-free array of objects having
exactly `path`, `size`, and `sha256`. `path` is a safe relative path below the
runtime root, `size` is a safe non-negative integer, and `sha256` is lowercase
64-hex. The trusted manifest digest is verified before parsing it; the manifest
then verifies every listed file, including the entry. Missing, extra runtime
files, non-regular files, escapes, wrong size, or wrong digest are errors.
The runtime graph and manifest are committed. Generation may consume only the
repository lockfile and a local `npm ci --offline --ignore-scripts` install:
no network, lifecycle hook, target input, environment-selected package, or
unlocked resolution is allowed. Relative paths are normalized and sorted before
copying or manifesting. The verifier regenerates into a fresh temporary
directory and byte-compares every runtime path and byte, the manifest, the
license inventory/texts, and root `NOTICE.md`. It also requires
`npm pack --ignore-scripts` to include exactly the declared runtime/manifest/
license/NOTICE assets and forbids lifecycle hooks from generating or changing
them.

The generator writes
`vendor/node-architecture-runtime/licenses/inventory.json`, a sorted array of
objects with exactly `package`, `version`, `license`, and `text_path`, plus the
required license texts at the contained relative `text_path` values below that
`licenses/` directory. These files are manifest members and pack assets. A
missing text, unsupported/missing license value, duplicated package/version,
or inventory/manifest/NOTICE mismatch is a hard verification error.

The resulting topology is:

```text
run-gates
  -> node_architecture adapter
       -> listTrackedFiles(target, bin/src globs)
       -> bounded Node worker (fixed package path, no shell)
            -> fixed dependency-cruiser API + trusted JSON policy
            -> strict normalized report
       -> strict report/path/count/order validation
       -> existing run result + evidence schema
```

`node_architecture` is the sixth executor, after `coverage` and before
`governance`. The public CLI, `passed|failed|blocked`, exit `0|1|2`, schema
version, quality profile version, and adapter version all remain `1.0.0`.

## Components and ownership

| Component | Responsibility |
|---|---|
| `src/node-architecture-adapter.js` | Gather the fixed tracked inventory, start the worker through the existing bounded runner, strictly validate its report, classify failures/errors, and emit canonical result/evidence. |
| `src/node-architecture-worker.js` | Validate target/package runtime containment and quiescence, verify the full runtime content manifest before dynamic import, read the target manifest, call the fixed analyzer API, normalize/canonically order violations, and write one strict JSON report. |
| `governance/adapters/v1/node-dependency-cruiser.json` | Package-owned static policy implementing the five approved rules; it is versioned, shipped, digest-bound, and literal-validated. |
| `vendor/node-architecture-runtime/` | Committed deterministic dependency-cruiser runtime graph and `licenses/inventory.json` plus required license texts; its byte content is the only dynamically imported analyzer runtime. |
| `governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json` | Trusted inventory of runtime bytes, including license assets. |
| `scripts/generate-node-architecture-runtime.js` / `scripts/verify-node-architecture-runtime.js` | Deterministically generate from local locked bytes and independently regenerate/byte-compare/package-verify the committed bundle. |
| `NOTICE.md` | Future root notice for bundled third-party package/version/license inventory; it is a legal/package-surface document, not a CodeGraph file. |
| `src/engineering-gates.js` | Register only `node_architecture` in sixth position and dispatch it with the existing isolated executor behavior. |
| `src/governance-trust.js` | Bind the exact dependency-cruiser version, policy asset/digest, executor/rule mapping, and updated profile/registry content digests. |
| governance schemas/registries/config | Change exact cardinality from nine to ten and require the architecture executor/rule set/order; validate its check and evidence ownership without changing evidence schema shape. |
| runtime content manifest and package surface | Ship the complete analyzer runtime graph, its entry, and manifest below the package root so source, local, global, and packed consumers run the same verified bytes. |

## Analyzer policy and check mapping

The JSON policy has only top-level `forbidden` and `options` properties.
`forbidden` is an array of exactly five objects, in check order, each with only
`name`, `severity`, `from`, and `to`; `name` is the corresponding check ID and
`severity` is exactly `error`. Rules 1, 2, 4, and 5 have exactly
`from: { "path": "^(bin|src)/" }`; rule 3 has exactly
`from: { "path": "^src/" }`. Their `to` objects are respectively exactly
`{ "circular": true }`, `{ "path": "^test/" }`,
`{ "path": "^bin/" }`, `{ "couldNotResolve": true }`, and
`{ "dependencyTypes": ["npm-dev"] }`. `options` has only `doNotFollow`,
whose only key is `path` with exact value `(^|/)node_modules(/|$)`.
Any additional/missing key, wrong type, duplicate rule, wrong order, or changed
literal invalidates the policy.

The worker makes exactly this programmatic call after the runtime verification:

```js
cruise(absoluteProductionPaths, {
  ruleSet: verifiedPolicy,
  validate: true,
  outputType: "json",
  doNotFollow: { path: "(^|/)node_modules(/|$)" },
})
```

`absoluteProductionPaths` is the realpath-validated production inventory in
lexicographic relative-path order. No other cruise argument or option is
permitted, including `config`, output destination, cache,
include/exclude, TypeScript/Babel/Webpack configuration, plugin, or resolver
override. External dependency edges may be observed for package classification,
but their internals are never followed.

| Ordered check ID | Rule ID | Analyzer outcome normalized as failure |
|---|---|---|
| `no_production_cycles` | `ARCH-NO-CYCLES-001` | A directed cycle among production modules. |
| `production_must_not_import_tests` | `ARCH-PROD-NO-TEST-001` | An edge from `bin/` or `src/` to `test/`. |
| `src_must_not_import_bin` | `ARCH-SRC-NO-BIN-001` | An edge from `src/` to `bin/`. |
| `production_imports_resolve` | `ARCH-IMPORT-RESOLUTION-001` | An unresolved import from a production module. |
| `production_must_not_import_dev_dependencies` | `ARCH-PROD-NO-DEV-DEPS-001` | A production import whose package is in `devDependencies` and absent from `dependencies`. |

The worker may use analyzer-native rule names internally, but it must translate
only these five approved identities into its protocol. Any unexpected,
unclassified, duplicate, or ambiguous analyzer violation is an error rather
than silently omitted evidence.

## Input, containment, and fail-closed contract

1. Resolve the supplied target with `realpath`; this is the target root.
2. The adapter separately uses `listTrackedFiles()` with
   `:(glob)bin/**/*.js`/`:(glob)src/**/*.js` for `production_files` and
   `:(glob)test/**/*.js` for `test_files`. Both lists are bounded protocol
   inputs; public report `files` remains production-only. Reject an inventory
   error or an empty production list.
3. For every inventory member, require a safe relative slash-separated path,
   require its realpath to remain inside the target root, and reject missing,
   absolute, traversal, backslash, duplicate, or symlink-escaping members.
4. Enforce these pre-analysis limits: manifest at most 1 MiB; at most 10,000
   production plus test files; at most 2 MiB per file; and at most 64 MiB in
   aggregate. Start the worker with `--max-old-space-size=256`; reject a graph
   above 20,000 modules or 100,000 edges. Do not truncate any input or result.
5. Require `target/package.json` to exist, be a regular contained file, be no
   more than 1 MiB, and parse to a non-null, non-array JSON object. If present,
   `dependencies` and `devDependencies` must each be non-null, non-array JSON
   objects. Every dependency entry must be an own property (`Object.hasOwn`),
   use a valid npm package-name key of at most 214 UTF-8 bytes, and have a
   string version value of 1..1024 UTF-8 bytes without controls. Membership is
   determined only with `Object.hasOwn(object, packageName)`, never prototype
   lookup. `__proto__` is invalid as a package name; own `constructor` and
   `toString` are data keys, not inherited membership.
6. Resolve the worker, policy, content manifest, runtime root, and every
   manifest-declared runtime member from the current package. Each realpath
   must remain under the package root. Verify manifest digest, then every
   relative path/size/SHA-256, before dynamic import of its contained entry.
7. Before analysis, inspect only the target root for exactly these names:
   `.dependency-cruiser.js`, `.dependency-cruiser.cjs`,
   `.dependency-cruiser.json`, `.dependency-cruiser.yaml`,
   `.dependency-cruiser.yml`, `.dependency-cruiser.mjs`, `dependency-cruiser.js`,
   `dependency-cruiser.cjs`, `dependency-cruiser.json`,
   `dependency-cruiser.yaml`, `dependency-cruiser.yml`, `dependency-cruiser.mjs`,
   `.dependency-cruiser-known-violations.json`, and
   `dependency-cruiser-known-violations.json`. Reject if any listed entry
   exists, including a symlink, directory, or other non-regular entry; do not
   read it. Also reject only root `package.json` keys `dependency-cruiser` and
   `dependencyCruiser`. No other filename glob, recursive scan, or near-match
   belongs to this denial rule.
8. Verify exact analyzer identity/version, trusted policy digest, and runtime
   content manifest before
   accepting an analysis result.

The filesystem threat model is quiescent storage, not an immutable filesystem.
For target root, manifest, every production/test input, worker, policy, content
manifest, runtime entry, and each runtime member, capture before-use identity
`{ realpath, dev, ino, size, mtime_ns }`. `dev`, `ino`, and `mtime_ns` are
unsigned decimal strings; `size` is a safe non-negative integer. Re-read the
same identity after analysis and before publishing output. Any absence, changed
identity, changed realpath, or changed digest is an error. A hostile writer who
swaps content and restores the same observable identity and metadata between
checks (swap-back) is an accepted residual; the adapter does not claim to
prevent it.

The runner uses `process.execPath`, fixed argument array
`["--max-old-space-size=256", WORKER_PATH]`, `cwd: target`, no shell, no
`PATH` executable selection, no `npx`, no network, and bounded
stdin/stdout/stderr/timeout inherited from the registry. A spawn, timeout,
signal, nonzero worker exit, output limit, limit breach, parsing failure, or
protocol/identity failure maps to executor `error`. The adapter must not expose
raw worker output in an error or evidence.

## Internal worker protocol

The adapter-to-worker input protocol is exactly version `1.0.0`; unknown fields
are rejected. Its top-level object has exactly `protocol_version`,
`target_root`, `production_files`, `test_files`, and `manifest_identity`.
`target_root` is the absolute target realpath. `production_files` and
`test_files` are independently lexicographically sorted, duplicate-free arrays
of file objects; no public output field exposes `test_files`. Each file object
has exactly `path` and `identity`, where `path` is a safe relative JavaScript
path and `identity` has exactly `realpath`, `dev`, `ino`, `size`, and
`mtime_ns`. `manifest_identity` uses the same exact identity object.

`realpath` is an absolute contained path; `dev`, `ino`, and `mtime_ns` are
unsigned decimal strings; `size` is a safe non-negative integer. The worker
re-reads every input identity before use and after analysis, and the adapter
also revalidates the identities it owns before serializing the canonical gate
result. Any mismatch is an error.

The private worker-to-adapter report is exactly version `1.0.0`; unknown fields
are rejected. The top-level report has exactly these keys:

```json
{
  "protocol_version": "1.0.0",
  "analyzer": { "id": "dependency-cruiser", "version": "18.2.0" },
  "policy_digest": "sha256:<64-lowercase-hex>",
  "files": ["bin/example.js"],
  "graph": { "module_count": 1, "edge_count": 0 },
  "rules": [ ... ]
}
```

`files` is the lexicographically sorted, duplicate-free, exact supplied
production inventory. Every member is a non-empty, slash-separated safe
relative JavaScript path: no absolute path, `..`, backslash, or control
character. `analyzer` has exactly `id` and `version`; both are the constants
shown above. `policy_digest` is the trusted SHA-256 value, prefixed by
`sha256:`. `graph` has exactly `module_count` and `edge_count`, both safe
non-negative integers, respectively no greater than 20,000 and 100,000.

`rules` has exactly five entries in the profile order. Each entry has exactly
`check_id`, `rule_id`, `total`, and `details`. `check_id`/`rule_id` must equal
the five mappings in the analyzer-policy table, `total` is a safe integer at
least zero, and `details.length === min(total, 20)`. Details are unique and
strictly ascending by the canonical key defined below. The worker supplies no
evidence IDs and no arbitrary analyzer output.

The allowed detail object is determined solely by its rule; its keys are exact:

| Rule | Exact detail object | Canonical key and required path domain |
|---|---|---|
| `ARCH-NO-CYCLES-001` | `{ "kind": "cycle", "members": [path, ...] }` | Members are a directed cycle with at least one safe path, each in `files`; one member represents a self-loop. Do not repeat the closing member. Rotate to the lexicographically smallest member without reversing, then use `members.join("\\u0000")`. |
| `ARCH-PROD-NO-TEST-001` | `{ "kind": "edge", "source": path, "target": path }` | `source` is in `files`; `target` is a tracked, target-contained `test/` path. Key: `source + "\\u0000" + target`. |
| `ARCH-SRC-NO-BIN-001` | `{ "kind": "edge", "source": path, "target": path }` | `source` is an `src/` member of `files`; `target` is a tracked, target-contained `bin/` path. Key: `source + "\\u0000" + target`. |
| `ARCH-IMPORT-RESOLUTION-001` | `{ "kind": "unresolved", "source": path, "specifier": text }` | `source` is in `files`; `specifier` is non-empty safe text of at most 1024 characters. Key: `source + "\\u0000" + specifier`. |
| `ARCH-PROD-NO-DEV-DEPS-001` | `{ "kind": "package", "source": path, "package": text }` | `source` is in `files`; `package` is a valid non-empty package name. Key: `source + "\\u0000" + package`. |

All local analyzer-resolved paths, including every production source, cycle
member, and edge target, must be realpath-validated as contained by the target
before conversion to their relative protocol path. Production sources and cycle
members must belong to `production_files`; test targets must belong to
`test_files`; bin targets must belong to `production_files`. The adapter
independently repeats protocol/path/count/order and identity validation against
both supplied inventories and target root; any disagreement is an error. If
the analyzer cannot provide an internally consistent full total, it is
untrustworthy and the adapter errors.

## Canonical gate result and evidence

On a trusted report, emit five checks in the exact mapping order. Every check
has its matching rule ID, `gate_effect: block`, at least its summary evidence,
and `pass` when total is zero or `fail` otherwise. The executor status is
`fail` when any check fails, otherwise `pass`. A trusted failure therefore
keeps all check results available for remediation.

Evidence reuses the current schema:

- one `static_analysis` summary per check, containing the rule-specific full
  total and canonical cap statement;
- zero to 20 `source_location` (or static-analysis cycle) details per check,
  sorted and linked by the existing `check_id`;
- short, normalized summaries with no raw graph, command output, stack,
  environment, baseline, config, or arbitrary package text; and
- explicit existing-schema redaction metadata when a safe normalized summary
  cannot be emitted unchanged.

The executor-level evidence ID list is the ordered deduplicated union of its
five check evidence lists. An error produces existing-schema bounded error
evidence and no `checks` array. The exact public error taxonomy is:

| Failure class | Reason code |
|---|---|
| Input inventory, containment, or identity | `NODE_ARCHITECTURE_INPUT_INVALID` |
| Target analyzer control or target manifest | `NODE_ARCHITECTURE_MANIFEST_INVALID` |
| Trusted policy bytes or contract | `NODE_ARCHITECTURE_POLICY_INVALID` |
| Runtime manifest, membership, digest, identity, or mutation | `NODE_ARCHITECTURE_RUNTIME_INVALID` |
| Analyzer import, API, execution, or output | `NODE_ARCHITECTURE_ANALYZER_INVALID` |
| Graph or bounded-resource limit | `NODE_ARCHITECTURE_RESOURCE_LIMIT` |
| Analyzer result normalization | `NODE_ARCHITECTURE_EVIDENCE_INVALID` |
| Private protocol envelope or report | `NODE_ARCHITECTURE_PROTOCOL_INVALID` |
| Worker timeout | `NODE_ARCHITECTURE_TIMEOUT` |
| Worker output limit | `NODE_ARCHITECTURE_OUTPUT_LIMIT` |
| Worker signal termination | `NODE_ARCHITECTURE_SIGNALLED` |
| Worker spawn failure | `NODE_ARCHITECTURE_SPAWN_FAILED` |
| Other command unavailability | `NODE_ARCHITECTURE_UNAVAILABLE` |

Every error has no `checks` array and does not echo raw worker output, analyzer
text, specifiers, paths outside the normalized inventory, signal text, or
environment values.

## Integration changes

The implementation must update all exact-cardinality consumers together:

- engineering executor constants/default map and isolated-worker dispatch;
- gate configuration, gate registry, run schema (`minItems`/`maxItems`), and
  schema-validation expectations from 9 to 10;
- canonical trust bindings/digests and architecture check validation in the
  governance validator;
- package dependencies, `npm run check` syntax inventory, publish files, and
  installer/distribution fixtures; and
- test classification/inventory guards plus exact ordering assertions.

No CLI option, target override, public plugin hook, policy baseline, or
evidence-schema field is added.

## Verification plan

### Unit tests

- Worker input/report exact-key, analyzer/version/digest, content-manifest,
  production/test inventory, identity, graph-count, path, rule/check, and
  ordering rejection.
- Runtime content manifest is checked fully before dynamic import; a wrong
  manifest digest, missing/extra/modified runtime member, or hoisted consumer
  override cannot select analyzer code.
- Policy literals are tested against real dependency-cruiser 18.2.0 fixtures:
  each approved rule fires only with its exact `from`/`to` literal and
  `validate: true`; trust validation rejects any changed policy byte, order,
  field, rule name, or `dependencyTypes` value.
- Directed-cycle rotation, deduplication, non-reversal, stable sort, and
  20-detail cap with full totals.
- Dev-only dependency classification, including a package declared in both
  dependency sections; manifest non-object/array values, inherited keys,
  oversized names/values, and own `__proto__`, `constructor`, and `toString`
  cases prove `Object.hasOwn` membership is used safely.
- Canonical evidence/check ownership, summary/detail limits, safe text and
  redaction behavior, executor status, and error-without-checks contract.
- Registry/schema/trust exact ten-executor mapping and sixth-position guards.

### Integration tests

- A compliant fixture plus one independent fixture for each approved rule.
- Equivalent permutations of violations proving byte-stable result ordering.
- Missing/empty production inventory; missing, malformed, non-contained, or
  symlink-escaping manifest/path; distinct bounded test inventory; and local
  resolution outside target.
- Every one of the fourteen target-root denylist names (including `.mjs`) and
  each rejected package key, with symlink/directory/non-regular variants; an
  allowed near-match confirms no open glob. Malformed,
  extra-field, wrong-version, wrong-digest, wrong-rule, and count-mismatch
  worker reports.
- Manifest over 1 MiB, 10,001 inputs, over-2-MiB file, over-64-MiB aggregate,
  over-20,000-module graph, over-100,000-edge graph, and worker heap argument
  each produce a fail-closed error without truncation.
- Pre/post identity changes for target input and packaged runtime asset return
  error; tests document rather than claim protection from the swap-back
  residual.
- Generator uses only a local `npm ci --offline --ignore-scripts` lockfile
  install; verifier regeneration into a temporary directory byte-compares the
  committed runtime, manifest, license inventory/texts, and `NOTICE.md`.
  `npm pack --ignore-scripts` includes all and only the declared package assets;
  lifecycle-hook generation is rejected.
- Spawn failure, timeout, signal, output overflow, and no raw output leakage.
- Runner sequencing: a trusted architecture `fail` continues to later gates;
  an architecture `error` yields `blocked` and later `not_run`.
- Source checkout, project-local install, global install, and packed-consumer
  execution on Node 22.14.0 and 24.19.0, including complete packaged runtime
  asset presence and a packed-consumer fixture that proves a hoisted/overridden
  consumer dependency cannot be selected.
- Package `engines.node` exact value `^22.14.0 || ^24.0.0 || >=26.0.0`, with
  assertions for Node 22.14.0 and 24.19.0 and an explicit rejection assertion
  for Node 25. Node 26+ is declared compatible but is not substituted for the
  required 22.14/24.19 execution matrix.

## Risks and controls

| Risk | Control |
|---|---|
| Analyzer behavior changes by installation or target settings | Complete packaged runtime graph plus trusted content manifest is verified before dynamic import; fixed JSON policy/options and rejected target config/baselines prevent consumer selection. |
| Symlink/path traversal or concurrent mutation changes analysis scope | Realpath containment plus pre/post `{ dev, ino, size, mtime_ns }` identity verification; reject an observed change. Swap-back is an explicit residual under the quiescent-filesystem threat model. |
| Nondeterministic traversal creates unstable evidence | Fixed rule order, canonical cycle rotation without reversal, deduplication, sorting, full totals, and per-rule cap. |
| Tool output leaks sensitive or unbounded content | Bounded command runner, strict private protocol, normalized evidence only, and redaction metadata. |
| Pathological target exhausts resources | Hard manifest/input/graph/heap limits and no following of external dependency internals; every limit breach errors without partial result. |
| A green generic test run misses architecture semantics | Independent fixtures for each rule plus protocol, containment, sequencing, distribution, and Node-version tests. |
| Dependency-cruiser cannot represent a proposed rule unambiguously | Fail closed on unclassified analyzer output; do not add a baseline, exception, or weaker alternative without separate human approval. |

## Implementation success criteria

Implementation is complete only when the new package-owned adapter and worker
meet every functional acceptance criterion, all ten-executor schema/trust/
registry invariants pass, each five-rule semantic fixture passes, and source,
local, global, and packed-consumer checks (including consumer hoist/override
resistance) pass on
Node 22.14.0 and 24.19.0. `engines.node` must exactly equal
`^22.14.0 || ^24.0.0 || >=26.0.0` and reject Node 25.
No success claim may rely solely on a green CI run or on a pass that bypasses
the fixed analyzer protocol.
