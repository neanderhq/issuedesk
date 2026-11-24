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
