# Local Docker lifecycle fixture v3

This synthetic Linux/arm64 fixture replaces the Task 2 v2 pin, whose actual
`/fixture`, `probe`, and single-variable environment no longer matched the
strict Task 3 image preflight. It contains a small Rust probe, not Codex App
Server. Its entrypoint, command, environment, user and inherited labels match
the runtime contract. The `0.154.0` label identifies that contract's expected
image metadata; it does not claim this probe is the production binary.

The human authorized building and verifying this local fixture on 2026-09-16.
The production OCI, inputs, Dockerfile, wrapper, approved binding and private
GHCR publication are unchanged. This fixture is test-only and excluded from
the npm package. No launcher activation, Task 4, release or deployment is
implied.

## Reproduce the artifact

From the repository root, with Docker BuildKit available:

```sh
docker buildx build --platform linux/arm64 --network=none --no-cache \
  --provenance=false --sbom=false --build-arg SOURCE_DATE_EPOCH=1789511465 \
  --tag issue18-task3-fixture-v3 \
  --file test/fixtures/docker-runtime/Dockerfile \
  --output type=oci,dest=/tmp/fixture-a.oci.tar,rewrite-timestamp=true \
  test/fixtures/docker-runtime
```

Repeat with `/tmp/fixture-b.oci.tar` and compare both archives. The pinned Rust
and Debian inputs are in `Dockerfile`; build steps have no network access.
The build runs two Rust mount-parser regressions before compiling the probe.
They distinguish the visible read-only nested mount by parent ID from its
hidden writable counterpart and reject missing or ambiguous observations.

Both observed archives were byte-identical:

- OCI SHA-256: `df93b06d6b99ba7d482c1a4fe91b77bd8e29157db87dc332e06e15a89af33982`.
- Manifest: `sha256:98dee65bf05641d0c464b03580dacb0cdefc91aa8ff0fdb6994f375218ffe79f`.
- Config: `sha256:1c8483139c8d5131c129fc0bd3531a0cc15dc275d0f37afd4835bb8d78ab28bc`.

`manifest.json` and `config.json` preserve the exact OCI JSON bytes, including
their original lack of a trailing newline. `build-record.json` records source,
binary and archive hashes. Every descriptor size and hash, compressed layer
hash and rootfs diff ID was verified against the archives. `image.json` is the
single immutable pin consumed by the opt-in runner and deterministic tests.
Do not edit its metadata while retaining a digest from a different artifact.

## Real execution prerequisites

Use a disposable Linux/arm64 daemon with explicit `name=userns`, runc and a
kernel supporting recursive read-only bind mounts. The runner also needs a
supported Node version and sudo access to mount and unmount its nested tmpfs.
It must run in the daemon's filesystem namespace so the temporary project
paths refer to the same files. No daemon contract is bypassed for this fixture.

Provision the OCI bytes through a temporary HTTPS registry bound to daemon
loopback under `fixture.local`, then pull exactly the reference in `image.json`.
Confirm Docker reports both its matching config ID and immutable `RepoDigests`
entry. Remove the temporary registry, hostname mapping and CA before running:

```sh
(umask 000; SDD_REAL_DOCKER_FIXTURE=1 npm run test:docker-real)
```

The fixture requests mode `0666` for its synthetic prompt files. Use the
subshell's `umask 000` so those files remain writable by the container UID
before mounting them read-only. Otherwise a host umask such as `022` can
cause a DAC permission denial instead of the required `EROFS` observation.
This changes only fixture setup; all mount, identity and cleanup assertions
remain enabled.

The probe writes an ordinary workspace file, attempts writes to protected
prompts and a real nested mount, and starts a new-session descendant. The
descendant waits until reparented to PID 1 before recording its PID and advancing
its heartbeat. The runner requires exact-ID removal, stopped heartbeat,
unchanged prompt bytes and absence of ownership-labelled containers.

## Verification record

Local evidence is retained outside Git at
`/private/tmp/task3-fixture-v3-20260916/`. Builds and observed OCI identities
passed. The initial real run on Docker 29.4.0 with userns-remap rejected
container inspect before start because Docker prepends the explicit
`CODEX_HOME` override while the adapter expected it last. Exact-ID cleanup
and ownership-label absence succeeded. This is not a successful real lifecycle
gate; its captured evidence is `captured.json`.

The disposable daemon used the official Docker 29.4.0 DinD image
`sha256:a6dd5322747a95cd8e3207bd8d415a8fd20ec34e9c00f06dc019cbd912013489`
and Node 24.19.0. Its outer privileged container had no host bind mounts,
no host Docker socket and no external network. Docker Desktop's daemon
configuration was not changed. The temporary daemon container and its owned
anonymous data volume were removed after collecting the failure evidence.

The environment-order correction was subsequently authorized and applied to
the adapter: explicit `CODEX_HOME` comes first, followed by inherited image
variables, with exact array equality retained. The deterministic regression
first reproduced `BROKER_CONTAINER_INSPECT_INVALID` with the observed order
and then passed after the fix. Duplicate, missing, changed and incorrectly
ordered container environment values remain rejected before start.

The final real run on 2026-09-16 passed with the same immutable fixture, Node
24.19.0, Docker 29.4.0/API 1.54, kernel 6.12.76-linuxkit and explicit userns-remap.
`verification.json` preserves the sanitized canonical result. It proves the
ordinary workspace write, recursive read-only nested mount, unchanged prompts,
reparented descendant heartbeat, exact-ID force removal, stopped heartbeat and
absence by ID and ownership label. An initial run with umask `022` failed the
strict existing-prompt `EROFS` assertion; the final run used the documented
umask `000` without changing that assertion or rebuilding the fixture.

Final evidence is retained at `/private/tmp/task3-env-order-20260916/`. The
disposable verifier and its owned data volume were removed after the run.
Production artifacts and the approved binding remain unchanged. The adapter
still returns `trusted:false`; Task 4 and the positive launcher remain pending.
