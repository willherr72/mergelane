# PR discovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically open newly created authored PRs for connected owners.

**Architecture:** Add authored-PR listing to GitHubClient and owner routing, then a discovery coordinator with durable per-owner state. Invoke it from the existing serialized worker refresh, using current-settings guards and existing error reporting.

**Tech Stack:** TypeScript, Chrome MV3 APIs, Vitest, existing Playwright smoke fixtures.

**Spec:** ../specs/2026-11-12-pr-discovery-design.md

## Global constraints

- Only the authenticated author's PRs under explicit connected owners; no new permissions or dependencies.
- Background tabs, normal windows, no duplicates or repeated reopening after manual closure.
- Preserve existing grouping, cleanup, owner retry windows, and pause behavior.

## Review focus

- Initial empty listing must still establish a durable baseline.
- In-flight settings changes must prevent tab creation and stale state writes.
- A failed owner must not block another owner or existing tab grouping.
- Pending URLs and PR subpages must count as existing tabs.
- A failed tab creation must remain eligible for retry.

## Task 1: API and discovery coordinator

- [x] Add failing tests to `tests/discovery.test.ts` and `tests/github.test.ts` for the behavior above, including pagination validation and current detail verification.
- [x] Add `GitHubClient.authoredPullRequests(owner)` returning `{ login, prs }`, where PRs contain `PrRef` and `createdAt`; expose through `OwnerClient`.
- [x] Add `src/background/discovery.ts` with `discoverPullRequests(deps)`, persistent owner baseline/account/seen keys, cooldown/error state, and a save callback after each durable change.
- [x] Run focused tests and the full unit suite.

## Task 2: Worker integration and documentation

- [x] Load discovery state in `src/storage.ts`; integrate discovery into `worker.ts`, preserving serialized runs, cancellation, credential resets, and status errors. Manual refresh bypasses only the discovery cadence.
- [x] Extend fixture smoke coverage for baseline, new authored PR background creation/grouping, and manual-close persistence.
- [x] Explain discovery in README and settings text.
- [x] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run smoke`, and `npm run smoke:import`; review changes and record outcomes.

## Execution record

- Existing isolated branch: `will/open-new-pr-tab`; starting tree clean.
- User selected authored PRs. Baseline/no-backlog, background placement, and persistent manual dismissal are implementation choices stated in the conversation.
- Initial suite: 65 tests passing. Discovery regressions failed before implementation; implementation passed all 77 tests.
- Independent review identified per-PR failure starvation and lost creation history during epoch invalidation. Both were reproduced with failing tests, fixed, and verified with 80 passing unit tests plus a native pause-during-creation regression.
- Final verification: typecheck/build and 24 native browser checks passed; import regression checks passed. See `docs/verification.md` for scope and limits.
