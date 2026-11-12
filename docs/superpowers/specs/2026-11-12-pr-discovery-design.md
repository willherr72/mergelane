# Open newly created PRs

The user requested automatic tabs for new PRs and selected PRs they create in connected owners' repositories. Existing tab grouping and cleanup continue to apply.

Use the existing minute refresh and each owner's GitHub token to list open issues created by the authenticated account, retaining only pull requests under that owner. This avoids a new service and search-index limits; repository-by-repository polling would require more requests. Explicit owner connections participate; the migrated default token continues to manage existing tabs only.

Implementation decisions: the first successful scan establishes a baseline without opening older PRs. Later scans open newly created PRs in background tabs in a normal non-incognito window, checking existing and pending tab URLs first. Persist the baseline, account identity, and handled PR keys across worker/browser restarts; manually closed tabs stay closed. Changing account establishes a new baseline. Removing a connection removes its discovery state. Pausing stops discovery and tab creation; resuming discovers PRs created during the pause. Never open closed PRs from stale listing data: verify their current details immediately before creation.

Throttle automatic discovery to once a minute per owner. Manual Refresh now may scan sooner, respecting API retry windows. Isolate errors per owner, report them in existing status, and preserve progress on partial browser failures. No new permissions or dependencies. No real GitHub writes or publication.

Validation covers API filtering/pagination/cache normalization, initial baseline, background creation and grouping, existing/loading tabs, manual closure and restart, pause/stale runs, failed creation and API errors, multiple owners, and ordinary regression/build checks.
