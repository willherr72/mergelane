# Assisted token import and owner connections

The user selected assisted import after choosing personal access tokens instead of a GitHub App for company use. Preserve the API-based classification and approved Material 2 styling.

## Approaches

Manual paste with GitHub's supported prefilled form remains the fallback. The selected approach adds an explicit Import into MergeLane button to the GitHub token setup tab. A GitHub App was rejected because installation requires organizational approval. GitHub still generates tokens and enforces its authentication and organization policies.

## Behavior

- Settings detects owners from open PRs, lists saved connections, and offers Connect [owner]. Each owner has an independent local token; connecting another owner does not overwrite existing connections.
- The existing single token remains a labeled default connection on upgrade until explicitly removed. Category saves cannot alter credentials or operational state.
- Connect opens a worker-created GitHub token creation tab with owner and read-only Issues/Pull requests permissions prefilled.
- Only that tab has an active import session, lasting 30 minutes and surviving service-worker suspension but not a browser restart. Sessions contain owner/tab/expiry only, never tokens. Disconnect and tab closure invalidate them.
- An isolated content script on GitHub fine-grained token settings pages shows a small Material-styled import panel only for an authorized setup session. It reads narrowly selected generated-token controls only after a trusted user click. It never scans arbitrary page text, reads cookies, intercepts network traffic, or forwards a token to page scripts.
- Import verifies account and available owner PR details/comments/reviews before saving. Failure leaves previous credentials intact and permits retry while the session remains valid. No matching PRs means an explicit account-only verification message. Success consumes the session and opens MergeLane settings; management remains in its existing enabled/paused state.
- Content-script messages have a separate restricted handler. No settings/status/credential read endpoints are exposed to web pages. Sender tab, top frame, current URL, setup session and expiry must match. Replay is rejected.
- API calls select the matching owner's connection, falling back to the existing default token if present. Cache and retry state are separate per connection. Missing/failed connections leave affected tabs in place while other owners continue.
- Manual paste, per-owner check/remove, disconnect-all, and pause remain available. No hosted service or GitHub App is introduced.

## Verification limits

Live GitHub token-result HTML may change and requires a real authenticated user to confirm. Automated fixtures test common dedicated token controls, missing/ambiguous token results, and real native extension messaging/navigation. If detection fails, offer manual paste without guessing or saving a different token.
