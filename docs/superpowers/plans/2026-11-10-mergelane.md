# MergeLane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver an installable Chrome extension that groups GitHub PR tabs using customizable workflow rules and closes completed PR tabs according to the approved policy.

**Architecture:** A Manifest V3 service worker reads GitHub and reconciles native tab groups. Pure classification and cleanup functions are independent of browser and network operations. Extension pages edit validated local settings and communicate with the worker; credentials stay in trusted extension storage.

**Tech Stack:** TypeScript, esbuild, Vitest, plain HTML/CSS, Chrome extension APIs. Playwright for an isolated Chromium extension smoke test if available.

**Spec:** `docs/superpowers/specs/2026-11-10-mergelane-design.md`; visual reference `docs/mockups/category-settings-v3.html`.

## Global Constraints

- All artifacts remain in `./mergelane`.
- Chrome Manifest V3; github.com PRs; no hosted service; no publication.
- Only human feedback from someone other than the author advances review status.
- Default priority: Merging, Approved, In Review, then In Progress fallback.
- Merged: close on detection following fresh verification. Closed: strictly more than 60 minutes since latest `closed_at`, verified again before removal.
- Failed or incomplete checks preserve tabs and previous classification.
- API credentials stay local and are never exported or logged.
- Material 2: charcoal surfaces, elevation, desaturated accents, Roboto, no remote runtime resources.

## Review Focus

- A tab navigates or settings change during a network request: no stale move/closure. Task 3 tests.
- A published comment-only review follows approval, or a newer review is dismissed: correct active state. Task 1 tests.
- Pagination links or redirects point outside GitHub API: never leak authorization. Task 2 tests.
- Foreign tabs share an owned group: no foreign-tab movement caused by group reordering. Task 3 tests.
- Browser worker restarts with cached ownership, stale errors, or missing alarms: reconstruct management without duplicate groups. Task 3 tests and Task 5 smoke.

## File structure

- `src/core/model.ts`, `settings.ts`, `classify.ts`, `url.ts`: shared types, defaults/validation, pure facts/rules/cleanup, PR URL parsing.
- `src/github/client.ts`: authenticated paginated conditional requests and normalized snapshots.
- `src/background/reconcile.ts`, `worker.ts`: tab management policy and Chrome lifecycle/message handlers.
- `src/storage.ts`: trusted local settings, per-session ownership, status/cache persistence.
- `src/ui/dom.ts`, `options.ts`, `popup.ts`, `theme.css`, `options.css`, `popup.css`: safe DOM creation and Material 2 extension pages.
- `public/manifest.json`, `options.html`, `popup.html`, `assets/`: packaged local assets.
- `scripts/build.mjs`, `scripts/smoke.mjs`: deterministic packaging and isolated browser integration test.
- `tests/`: independent behavioral fixtures and boundary tests.
- `README.md`: install, permissions, tokens, behavior, development and verification limitations.

## Task 1: Classification and validated settings

**Interfaces:** `parsePrUrl(url): PrRef | null`; `deriveFacts(snapshot, ignoredLogins): Facts`; `classify(facts, settings): string`; `shouldClose(details, now): boolean`; `validateSettings(value): Settings`; `defaultSettings(): Settings`. Shared types include `Category`, `Condition`, `Settings`, `PrRef`, `Snapshot`, `Facts`.

- [x] Set up package/build/typecheck/test tooling inside this new project, on a local feature branch.
- [x] Write failing tests for exact GitHub PR URLs, rejecting spoofed hosts/listings; bot/author filtering; latest decisive reviews; label priority versus display order; all/any and negative conditions; invariant fallback and duplicate names; closure boundary, reopen and invalid timestamps.
- [x] Run `npm test -- tests/core.test.ts` and confirm missing behavior fails.
- [x] Implement the pure functions and validated schema version 1 with defaults paused, empty token, four lanes.
- [x] Run `npm test` and `npm run typecheck`; expect success. Commit the tested core.

## Task 2: GitHub transport

**Consumes:** `PrRef`, `Snapshot` from Task 1.
**Produces:** `GitHubClient(token, cache, fetcher, now)` with `snapshot(ref): Promise<Snapshot>`, `details(ref, fresh?): Promise<PrDetails>`, and serializable request cache. `ApiError` includes a safe message and retry timestamp, never a response body or token.

- [x] Write failing tests for all three comment/review collections, pagination, ETag/304, fresh detail checks, invalid payloads, 401/403/404/429/5xx, retry headers, cache invalidation and foreign pagination links.
- [x] Run `npm test -- tests/github.test.ts`; expect missing client behavior to fail.
- [x] Implement GET-only GitHub requests, `redirect: error`, trusted-path checks, request timeout, API version header, safe error messages, retry metadata and conditional cache reuse.
- [x] Run full tests and typecheck. Commit transport.

## Task 3: Browser reconciliation and worker

**Consumes:** Task 1 functions, Task 2 client.
**Produces:** `reconcile(deps): Promise<RunStatus>` where dependencies include Chrome API, immutable settings, API client, session ownership and `isCurrent(): boolean`. Worker owns serialization, debounce, storage and alarms.

- [x] Write failing tests using a stateful Chrome boundary fake for duplicate PR tabs; per-window groups; ownership restoration; pinned tabs; navigation races; fresh merged/closed verification; foreign group members; category rename/delete; invalidated settings and access errors.
- [x] Run `npm test -- tests/reconcile.test.ts`; expect missing orchestration to fail.
- [x] Implement all mutations behind freshness checks. Refresh the live URL before grouping/removing. Preserve old groups on check failures. Keep group ownership in session storage and a bounded cache in local storage.
- [x] Implement one-minute alarms, tab/settings events, manual refresh, pause, token validation/setup, serial runs with rerun requests, bounded network concurrency and API backoff. Reject messages from non-extension senders.
- [x] Run all tests and typecheck; commit background worker.

## Task 4: Material 2 settings and popup

**Consumes:** validated settings and `RunStatus`; worker messages `refresh`, `getState`, `saveSettings`, plus explicit `setEnabled`, `setToken`, and `disconnect` actions. Operational controls do not validate or save an unfinished editor draft.
**Produces:** native extension options and popup pages with local bundled fonts and no inline/external executable code.

- [x] Implement the approved layout, replacing fixture state with persisted settings. Include add/delete/enable categories, independent display/priority controls, all/any and negative conditions, fallback protection, ignored logins, credential connection and cleanup disclosure.
- [x] Add basic behavioral UI tests where necessary for credential handling, form validation and all/any editing; use browser smoke for actual persistence and navigation. Do not test decorative CSS.
- [x] Provide connection setup and explicit enable, global pause/resume, real status/errors/counts, last-check time, manual refresh, and settings access in the popup.
- [x] Run full tests/typecheck/build. Commit pages and bundled assets.

## Task 5: Integration, review and delivery

- [x] Package via `npm run build` into `dist/`; build fails on missing manifest entrypoints/assets. Inspect produced files.
- [x] Run isolated Chromium integration with fixture GitHub replies to test actual extension loading, native grouping, cleanup and settings. No real user tabs or credentials. Clearly distinguish fixture API responses from live authenticated GitHub verification.
- [x] Request one fresh reviewer against the final source, spec, plan and tests. Fix important findings with regression tests and rerun required checks.
- [x] Write install/setup instructions and actual verification results. Save a local commit and an installable zip. Do not publish or create a remote.

## Execution decisions

The user has approved the functional and visual design after several review rounds. Implementation continues under that existing authorization. Use inline execution and one final review; no extra workflow-choice approval is necessary. The requested directory is a new project containing only design artifacts, so initialize a local feature branch there rather than create an additional worktree elsewhere.
