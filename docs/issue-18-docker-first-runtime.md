# Issue #18 — Docker-first managed-prompt runtime

## Status

- Design decision: approved on 2026-09-04.
- Specification status: approved on 2026-09-04, including `--prompt-file`
  input and ephemeral, non-persisted container authentication state.
- Implementation status: not started by this document.
- Source baseline: `origin/main` at `f5fe4ca8bfdb2e9857cd7b6b4555f87cfda33ed8`
  (PR #27).
- Delivery boundary: this specification does not authorize a branch, commit,
  pull request, image publication, release, consumer update, or deployment.

This document is the functional specification, technical specification, and
ordered implementation plan for
[Issue #18](https://github.com/gustavoarielms/multi-sdd-team/issues/18).
It turns the fail-closed App Server scaffold delivered by PR #27 into a usable
positive path without weakening its current negative guarantees.

## Approved decisions

1. Docker Engine or Docker Desktop running Linux containers is the first
   supported portable process-containment authority. Native POSIX process-tree
   discovery is not a supported positive authority.
2. The first positive path covers project installations using
   `workspace-only`. `read-only` remains supported for non-writing turns.
   Built-in `workspace`, `danger-full-access`, legacy sandbox settings, and
   global `$CODEX_HOME/agents/*.toml` installations remain untrusted.
3. The host broker owns Docker lifecycle and App Server RPC. Agent-controlled
   code runs inside the container and never receives the Docker socket or
   another container-management capability.
4. Under `workspace-only`, the project root is mounted read-write at
   `/workspace`, then the exact project `.codex` directory is mounted over
   `/workspace/.codex` as an explicitly recursive read-only bind mount. Under
   `read-only`, the whole project mount is recursively read-only. The container
   root filesystem is always read-only.
5. Codex keeps its inner `workspace-only` permission profile and
   `approvalPolicy: never`. Docker supplies outer process and filesystem
   containment; it does not replace the inner command sandbox.
6. The runtime image is package-approved and selected only by immutable OCI
   digest. The launcher does not pull, build, or accept an arbitrary image as
   part of a turn.
7. Direct host-process launch remains fail-closed with
   `BROKER_PROCESS_CONTAINMENT_UNAVAILABLE`. Docker absence, ambiguity, drift,
   or cleanup failure also fails closed.
8. `check` and `governance` remain the only broker dynamic operations in the
   first slice. `run-gates` remains unavailable until every process it starts
   is proven to execute inside the same external boundary.

## Functional specification

### Objective

A person can start a Codex main turn in a project installation through the
package-owned broker. The turn may edit ordinary workspace files under the
`workspace-only` profile, including through a subagent, but neither the main
agent nor any descendant can edit, replace, delete, rename over, hardlink, or
symlink-redirect installed `.codex/agents/*.toml` prompts.

The positive result proves only the supported AI-mediated workflow. It does
not claim protection against a Docker administrator, host filesystem
administrator, malicious Docker daemon, compromised kernel, or physical host
access.

### User-facing launch contract

The intended public shape is:

```text
sdd-codegraph launch [target] \
  --permissions workspace-only|read-only \
  --prompt-file <absolute-path>
```

- `target` defaults to the current working directory and is canonicalized to
  one existing project root.
- `--permissions` defaults to `workspace-only`; only `workspace-only` and
  `read-only` are accepted.
- `--prompt-file` is required, must be an existing bounded regular file, and is
  read once by the host broker without following a final symlink. Its contents
  are sent over App Server RPC and are never mounted into the container.
- The command accepts no image tag, Docker flags, mount override, executable,
  shell fragment, approval-policy override, network override, or raw runtime
  configuration.
- A successful, protected, completed turn exits `0`. A trustworthy task-level
  rejection exits `1` only if a later contract defines such an outcome.
  Missing or untrustworthy protection, incomplete execution, timeout, or
  cleanup failure exits `2`.
- `init` and `update` remain separate human-controlled host commands and are
  never exposed through the broker or mounted into the container as an
  authority to replace prompts.

The CLI must not be enabled until the real-container acceptance cases pass.
Internal APIs and tests may land earlier while the public command continues to
return `BROKER_PROCESS_CONTAINMENT_UNAVAILABLE`.

### Supported matrix

| Dimension | Positive v1 support |
|---|---|
| Host | Linux with local Docker Engine; macOS/Windows with local Docker Desktop using Linux containers |
| Docker endpoint | Local Unix socket, Docker Desktop socket, or Windows named pipe owned by the host user |
| Docker endpoint excluded | TCP, SSH, remote contexts, rootless/alternate runtimes not explicitly qualified |
| Package layout | Source checkout, project-local install, packed consumer |
| Installation | Project `.codex/**` only |
| Node | 22.14+ in major 22; major 24; major 26+ per package engine contract |
| Required validation | Node 22.14.0 and 24.19.0 |
| Permission profile | `workspace-only` and `read-only` |
| App Server topology | One main thread/turn plus Codex-spawned subagents contained by the same container |

Global installation remains explicitly `unproven`. A platform is not called
supported until its real Docker acceptance suite has passed; unit simulations
or green Linux CI do not establish macOS or Windows support.

### Observable outcomes

The launcher returns a bounded result with the existing thread, turn, and
completion identifiers plus:

```text
trusted: true|false
reason_code: BROKER_...
runtime: docker
permission_profile: workspace-only|read-only
prompt_snapshot_sha256: sha256:<hex>
container_image_digest: sha256:<hex>
```

`trusted: true` is legal only after all preflight, in-container, App Server,
postflight, and cleanup checks complete. `completion.turn.status` must be
`completed`. The first positive reason is `BROKER_RUNTIME_PROTECTED`.

Errors expose only stable `BROKER_*` reason codes. Docker stderr, daemon
details, project content, prompt text, environment values, credentials, and
arbitrary exception messages are diagnostic-only and must not enter canonical
JSON or tool output.

### Fail-closed cases

The launcher must not start the container, or must revoke and remove it, when
any of these conditions is observed:

- Docker is absent, unreachable, remote, not running Linux containers, or its
  response cannot be parsed strictly;
- the approved image is absent, resolves to a different digest, has the wrong
  platform, or its manifest/wrapper identity is not package-approved;
- the project, `.codex`, managed inventory, prompt set, or prompt snapshot is
  missing, drifted, unsafe, aliased, too large, or changes during the run;
- `docker inspect` differs from the exact package-owned container contract;
- any mount is extra, writable when it must be read-only, non-private, or has
  an unexpected host source or container destination;
- privileged mode, host PID/IPC/network namespace, devices, added
  capabilities, writable rootfs, Docker socket, or privilege escalation is
  present;
- the container-visible managed-prompt digest differs from the host snapshot;
- App Server reports a different project, thread, turn, permission profile,
  approval policy, sandbox policy, or workspace root;
- App Server requests approval, issues an unknown server request, exceeds a
  bound, disconnects, or completes a foreign thread/turn;
- forced removal fails, the exact container still exists, or another container
  with the run's unguessable ownership label remains.

## Technical specification

### Trust boundary

```text
human host process
  -> package-owned broker
       -> local Docker CLI/daemon
            -> one digest-pinned Linux container
                 -> Codex App Server
                      -> main turn and all subagents/commands
```

The broker and Docker daemon are outside agent control. Under
`workspace-only`, the project is the only host bind mounted read-write and
`.codex` is a nested read-only mount. Under `read-only`, the project itself is
read-only. The runtime container has no path back to the Docker control plane.

Docker documents that a container has an isolated process tree, filesystem,
and network stack. Force-removing the exact container is therefore the
authoritative descendant cleanup operation for this contract. PID/PPID,
process group, and POSIX session scans may remain diagnostic but cannot produce
a positive result.

### Components and ownership

| Component | Responsibility |
|---|---|
| `src/docker-runtime.js` | Resolve the local Docker endpoint, execute bounded argv-only Docker commands, strictly parse output, validate image/container inspection, attach stdio, force-remove, and prove absence. |
| `src/docker-runtime-contract.js` | Hold the exact image, mount, namespace, capability, limit, label, and inspect allowlists as data with no shell construction. |
| `src/app-server-broker.js` | Preserve RPC/prompt checks, select the Docker runtime, attest the active Codex profile, manage turn state, and emit trust only after cleanup. |
| `src/runtime-attestation.js` | Allow only `workspace-only` and `read-only`, map them to exact App Server permission/profile identifiers, and reject legacy/elevated modes. |
| `bin/sdd-codegraph.js` | Parse the bounded public launch arguments without accepting Docker/runtime escape hatches. |
| `governance/runtime/v1/codex-app-server-image.json` | Bind supported host architecture to an immutable OCI digest, Codex version, entry wrapper digest, and contract version. |
| `container/codex-app-server-entrypoint.*` | In the pinned image, hash the container-visible managed prompts, emit one bounded startup attestation, then `exec` App Server without a shell. |
| `test/runtime-broker.cases.js` | Shared unit/protocol/attack cases, including all existing PR #27 regressions. |
| `test/docker-runtime.cases.js` | Docker argv, inspect, mount, image, lifecycle, cleanup, and real-container cases. |

The file names are the planned ownership boundaries. Implementation may merge
the two Docker modules only if the resulting module remains small and the
contract stays independently testable.

### Docker creation contract

The broker uses argv arrays with `shell: false`. It performs `docker create`,
validates the returned container ID, runs `docker inspect` on that exact ID,
and only then attaches/starts it. It never uses Compose, a target-owned
Dockerfile, target-owned environment file, target-owned entrypoint, or shell.

The effective container contract requires:

- an approved image reference containing `@sha256:` and resolving to the
  package manifest's platform digest;
- `ReadonlyRootfs: true`;
- a non-root image user fixed by the approved image;
- no `Privileged`, added capabilities, devices, host PID/IPC/network/user
  namespaces, or Docker socket;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- bounded PIDs, memory, CPU, stdout/stderr, startup time, turn time, operation
  time, interrupt time, and removal time;
- private bind propagation;
- only package-declared tmpfs locations for Codex ephemeral state and ordinary
  temporary files;
- a cryptographically random run identifier in package-owned Docker labels;
- one bind from the canonical project root to `/workspace`, read-write only for
  `workspace-only` and recursively read-only for `read-only`;
- one later/nested bind from canonical `<project>/.codex` to
  `/workspace/.codex` with `readonly` and `bind-recursive=readonly`.

Docker's `--mount` form is required because it is explicit, does not silently
create a missing source directory, and supports recursive read-only binds. If
the daemon/kernel cannot provide explicit recursive read-only behavior, the
launcher returns `BROKER_CONTAINER_READONLY_UNAVAILABLE`.

The container uses normal outbound connectivity for App Server itself. The
App Server turn still receives the package's `workspace-only` policy with
command network disabled. Network isolation is defense in depth for Issue #18,
not the physical prompt-write boundary; an expanded egress policy is a separate
security initiative.

### Image and authentication contract

The package manifest contains immutable image digests, never a mutable tag.
The broker only inspects a locally available approved digest; it does not pull
or build during `launch`. Producing and publishing that image is a separately
approved release operation.

The image contains the expected Codex App Server version and the small trusted
entry wrapper. The wrapper's only pre-App-Server output is a versioned,
length-bounded attestation containing the runtime version, mount-visible
managed-prompt digest, and no file contents.

Authentication is provisioned by the trusted host launcher into an ephemeral
Codex state location outside `/workspace`. The project cannot select the auth
path or supply credentials. The broker never logs, hashes into public evidence,
or returns `auth.json`, API keys, access tokens, or credential paths. OS keyring
forwarding is outside positive v1; a supported run needs a package-approved
file/token provisioning path. Any copied credential state is destroyed with
the container and is not persisted back from agent-controlled storage.

OpenAI documentation identifies `CODEX_HOME` as App Server state and documents
file-based `auth.json` as secret material. The implementation must therefore
keep Codex auth/state separate from the project mount and from canonical
evidence.

### Prompt integrity protocol

1. Resolve the project root and `.codex` components without accepting symlinks
   or aliases prohibited by the existing installer contract.
2. Run the existing exact managed inventory and typed length-prefixed prompt
   snapshot. Store only its SHA-256.
3. Create and inspect the container without starting agent code.
4. Start the entry wrapper. Require its container-visible digest to equal the
   host snapshot before sending `thread/start`.
5. Start one ephemeral main thread with exact `cwd`, permission profile,
   `approvalPolicy: never`, workspace root, and dynamic tool specification.
6. Require the exact active permission profile from `thread/start` or the
   bounded `thread/settings/updated` attestation before `turn/start`.
7. Recompute the host prompt snapshot before every broker operation and after
   turn completion. Any change permanently revokes the run.
8. Subagents inherit the main turn's live sandbox and approval choices. They
   remain inside the same container; custom agent TOML is configuration input,
   not a separate runtime authority.
9. Interrupt on timeout/error, force-remove the exact container, verify it is
   absent by ID and unique ownership label, then and only then emit the final
   trust result.

OpenAI App Server does not expose a digest of the prompt bytes it loaded. The
supported guarantee is therefore based on a package-verified container view,
physical read-only mount, exact profile attestation, and pre/during/post digest
checks under a quiescent host filesystem. The specification must not describe
that as direct App Server prompt-content attestation.

### App Server contract

The existing JSONL framing, size/concurrency/deadline bounds, request
correlation, replay protection, error sanitization, and thread/turn matching
remain mandatory.

For `workspace-only`, `thread/start` and `turn/start` must resolve to:

- the package-owned `workspace-only` permission profile;
- `approvalPolicy: never`;
- canonical `/workspace` as `cwd` and the only writable root;
- command network access disabled;
- the package-owned dynamic tool schema.

For `read-only`, there are no writable roots. Any settings update that weakens
these values revokes the run. Approval requests are rejected; the broker never
approves or asks a person to elevate an active run.

Official OpenAI documentation says `turn/start` can override `cwd`, approval,
and sandbox policy, and that subagents inherit the parent turn's current
sandbox and live overrides. Those runtime facts are necessary but not
sufficient: Docker mounts and cleanup remain the external enforcement proof.

### Cleanup and crash recovery

Cleanup is idempotent and keyed only by the exact validated container ID plus
an unguessable run label. Normal completion, startup failure, RPC failure,
timeout, signal, and broker exception all enter the same removal path.

The broker first attempts bounded App Server interruption, then force-removes
the container. A successful `docker rm --force` response is not enough: a
subsequent exact inspect must report absence and a label query must return no
container. Ambiguous CLI output, daemon disconnect, timeout, or remaining
container produces `BROKER_CONTAINER_CLEANUP_UNPROVEN`, `trusted: false`, and
exit `2`.

Startup recovery may remove only containers whose labels contain the exact
package identity, contract version, and launcher-generated ownership token
recorded by that broker invocation. It must not sweep by name prefix or delete
unrelated containers.

### Non-goals and residuals

- Protecting prompts from a human/administrator or Docker daemon operator.
- Defending against a container-runtime or kernel escape.
- Supporting remote Docker contexts, Podman, containerd, Kubernetes, or native
  per-OS containment backends in positive v1.
- Making the whole workspace read-only.
- Persisting refreshed authentication state from the container.
- Enabling arbitrary broker tools or `run-gates`.
- Claiming direct knowledge of the bytes internally loaded by App Server.
- Automatically pulling/publishing images, releasing npm, or updating
  consumers.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-18-01 | A real `workspace-only` main turn creates/edits an ordinary workspace file while attempts to modify its own and another managed prompt fail; all prompt bytes and identities remain unchanged. |
| AC-18-02 | A real Codex-spawned writing subagent inherits the parent protection, can edit an allowed workspace file, and cannot mutate any managed prompt. |
| AC-18-03 | Shell, patch, subprocess, temp-file rename, atomic replacement, directory rename, symlink traversal, hardlink alias, and installer/update shortcut attacks cannot change or replace `.codex/agents/*.toml` or `.codex/managed-prompts.json`. |
| AC-18-04 | A descendant that daemonizes, changes process group/session, or reparents cannot survive forced removal of the owning container; exact-ID and ownership-label checks prove no container remains. |
| AC-18-05 | The broker starts no agent code when Docker is absent/remote, the image or digest is wrong, recursive read-only mounting is unavailable, inspect differs, `.codex` is unsafe, or the initial prompt snapshot is drifted. |
| AC-18-06 | Prompt changes before startup, between startup and a broker call, during a call, or before completion revoke the run and cannot return `trusted: true`. |
| AC-18-07 | Wrong/absent active profile, sandbox, workspace, approval policy, thread, turn, call identity, settings update, or completion fails closed within the existing bounds. |
| AC-18-08 | Unknown calls, approval requests, replay, oversized/malformed JSONL, excessive concurrency, timeout, disconnect, and arbitrary operation errors stay bounded and expose no sensitive text. |
| AC-18-09 | The container is non-privileged, read-only-root, capability-free, resource-bounded, and has no host namespace, device, extra mount, Docker socket, project-selected credential, or mutable image tag. Exact negative inspect fixtures cover every forbidden field. |
| AC-18-10 | Source, project-local, and packed-consumer layouts pass unit/protocol tests on Node 22.14.0 and 24.19.0. A real Linux Docker E2E passes before merge. macOS/Windows are advertised only after equivalent real Docker Desktop acceptance. |
| AC-18-11 | Direct/non-Docker launch and global prompt installations remain `unproven`; they cannot return success because Docker-path tests are green. |
| AC-18-12 | `check` and `governance` are the only dynamic operations. `run-gates` remains unavailable and its absence is regression-tested. |
| AC-18-13 | A human-controlled host `update` can replace managed prompts between runs, after which a new clean snapshot launches successfully; no active or agent-requested turn can invoke that update. |
| AC-18-14 | Canonical output contains only allowlisted bounded fields and digests, never raw Docker output, prompt contents, arbitrary paths, environment values, or credentials. |
| AC-18-15 | Project-local runtime overrides cannot change prompt text, role identity, profile, sandbox, approval policy, mount contract, broker tools, or pipeline ordering; unknown or conflicting overrides fail closed. |

## Implementation plan

Implementation is intentionally split into independently reviewable gates. A
later task must not enable the public positive path before its predecessors are
green.

The specification review explicitly accepted the new public-input choice
(`--prompt-file`) and the v1 authentication rule (ephemeral container state is
never persisted back). Starting Task 1 still requires separate authorization
to create an isolated worktree/branch and change production or test code.

### Task 1 — Lock contracts and red tests

**Changes**

- Add the Docker runtime data contract, reason-code catalog, strict inspect
  fixtures, and launcher-result schema.
- Add red tests for every AC-18-05, AC-18-07, AC-18-08, AC-18-09, AC-18-11,
  AC-18-12, AC-18-14, and AC-18-15 case.
- Preserve all PR #27 tests unchanged as regression coverage.

**Verification**

- Unit tests prove exact argv construction and reject every unknown/extra
  inspect field that changes authority.
- No Docker daemon is required for this task.

### Task 2 — Implement the bounded Docker lifecycle adapter

**Changes**

- Implement local-daemon detection, approved image inspection, create/inspect,
  attach/start, bounded output, force-remove, and exact absence verification.
- Use only package-owned argv and labels; never shell or target configuration.
- Keep production launch disabled.

**Verification**

- Fake-process cases cover malformed output, partial writes, signals, timeouts,
  duplicate IDs, daemon disconnects, and cleanup uncertainty.
- Real Docker fixture proves nested recursive read-only behavior and kills a
  detached/reparented descendant.

### Task 3 — Build and bind the approved runtime image

**Changes**

- Add the minimal image source, non-root user, entry wrapper, versioned
  attestation schema, license/notices, and package-owned digest manifest.
- Pin base and Codex artifacts; prohibit mutable tags at runtime.
- Define the separately approved image build/publication procedure. Do not
  publish during the implementation PR without explicit authorization.

**Verification**

- Reproducible image checks verify entry wrapper bytes, expected Codex version,
  platform, labels, and zero unexpected runtime files/capabilities.
- Tampered wrapper/image/digest fixtures fail before App Server starts.

**External gate**

- A human must approve the exact image digest before it can become a trusted
  runtime input.

### Task 4 — Integrate Docker with the App Server broker

**Changes**

- Replace the production disabled branch only behind the verified Docker
  adapter; retain the injected inert-process seam for protocol unit tests.
- Add `workspace-only` runtime attestation and container `/workspace` mapping.
- Parse the entry attestation before `thread/start`; perform prompt checks at
  every trust transition.
- Keep dynamic broker operations bound to the main thread/turn. Subagents may
  do model/tool work inside the same container but cannot present themselves as
  the main broker caller; unrelated, resumed, and foreign calls stay rejected.

**Verification**

- Existing RPC and prompt snapshot tests pass.
- Integration tests cover main/subagent settings inheritance, revocation,
  foreign identities, and cleanup on every exit path.
- `trusted: true` remains unreachable with fake caller-supplied evidence.

### Task 5 — Real adversarial project E2E

**Changes**

- Add a temporary installed-project fixture and two real prompts: one main
  writing turn and one delegated writing subagent.
- Ask each to make an allowed source edit and to attempt the prohibited prompt
  attacks from AC-18-03.
- Capture only normalized results and before/after identities/digests.

**Verification**

- AC-18-01 through AC-18-09 and AC-18-12 pass with real App Server and Docker.
- The allowed workspace edits exist; every managed prompt and manifest remains
  byte-for-byte identical; no labeled container remains.
- A green simulated test does not substitute for this gate.

### Task 6 — Enable the bounded CLI and documentation

**Changes**

- Add strict `--prompt-file` parsing and the two safe profiles.
- Enable `launch` only when the approved image manifest and Docker preflight
  pass; retain current fail-closed behavior otherwise.
- Update README/help with supported layouts, prerequisites, outcomes, threat
  boundary, authentication handling, and recovery instructions.

**Verification**

- CLI tests cover defaults, invalid/duplicate/missing arguments, prompt-file
  races/limits, output/exit codes, and absence of Docker escape hatches.
- Human `update` between two launches satisfies AC-18-13.

### Task 7 — Compatibility and independent review

**Changes**

- Run source, project-local, and packed-consumer tests on Node 22.14.0 and
  24.19.0.
- Add Linux real-Docker CI without secrets for fixture-level lifecycle tests;
  keep authenticated real-App-Server acceptance in an explicitly trusted
  environment.
- Record separate macOS and Windows Docker Desktop acceptance before marking
  those hosts supported.

**Verification**

- Full `npm test`, `npm run check`, package-surface checks, `npm pack`, and
  `git diff --check` pass.
- An independent security/code review rechecks the exact head, Docker inspect
  contract, prompt races, auth exposure, and cleanup evidence.
- Merge, image publication, npm release, and consumer rollout remain separate
  approvals.

## Traceability

| Issue #18 requirement | Acceptance evidence |
|---|---|
| Writing roles cannot mutate managed prompts | AC-18-01, AC-18-02, AC-18-03 |
| Main session and subagents attest effective protection | AC-18-02, AC-18-07 |
| Human update remains possible | AC-18-13 |
| Checks/gates distinguish trusted and untrusted runtime | AC-18-05, AC-18-06, AC-18-11, AC-18-12 |
| Project layouts and supported Node versions | AC-18-10 |
| Fail closed under elevated/unsupported modes | AC-18-05, AC-18-07, AC-18-09, AC-18-11 |
| Project-local overrides cannot weaken governance | AC-18-07, AC-18-15 |
| No claim against direct administrator access | Non-goals and residuals |

## Normative references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): per-turn
  `cwd`, approval and sandbox settings, JSONL protocol, and external sandbox
  semantics.
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents):
  inheritance of the parent sandbox, permission mode, and live overrides.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) and
  [environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables):
  `auth.json`, `CODEX_HOME`, App Server state, and secret-handling boundary.
- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/):
  explicit read-only mounts, inspect evidence, and recursive read-only support.
- [Docker container execution](https://docs.docker.com/engine/containers/run/):
  isolated process tree/filesystem and runtime capability controls.
- [Docker Engine security](https://docs.docker.com/engine/security/): daemon
  socket authority, privilege, and capability risks.
