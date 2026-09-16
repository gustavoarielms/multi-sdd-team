# Runtime image build and binding procedure

This directory is the package-owned source for the Issue #18 Task 3 runtime
image. Building, publishing, or binding an image remains a separate release
operation. The application launcher never executes this procedure.

## Fixed inputs

- Platform: `linux/arm64` only.
- Builder: official `rust:1.98.1-bookworm`, fixed to OCI index
  `sha256:9a73a5088750b4c95158ab26629c854c3d6fc4b173cb7bc8079ad252d8ed7bfa`
  and `linux/arm64` manifest
  `sha256:09e98f39fa15751de9476fefafe4be0e4ef92b292d608410595bbbde9ebdd375`.
- Base: the exact Debian 13.6 OCI index, platform manifest, and config digests
  in `runtime-image-inputs.json`.
- Codex: the official `rust-v0.154.0` App Server package for
  `aarch64-unknown-linux-musl`, verified against the archive SHA-256 in
  `runtime-image-inputs.json`.
- Runtime identity: UID/GID `10001:10001`.
- Image repository:
  `ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server`.

No credential, `auth.json`, token, project file, or user Codex state may enter
the build context or resulting layers.

## Candidate tag convention

Use `<codex-version>-task<task-number>-candidate-<architecture>` for candidate
publications. The version is the pinned Codex version without a `v` prefix;
the task number identifies the Issue #18 delivery task; the architecture is
the OCI architecture, such as `arm64`.

The authorized Task 3 publication is
`ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server:0.154.0-task3-candidate-arm64`
with private visibility, using the exact reviewed OCI A archive. This records
the publication authorization, not a claim that publication has completed.

Confirm the exact tag and visibility before each future publication. Do not
move an existing tag to a different digest, add aliases such as `latest`, or
change visibility without separate authorization. If a candidate needs a new
digest under an already-used tag, stop and obtain an explicitly approved
distinct tag. The tag is a discovery label; the final runtime manifest always
uses the registry-observed platform digest and requires separate human
approval. Binding approval does not automatically rename or promote the tag.

## Ordered release gate

1. Verify the human-approved `linux/arm64` Rust builder index, platform, and
   config digests against `runtime-image-inputs.json`.
2. In two clean builder invocations, compile
   `runtime-entrypoint/Cargo.lock` with the same pinned toolchain, target,
   source epoch, and release flags. Use `SOURCE_DATE_EPOCH=1789511465`, disable
   incremental compilation, and set
   `RUSTFLAGS=-C strip=symbols -C link-arg=-Wl,--build-id=none`. The two
   binaries must be byte-identical.
3. Download the Codex archive from the fixed official URL into an isolated
   staging directory and verify its SHA-256 before extraction. Do not commit
   the archive or extracted package.
4. Stage only the verified archive and byte-identical wrapper under
   `container/dist/`; the directory is ignored by Git and excluded from npm.
5. Build `container/Dockerfile` twice for `linux/arm64` with no cache and
   normalized creation timestamps, using the repository root as the context so
   Docker automatically applies `container/Dockerfile.dockerignore`. That
   allowlist permits only the Dockerfile, the two staged artifacts, and the two
   OpenAI notice files to enter the builder. Disable automatic provenance and
   SBOM attestations and export OCI layouts with
   `rewrite-timestamp=true`; do not push yet.
6. Compare both OCI results. Their platform manifest, config, layer digests,
   entrypoint hash, Codex executable hash, and normalized rootfs inventories
   must match exactly.
7. Verify the evidence with `validateRuntimeImageEvidence`. The observed user,
   entrypoint, command, platform, file inventory, capabilities, devices, and
   absence of authentication files must satisfy the closed contract.
8. Publish only after the candidate evidence is independently reviewed. Record
   the registry index, platform, and config digests returned by the registry.
9. Create `governance/runtime/v1/codex-app-server-image.json` from those
   observed values. It must validate against
   `codex-app-server-image.schema.json` and receive separate human approval in
   a manifest-only binding change.

Any mismatch, missing digest, mutable reference, non-empty unexpected-file
set, or non-reproducible output stops the release. Task 4 cannot consume an
image until the final manifest exists and is approved.

## Observed local candidate

`runtime-image-build-record.json` records the byte-identical wrapper and OCI
build outputs observed from two clean invocations. Its `candidate-unpublished`
status and verification flags preserve the historical pre-publication snapshot;
the local digests remain build evidence.

On 2026-09-16, the exact OCI A was published privately under the authorized
`0.154.0-task3-candidate-arm64` tag. Registry rereads of the index, platform
manifest, config, and every layer matched the reviewed OCI bytes. The final
`governance/runtime/v1/codex-app-server-image.json` uses the registry-observed
image digests, artifact hashes verified from the downloaded layers, and the
rootfs inventory revalidated from the image pulled by digest. The approved
upstream Debian base pins remain the constants required by the existing schema.
The final binding received separate human approval on 2026-09-16. Task 4 and
the positive launcher remain disabled.

## Task 3 binding approval

Explicit human approval was recorded on 2026-09-16 for the reviewed
`governance/runtime/v1/codex-app-server-image.json` with file SHA-256
`sha256:977688cc1fe3407467af002f7e62fd647c25fe6bb23a0fa5bc646eb5f41fb412`.
Its approved runtime reference is
`ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server@sha256:633fbdd34f7760be8d94dae3a1673694b9ff3e70d3a975ccb1c7e6f497ff286f`.

The publication, exact registry reread, and final binding gates for this
candidate are complete. This approval covers only the reviewed binding; it
does not authorize Task 4, positive launcher activation, a Git commit or push,
a pull request or merge, a GitHub/npm release, or deployment. Any change to
the manifest requires a new review and explicit human approval.
