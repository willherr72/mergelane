# MergeLane

A Chrome extension that groups open GitHub pull request tabs by workflow. Includes editable categories and conditions, native tab groups, a Material 2 settings page, and automatic cleanup of completed PR tabs.

## Install

Download **mergelane-0.3.0.zip** from the [v0.3.0 release](https://github.com/willherr72/mergelane/releases/tag/v0.3.0) and extract it to a folder you will keep. The release ZIP contains the ready-to-load extension; GitHub's automatic source-code archives require building first.

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**, then select the extracted folder containing `manifest.json`.
4. In MergeLane's settings, connect a GitHub personal access token.
5. Review your categories and click **Enable MergeLane**.

The extension starts paused. It does not organize or close tabs until enabled. Pin MergeLane from Chrome's extensions menu for quick access to its popup.

For updates, extract the new release into the same folder and click **Reload** on MergeLane's card in `chrome://extensions`. Do not open `options.html` directly from disk; its functionality requires the extension context.

## GitHub connection

Open MergeLane Settings and click **Add connection**. Enter an organization or GitHub username, or choose a suggestion labeled **Detected from your open PR tabs**. The form always starts blank; no organization is hardcoded. Click **Create token for [owner]** to open GitHub with the owner and read permissions prefilled. Select repositories, generate the token, and click **Import into MergeLane** in the helper panel. GitHub may ask you to sign in or confirm your identity. You can also paste a token and click **Save connection**.

**Resource owner must be the organization that owns the repository**, not your personal account. “All repositories” applies only to that selected owner. Grant **Pull requests: Read-only** and **Issues: Read-only**. GitHub may require organization approval; a pending token cannot read private organization repositories. See [GitHub's token setup documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Connecting validates the account and the open PRs under the selected owner, including comment and review access. A failed check leaves previous connections in place and lets you retry. With no matching PR tabs, MergeLane explicitly reports repository access as untested. Open a PR and click **Check** beside the saved connection to verify it.

Saved connections show their last check and whether repository access was verified, only the account was verified, or attention is needed. Use **Check** to test a saved token and **Replace token** (or **Reconnect**) to renew it without changing its owner. Adding an already-connected owner cannot replace its token.

Add a connection for each owner. One owner's token can cover many repositories; MergeLane automatically selects the matching connection for each PR. Each connection has its own cache and retry window, so one failing owner does not stop the rest. Categories are shared across owners. **Remove** disconnects one owner; **Disconnect all** removes all connections and pauses management. Existing single-token installations retain their token as a labeled default connection, used and checked only for owners without a separate connection.

The import helper appears only in a setup tab opened by MergeLane. Its grant lasts 30 minutes, survives a background-worker restart, and ends on successful import, tab closure, Disconnect, or browser restart. Token controls are read only after your explicit import click. If GitHub changes its page layout and the helper cannot identify exactly one generated token, use manual paste. This is assisted import, not automatic token generation or approval; no GitHub App or hosted service is required.

Tokens are stored in local extension storage restricted to trusted extension contexts. They are not synchronized or included in status responses. The import helper sends the selected token only to MergeLane's worker; API requests send it only to `api.github.com`. Local extension storage is not an encrypted password vault. Do not commit real tokens to source control.

## Default workflow

Rules run in the following priority order:

| Category | Condition |
| --- | --- |
| Merging | Has the `mergify-queue` label |
| Approved | Has an active human approval and no outstanding human changes-requested review |
| In Review | Has a conversation comment, inline review comment, or submitted review from another human |
| In Progress | No other category matches |

Author comments and GitHub bot identities do not trigger review. Add automation that uses ordinary user accounts to **Additional accounts to ignore**.

Classification follows current facts. Removing a queue label or dismissing approval can move a PR back to a previous category. A comment-only review does not revoke an existing approval. “Approved” describes this rule, not a guarantee that all branch protection checks are satisfied.

## Customize

- Rename categories, choose Chrome's group colors, enable/disable categories, and add or remove them.
- **Tab-strip position** controls left-to-right display order. **Rule priority** independently controls which category wins.
- Combine label, human feedback, approval, changes-requested, and draft conditions using **all** or **any**. Conditions can also match their absence.
- One fallback category always remains enabled.
- Save edits to apply them. **Restore defaults** resets the category preset; save to apply it.
- Pause, Enable, token updates, and Disconnect work independently of unfinished rule edits. Saving an old category draft cannot undo a pause made from the popup.

The settings UI uses softened Material 2 accents. Chrome controls the exact native tab-group colors.

## Tab behavior

MergeLane tracks github.com PR pages and their subpages, such as files or commits. It deduplicates API checks for multiple tabs of the same PR. Tabs stay in their existing browser windows. Pinned PR tabs stay pinned and ungrouped.

- **Merged:** matching tabs close when the merge is detected and verified.
- **Closed without merging:** matching tabs close only after **more than one hour** since the latest GitHub closure timestamp, verified again before removal.
- **Reopened:** pending cleanup is canceled. Closing again starts a new hour.
- **Failed checks:** tabs stay open and retain their last known group.
- **Loading/navigating tabs:** mutations wait for navigation to settle.

Cleanup includes pinned PR tabs. In the popup's **PRs** view, each PR shows its category and the rule that matched at its last check. Use **Keep open** to protect a PR from automatic closure while allowing grouping to continue.

The **Recently closed** view stores the latest 30 unique PRs automatically closed by MergeLane. **Reopen and keep open** restores or focuses a PR and protects it before the tab opens. The **Kept open** view lists protections, including PRs whose tabs you closed manually. Protections survive worker and browser restarts until you choose **Resume cleanup**, which makes completed PRs eligible to close again. **Clear history** clears recent closures without removing protections. These lists stay local to your Chrome profile.

Reopening an already completed PR through ordinary Chrome history does not add protection; use MergeLane's recovery action or pause management when you want to keep it open.

Checks run about once a minute and when relevant tabs change. Sleeping devices, closed browsers, API rate limits, and network errors can delay updates. **Refresh now** requests a check but still respects GitHub's retry window. Pausing leaves existing groups and tabs in place. Manual reassignment of PR tabs is reapplied by the next successful check.

Groups with unrelated tabs are not reordered. MergeLane does not manage incognito windows, GitHub Enterprise Server, issues, or repository listing pages.

## Permissions and privacy

- `tabGroups`: rename, color, and arrange native groups.
- `storage`: local preferences, credentials, cached normalized PR facts, and per-session ownership.
- `alarms`: background refresh scheduling.
- `https://github.com/*`: identify matching PR tabs without requesting access to every website.
- `https://api.github.com/*`: read PR details and feedback.

No GitHub API writes, remote executable code, hosted service, telemetry, or analytics. A bundled, isolated content script runs only on GitHub's fine-grained token settings pages for assisted import. It cannot read stored extension credentials or invoke the general settings endpoints. Fonts and icons are bundled. Cache entries are bounded per connection and expire after a day without use; comment bodies are not retained.

## Development

Node.js 22 or newer is recommended. The browser target is Chrome 120 or newer.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Load the resulting **`dist/`** directory as an unpacked extension. After rebuilding, click **Reload** on MergeLane's card in `chrome://extensions`.

For the isolated browser integration test:

```sh
npx playwright install chromium
npm run smoke
npm run smoke:import
```

The smoke tests load the actual built extension into temporary Chromium profiles with real native tab APIs and fixture GitHub responses. They do not use real credentials or touch your existing Chrome profile. They exercise connection setup, native grouping, custom categories, cleanup, multiple windows, pinned tabs, pause/resume, worker restart, responsive settings, actual content-script import, multiple owner credentials, and import isolation/cancellation. Screenshots and machine-readable reports are saved under `artifacts/`.

Source layout: `src/core` holds the pure workflow logic, `src/github` the API client, `src/background` the browser lifecycle, and `src/ui` the extension pages. The approved design and mockups are under `docs/`.

## Verification limits

Automated integration uses fixture API responses and token-result pages. Assisted import has also been reported working in a user's live GitHub setup. GitHub's page layout and organization policies may vary; manual paste remains available. MergeLane is distributed through GitHub releases and is not published to the Chrome Web Store.

## Fonts

Roboto is bundled under the SIL Open Font License. See `public/assets/Roboto-OFL.txt`.
