# MergeLane verification

Date: 2026-11-10. Platform: Windows; Node.js 24.12.0; isolated Playwright Chromium 158.

## Automated checks

- `npm test`: 54 tests passed across workflow rules, settings actions, owner routing/backoff, import guards, GitHub transport, connection verification, and browser reconciliation.
- `npm run typecheck`: passed.
- `npm run build`: passed; manifest entrypoints, bundled fonts, and PNG icons verified.
- `npm run smoke`: 13 integration checks passed against the actual packaged extension using native Chrome APIs.
- `npm run smoke:import`: 7 integration checks passed using the actual content script, Chrome messaging and trusted storage restrictions.

The browser integration verified paused-by-default installation; credential setup and omission from public state; bot/human/review/queue classification; merged and closed cleanup; a recent closure staying open; pinned tabs and separate windows; category/label editing; custom-category persistence; popup pause/resume; actual MV3 worker restart with alarm reconstruction and group reuse; saving a stale draft without undoing a pause; pausing/disconnecting with unfinished rules; and a narrow settings layout with no horizontal overflow.

The import integration verifies explicit trusted clicks, missing generated tokens, restricted settings/storage access, unrelated setup tabs, worker-restart persistence, successful owner verification, replay rejection, failed import/retry, native grouping with distinct credentials for two owners, removal of one connection, Disconnect, expiry, and navigation away while verification is in flight.

The smoke tests use fixture GitHub responses/token-result pages and temporary browser profiles. They do not contact GitHub with real credentials or alter existing user profiles. Test profiles are removed after the browser closes.

## Regressions caught during implementation

- A tab can be loading while Chrome hides its pending destination URL. Mutations now wait for navigation to settle; the regression test was observed failing before the fix and passing afterward.
- Long category text caused a two-column layout to overflow a narrow viewport. The browser check caught the overflow; the category grid now allows its columns to shrink and text to truncate.
- The initial browser-test wait treated an asynchronous condition as truthy before navigation finished. The test now waits on the actual queried tab state.
- A valid personal-account token could pass setup while having no access to an organization's private PRs. Version 0.1.1 prefills the resource owner and read permissions, verifies open PR details/comments/reviews for the selected owner, and keeps the previous token if verification fails. Tests cover account success with repository 404, missing comment permission, rate limits, duplicate PR tabs, multiple owners, and account-only verification when no matching tabs are open. Native Chromium verifies the owner link, rejected replacement, preserved credential, and successful retry/check.

## Artifacts

- `dist/`: unpacked extension ready for Chrome's Load unpacked action.
- `artifacts/mergelane-0.2.0.zip`: archive of the same unpacked extension, with the manifest at its root.
- `artifacts/smoke-report.json`: machine-readable integration results.
- `artifacts/import-smoke-report.json`: machine-readable assisted-import integration results.
- `artifacts/assisted-import.png`: isolated helper panel screenshot, without token contents.
- `artifacts/settings.png`, `settings-narrow.png`, `popup.png`: screenshots from the tested extension.
- `README.md`: setup, permissions, workflow and development instructions.

## Scope of evidence

The user reported assisted import working in a live GitHub setup after the 0.2.0 build. This is user-reported confirmation, not an independently observed authenticated test. GitHub's token-result markup, organization policies, fine-grained token approval, and repository access can vary. The helper intentionally declines missing or ambiguous token controls; manual paste remains available. Full browser-restart invalidation relies on Chrome session-storage lifetime; actual worker suspension/restart is tested. Version 0.2.0 is prepared for a public GitHub release; it is not published to the Chrome Web Store.

## Independent review

An independent reviewer examined the source, tests, packaging and approved requirements. It found no critical issues and three important issues, all corrected before delivery:

1. Saving a stale category draft could undo a pause made from another page. Operational state now changes only through explicit worker actions. A browser regression reproduced the previous failure and passes after the fix; unit tests also enforce current-token/current-enabled preservation.
2. Invalid unfinished rules could block Pause and Disconnect. Those controls now act on persisted settings independently of the editor. Both actions are covered by unit and browser regressions.
3. Group reordering could move a loading/navigating PR even when ordinary grouping skipped it. Both group-order eligibility and the last membership check now require stable navigation. The focused regression was observed failing before the fix and passing afterward.

No minor findings were deferred. The reviewer did not independently verify live GitHub access, organization policies, browser timing, or visual fidelity. Native Chromium integration and screenshots cover the browser behavior and rendered UI; live account access remains the limitation described above.

The 0.1.1 connection correction received a separate review with no blocking findings. The reviewer independently reran all 46 unit tests. Optional additional cases noted were permission verification for closed PRs and an open-tab list containing only other owners; no code defects were identified.

The 0.2.0 assisted-import and multiple-owner changes received a separate review with no blocking findings. Review focused on credential disclosure, sender validation, session lifetime/replay/navigation, migration, and cache/retry isolation. Native smoke checks subsequently covered two review gaps: navigation during verification and direct content-script storage denial. Live GitHub markup and full browser restart remain the limits described above. The import smoke's setup-tab matcher now identifies the requested owner URL rather than accepting any new page event after a navigation timeout was observed in a concurrent browser run.
