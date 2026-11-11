# MergeLane design

Status: functional design and Material 2 visual treatment approved by the user. Builder check found no blocking questions. Date: 2026-11-10.

## Intent and agreed requirements

MergeLane is a Chrome extension that organizes open GitHub pull-request tabs into native Chrome tab groups. Its purpose is to make a browser full of PRs reflect where the work stands without manual sorting.

All code and project artifacts belong in `./mergelane`.

The user chose the name MergeLane and GitHub API-based tracking. The initial workflow is In Progress -> In Review -> Approved -> Merging. Only feedback from a human other than the author triggers In Review; bot and author comments do not. The default Merging label is `mergify-queue`, and users can change it. Users can define categories, names, colors, conditions, and ordering.

Merged PR tabs close when a merge is detected. Unmerged PR tabs close only after the PR has remained closed for more than one hour. Reopening cancels that pending closure; a subsequent closure starts a new hour. GitHub status must be freshly checked before closure.

## Approaches

1. **GitHub API, selected by the user.** Structured PR, label, comment, and review data can be fetched without reloading tabs. Private repositories require authentication. This supports background status tracking and reliable cleanup.
2. **Read loaded GitHub pages.** Avoids separate API credential setup but couples classification to page markup and loaded content. Stale pages and layout changes complicate background tracking. Not selected.

The following implementation decisions form the approved design. Details explicitly left to the builder remain implementation choices.

## Scope and constraints

First release: Chrome Manifest V3; github.com PRs; public and accessible private repositories; local installation as an unpacked extension. No hosted service. Use TypeScript, a small bundled build, and ordinary HTML/CSS for extension UI. Specific build tooling is left to the builder.

Recognize `/owner/repo/pull/number` plus its files, commits, checks, and other subpages, ignoring query strings and fragments when identifying the PR. Do not mistake `/pulls` listings, issues, or repository pages for individual PRs. Track every matching open tab, including duplicates, but fetch each unique PR once per refresh. Work only in normal, non-incognito browser windows. Do not scan repositories for PRs that have no open tab.

Non-goals: changing PRs on GitHub, merging or posting reviews, GitHub Projects, GitHub Enterprise Server, cross-device synchronization, arbitrary user scripts, store publication, or a hosted OAuth service in this first version.

Avoid bot activity advancing work, old reviews overriding current reviews, network failures closing tabs, groups constantly changing position, unrelated tabs being managed, and browser restarts resetting the closed-PR grace period.

## Classification and customization

Default first-match priority is:

| Priority | Category | Condition | Suggested color |
| --- | --- | --- | --- |
| 1 | Merging | Has label `mergify-queue` | Purple |
| 2 | Approved | Has an active human approval and no outstanding human changes-requested review | Green |
| 3 | In Review | Has qualifying human feedback | Yellow |
| Fallback | In Progress | No other rule matches | Blue |

Evaluate current facts each refresh, rather than making progress irreversible. Removing the queue label can return a PR to Approved or In Review. A dismissed approval no longer counts. A currently requested change overrides approval for the approval predicate, but the queue label still wins in the default rules.

Human feedback includes conversation comments, published inline review comments, and submitted reviews by someone other than the PR author. Ignore pending reviews, missing/unknown users, GitHub Bot identities, `[bot]` logins, and a user-editable list of ignored logins. This list covers automation using ordinary user accounts, which the API cannot reliably distinguish from humans. Feedback is based on currently available history and is not cleared merely by a new commit or reopening.

Calculate active reviews per reviewer using the newest submitted decisive state (APPROVED, CHANGES_REQUESTED, or DISMISSED); a later COMMENTED review does not cancel a decisive state. Exclude the author and bots. Fetch all pages so old and current reviews are not confused. Follow GitHub's dismissal state rather than automatically discarding approval on each new commit. Approved means this category's rule is satisfied, not that every branch protection requirement is met.

Each category has a stable ID, editable nonempty name, one Chrome-supported color, enabled state, match conditions, rule priority, and independent tab-strip position. Separate rule priority from display order: users can display In Progress first without making it override Merging. Renaming preserves identity. Require distinct names, ignoring case, for clarity.

Initial condition types: label present/absent (free-text exact name, case-insensitive); qualifying human feedback present/absent; active approval present/absent; outstanding changes requested present/absent; draft yes/no. Support matching all or any of a category's conditions, without nested expressions or code. An editable fallback category is always present and cannot be disabled or deleted. Other categories can be added, removed, disabled, or reordered. Include restoring the default preset.

Closed PRs in their grace period retain their last category. If first encountered already closed, use the fallback until cleanup. Merged and expired-closed cleanup takes precedence over category rules.

## Tab management and cleanup

Create one MergeLane group per category per window, as needed. Keep tabs in their existing windows. Maintain stable category ordering among MergeLane-owned groups; do not continually reposition the whole block around unrelated tabs. Moving a PR tab manually into another group is temporary: the next refresh reapplies its category. Unrelated tabs in a group must never be moved or closed by MergeLane. Do not adopt an existing group merely because it has a matching title.

Pinned PR tabs stay pinned and ungrouped; the explicit merged/closed cleanup still applies to them. Preserve the user's collapsed state for groups. Remove only tracked PR tabs when they cease matching, and leave unrelated tabs alone. If a formerly tracked tab navigates to a non-PR page, release it from MergeLane ownership and ungroup it only if it still belongs to a MergeLane group.

Group IDs are session-scoped. Store a per-session ownership map in session storage so service-worker restarts preserve ownership without reusing stale IDs after a browser restart. Reconcile live tabs on startup; create new owned groups when ownership cannot be established. Update maps when groups or windows disappear. Do not close and reopen tabs just to regroup them.

For cleanup, use GitHub's most recent `closed_at` timestamp and current merged/state fields, not when the extension first noticed the closure. At the first successful refresh where merged is true, close all matching tracked tabs. For unmerged PRs, close only when current state is closed and elapsed time is strictly greater than 60 minutes. An open state clears any remembered deadline. A new `closed_at` replaces the previous deadline, including reopen/reclose cycles between polls.

Perform a fresh, successful PR-detail request immediately before a cleanup operation, re-evaluate eligibility, and re-read each candidate tab URL before removing it. Skip tabs that navigated elsewhere. Do not act from stale cached status, an HTTP error, or missing/invalid timestamps. A subsequent GitHub change in the small interval after the check is inherently outside the extension's control.

Chrome asleep or shut down delays detection and closure. Refresh on startup/wake; do not claim real-time delivery. Merged PR tabs intentionally reopened later are subject to the same cleanup rule.

## API access, refresh, and stored state

Proposed first-release authentication: one personal access token entered in extension settings, with read-only Pull requests and Issues permissions for selected repositories. Fine-grained tokens are preferred. Clearly show repository access failures; do not treat 404 as proof a PR was closed. Organization policy may require token approval. Multiple independently scoped credentials and OAuth onboarding are deferred.

Store credentials only in local extension storage restricted to trusted extension contexts. Never sync, export, log, embed, or send them anywhere except `api.github.com`. Local extension storage is not an encrypted secret vault. Render repository names, labels, and other API text as text, never executable HTML. The mockup uses fixture data and never asks for a real credential.

Use REST PR details, issue comments, PR review comments, and PR reviews. Follow pagination. Configure necessary tab-group, alarm, storage, and GitHub host permissions, avoiding unrelated hosts and content scripts. The builder must verify exact API permissions and endpoint availability against current official docs.

A background service worker reconciles tabs on relevant tab events, settings changes, startup, manual refresh, and a nominal one-minute alarm. Deduplicate by PR, debounce bursts, serialize reconciliation, and bound network concurrency. Recreate missing alarms on service-worker startup. Settings changes invalidate in-flight classification before it can move or close tabs.

Use ETags/conditional requests where supported; cache normalized facts and timestamps locally and expire unused PR records. A 304 requires a valid corresponding cache. Respect rate-limit and retry headers, back off on service failures, and show the last successful check. A failed or incomplete classification keeps the last known group; never infer absence from an unfinished paginated list. If the user changes credentials, invalidate authorization-dependent caches. Do not poll when there are no tracked tabs.

Separate pure URL parsing, review normalization, rule evaluation, and cleanup eligibility from API clients and Chrome operations. Version the settings schema so future releases can migrate safely. On initial installation, require credential setup and an explicit Enable action before automatic management begins; make the cleanup behavior visible there. Provide pause/resume.

## User interface

The options page contains category names/colors, independent group ordering and rule priority, a condition editor, ignored accounts, token setup, and cleanup behavior. Make the configured queue label easy to edit. Allow label text entry without requiring discovery calls.

A small popup shows whether management is enabled, last successful refresh, category counts, actionable access errors, Refresh now, Pause/resume, and a link to settings. It is not a second PR dashboard.

The first [interactive mockup](../../mockups/category-settings.html) was rejected for feeling basic and generic. The revised [workflow editor mockup](../../mockups/category-settings-v2.html) improved the layout with a compact category list and dedicated editor. The user liked this direction but identified excessive contrast from the near-black surfaces, and explicitly requested [Material 2 theming](https://m2.material.io/design/introduction#theming).

The current [Material 2 mockup](../../mockups/category-settings-v3.html) retains that layout and applies charcoal-gray surfaces, lighter elevated surfaces, desaturated lane colors, softened text emphasis, Roboto typography, consistent small component corners, and a muted mint primary action. The primary reference is [Material 2 dark-theme guidance](https://m2.material.io/design/color/dark-theme.html), with role-based color/typography/shape from [implementing your theme](https://m2.material.io/design/material-theming/implementing-your-theme.html). Keep meaningful text contrast; do not achieve softness by making labels illegible. Native Chrome group colors remain Chrome's fixed named colors; extension UI accents are softened representations.

The mockup demonstrates category names and colors, independent display ordering and rule priority, all/any condition editing, and a simulated PR classification. These files are design artifacts using example data; they do not contact GitHub or manage real tabs. The user approved the latest visual treatment.

## Validation and completion criteria

Meaningful automated tests must exercise rule precedence/custom categories, bot and author exclusions, pagination, review dismissal and replacement, missing access, rate limits, duplicate PR tabs, URL navigation races, and worker restart behavior. Time-controlled cleanup cases include exactly 60 minutes (keep), more than 60 minutes (close after recheck), reopened (keep), reopen/reclose with a new timestamp (restart grace), merged (close after recheck), and stale/error responses (keep).

Use mocked API and Chrome boundaries for deterministic integration checks. Manually load the built extension in Chrome to verify native grouping, separate windows, settings persistence, and cleanup with disposable test tabs. Never report mocked tests as a live authenticated GitHub test. Deliver source, an unpacked build, setup instructions, and the actual verification results. No publication or remote repository creation is part of this design.

## Left to the builder

Choose lightweight bundling/test tools, module/file organization, cache retention bounds, retry implementation details, accessible UI components, and minor styling. These choices must preserve the specified behavior and keep all artifacts inside the requested project directory. Revisit the design if an API limitation makes any agreed behavior impossible.

## Primary references

- [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub issue comments](https://docs.github.com/en/rest/issues/comments)
- [GitHub review comments](https://docs.github.com/en/rest/pulls/comments)
- [GitHub reviews](https://docs.github.com/en/rest/pulls/reviews)
- [GitHub API authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)
- [Chrome tab groups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
