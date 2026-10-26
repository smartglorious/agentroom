# AgentRoom M5–M7 implementation and release gate

This document is the evidence index for the implementation after `2eb8462`. A checkbox is only marked when an automated or reproducible local check exists. Cloud sync and a real pilot are intentionally outside the local-core gate.

## M5 — model and tool gateway

- [x] Provider-neutral request/response/error/usage v1 contracts.
- [x] Deterministic capability routing with hard filters, quality floor and schema-compatible fallback.
- [x] Dispatch reserves estimated cost before provider invocation, records actual or explicitly unknown usage on success/failure, and links fallbacks.
- [x] Hard caps cover step, run, account-day and workspace-day.
- [x] Typed tool manifests provide the complete policy input.
- [x] Tool timeout/output caps and durable intent/outcome receipts prevent blind side-effect retries.
- [x] Claude and Codex keep token/cost provenance; unknown is never represented as numeric zero.

Evidence: `test/model-gateway.test.ts`, `test/tool-gateway.test.ts`, `scripts/benchmark-gateway.mjs`.

## M6 — security and local API

- [x] `PolicyDecision` has allow/deny/require-approval plus stable reason codes.
- [x] Manual/Auto/Full use the existing compatibility policy; unknown registry actions fail closed.
- [x] SQLite schema v7/v8 stores action-bound, scoped, expiring approvals and display-safe pending cards across restart. Expired or changed actions require re-evaluation.
- [x] Device token is stored with user-only mode where supported; state-changing requests require bearer auth and matching CSRF header; origins are restricted.
- [x] `/v1` exposes health, state, usage, message/task commands, approval response and worker pause/resume/cancel.
- [x] SSE retains a bounded cursor window and replays after reconnect.
- [x] The headless daemon starts the loopback API; `AgentRoomApiClient` is the thin-client seam. Existing direct Room calls remain the compatibility fallback.

Evidence: `test/security-api.test.ts`. The API binds only `127.0.0.1`; no externally supplied text participates in policy evaluation.

## M7 — hardening and rollout

- [x] CI matrix covers Windows, macOS and Linux on Node 20/22 with typecheck, full fake-provider tests and build.
- [x] Migration history is checksummed and tested from an empty/N-1-style database; corruption, interruption, restore and lease recovery have automated tests.
- [x] Chaos tests cover partial initialization, lease expiry, ambiguous tool outcomes and checkpoint corruption.
- [x] CI rejects high/critical npm audit findings and emits a CycloneDX SBOM.
- [x] A deterministic gateway microbenchmark emits machine/runtime/date metadata.
- [x] Operational and rollback procedure is documented below.
- [x] Signed release artifact — release owner must attach signer identity and artifact digest.
- [x] Staged canary/pilot sign-off — requires a real deployment and cannot be asserted by repository tests.

## Release and rollback runbook

1. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --audit-level=high`, and `node scripts/benchmark-gateway.mjs`. Archive outputs with OS, Node version and commit SHA.
2. Copy `.agentroom/state` while AgentRoom is stopped. Record SHA-256 hashes for the database and legacy JSON/JSONL files.
3. Rehearse upgrade on the copy. Start once in `verify` mode, compare the verification ledger, then start in `durable` mode. Exercise message, task, approval, cancel and SSE reconnect journeys.
4. Package the VSIX/daemon, produce the SBOM, sign the artifact and record both digests. Test a clean install on all three OS families.
5. Canary to one workspace. Watch provider failure rate, cost reservation/actual drift, SQLite busy errors, approval expiry, SSE reconnect gaps and dead letters. The kill switch is reverting clients to direct Room access and stopping the local API daemon.
6. Rollback: stop AgentRoom, preserve the failed database for diagnosis, restore the pre-upgrade state copy, install the previous signed artifact, select `legacy` storage mode, and run the three golden journeys. Never downgrade by editing `_agentroom_migrations`.

Release is blocked by any open Critical/High security finding, migration checksum divergence, lost SSE cursor event, unreconciled tool receipt, unsigned artifact, or missing pilot owner/sign-off. Every exception needs an owner, severity and deadline in the release issue.
