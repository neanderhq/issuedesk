# GitHub pull requests

An operator configures one GitHub App installation/repository for this IssueDesk
server. A workspace Admin verifies that installation and explicitly agrees that
all workspace members can see linked PR titles, states, URLs and target branches.
Members can then link one PR per issue, refresh, opt in/out of completion, or unlink.
The same PR may support several issues. This integration never writes to GitHub.

## Configuration

Supply these optional server-only variables together through the existing secret
bundle. With any missing/invalid value, settings visibly remain Unconfigured.

- `GITHUB_APP_ID`: GitHub App ID.
- `GITHUB_APP_PRIVATE_KEY`: PEM private key; use literal `\n` escapes in a one-line
  bundle value. Do not put it in source, a browser form or client environment.
- `GITHUB_INSTALLATION_ID`: positive numeric installation ID.
- `GITHUB_REPOSITORY`: exact `owner/repo` allowlist.
- `GITHUB_WEBHOOK_SECRET`: a separate random secret shared with GitHub.

The App needs read access to **Pull requests** and **Metadata**, installed on that
repository. Subscribe to `pull_request`; installation and repository access events
also invalidate the binding. Set its webhook to the reachable HTTPS URL
`<IssueDesk origin>/api/integrations/github/webhook`, using JSON and the matching
secret. Local verification uses a controlled HTTP provider with disposable keys;
real GitHub delivery requires operator configuration and reachable HTTPS. Selecting
a repository alone does not install or authorize an App. Existing connector/CLI
credentials are never borrowed. Credential rotation requires a runtime restart.
Octokit's installation-token cache refreshes expiring tokens in the server process.

## Completion and recovery

A URL is fetched from GitHub before it can become a verified link. Open, Draft,
Closed and Merged remain distinct; closing without merge never completes an issue.
Completion defaults off. Enabling it for an already merged PR explicitly completes
an active issue now. A PR merged into **any target branch** can complete the issue;
this does not claim a deployment or release. Each link applies completion once;
later manual status changes are respected. Archived issues are not completed.
Activity and follower notifications attribute automatic completion to GitHub.

Raw webhook signatures are verified before JSON is parsed. The installation and
immutable repository/PR identities bound by the server determine the workspace.
Transactions serialize connection/link changes; delivery IDs and payload hashes
handle replay/collisions. Older events cannot regress the last provider timestamp,
and Merged is terminal. No workspace or human identity is trusted from a payload.

Provider failures retain last verified data and ordinary issue editing. Stale
connections may retry a member refresh; revoked/configuration-changed connections
need Admin verification. Invalid URLs/unknown PRs preserve the form input. Unlinking
stops future automation without reverting the issue status or deleting audit history.
Disconnect disables every opt-in. Reconnecting after revocation/disconnection
retires old links; members must deliberately link and opt in again.

No diffs/reviews, GitHub issues, branch keyword automation, outbound writes, multiple
provider adapters, OAuth enrollment or background worker are included in this slice.
