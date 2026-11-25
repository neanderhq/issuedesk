# Verification

Run `pnpm verify` after [development setup](development.md). This preserves the
existing app tests and build, and adds the common repository policy check.
TypeScript is the existing static gate; this migration does not introduce a new lint ruleset.

## CI gates

- **policy** checks repository identity/files, runtime pins, immutable action pins,
  read-only permissions and the production verification entry point.
- **app** runs the source checks and existing app-specific assertions.
- **Runtime security** (the `production` job) builds the real Docker image,
  scans it with checksum-verified Trivy, initializes a disposable PostgreSQL
  service and runs `pnpm test:production`. The alias preserves `test:template`.
- **Dependency audit**, **Dependency review** and GitHub CodeQL remain required.
  Runtime and dependency scans also run daily. Existing additional deployment
  checks remain in their separate workflow where present.

## Production smoke coverage

Seeded issues/project/board, login, edit/status changes, seed preservation and restart persistence.

CI supplies only fictional credentials and an isolated local PostgreSQL service.
`DATABASE_URL` and `NEANDER_TEMPLATE_TEST_DATABASE_URL` must identify the same
explicitly disposable database. Build the image and apply the existing recipe's
migration/seed commands before invoking the smoke suite. `.github/workflows/check.yml`
is the executable setup reference; test credentials there are CI fixtures.
The suite starts/stops its own local app container and writes synthetic records.
Never copy these commands onto an existing customer database.

Passing this CI establishes the assertions in the existing suites, not complete
product acceptance, physical-device/mobile coverage, managed Neon/Cloud Run
deployment, real email delivery or the desktop Neander Publish path. Keep the
README's product-specific limitations. Add regression tests for behavior changes;
do not replace real app checks with boilerplate-only assertions.

## Issue experience regression

The built-image suite also runs `scripts/test-issue-experience.mjs` against its
existing disposable app/database. It verifies keyboard issue creation and focus
return, visible title focus, associated empty-title validation without changing
the saved record, corrected title persistence, one page heading, measured 375px
layouts and phone navigation. Its own fictional issue is archived afterward.

For an already running local production build, supply `DATABASE_URL`, the equal
`NEANDER_TEMPLATE_TEST_DATABASE_URL`, `BETTER_AUTH_URL` and `DEMO_OWNER_PASSWORD`,
then run `node scripts/test-issue-experience.mjs "$BETTER_AUTH_URL"`. The script
requires a loopback origin and an explicitly disposable database. Set
`NEANDER_ISSUE_EXPERIENCE_EVIDENCE` to a local ignored directory for screenshots.
This local route does not replace Docker-image verification.

## Workspace change-cursor regression

The production verifier runs `scripts/test-workspace-cursors.mjs` against its
migrated disposable PostgreSQL database. It checks that issue and label changes
still advance the right workspace cursor, issue deletion preserves change
notifications, and deleting a workspace cascades without recreating a cursor for
the removed parent. An unrelated workspace stays intact. All fixtures roll back.

For a local disposable database with equal `DATABASE_URL` and
`NEANDER_TEMPLATE_TEST_DATABASE_URL`, run:

```sh
node --env-file=.env.local scripts/test-workspace-cursors.mjs
```

## Selected feature workflows

On a disposable migrated/seeded database and a running production build,
`pnpm test:features` checks template and project-update persistence, invalid input,
optimistic conflicts, author/Admin boundaries and workspace isolation.
`pnpm test:feature-ui` exercises those workflows in Chromium at desktop and 375px,
including replacement confirmation, preserved drafts and keyboard focus.

`pnpm test:github-runtime` starts the real standalone production server twice:
first Unconfigured, then with disposable App credentials and a controlled local
HTTP provider. Stop any existing server at BETTER_AUTH_URL first. The preload under
`scripts/testing/` changes only the test process's GitHub fetch transport; the
application uses the maintained Octokit SDK and normal GitHub endpoints. The fixture
verifies signed App JWTs, installation-token scope and read-only provider requests.
Tests cover raw webhook signatures, immutable repository authority, delivery replay,
ordering, terminal merge state, opt-in/once-only completion, archive/revocation,
roles/tenants, invalid input, phone/keyboard recovery, seed retry and process restart.
Set `ISSUEDESK_FEATURE_EVIDENCE` to an ignored output directory for original fictional
browser captures. No live GitHub installation or external writes are required.

`pnpm test:production` includes the feature API/browser and restart checks in the
built Docker image. It checks Unconfigured before injecting the controlled provider,
then runs the existing core/seed/restart/phone checks unchanged. Controlled-provider
success does not establish real GitHub installation or live webhook delivery; those
require the operator configuration described in `docs/github-integration.md`.
