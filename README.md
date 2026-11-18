# Linear Template — IssueDesk

IssueDesk is a Linear-style team issue tracker built by Ibrahim on Neander.
The template library calls it **Linear Template**; the app itself uses **IssueDesk**.
Includes boards,
lists, projects, milestones, cycles, issue dependencies, comments and team roles.

Imported from Neander project `proj_3341ac65c8a8` at its published commit
`2ed315bc782a371b336b8879561b661b651d7615`. The original project and live
application are unchanged. This repository contains code and fictional sample
data, not production user records.

## Run locally

Use the Node and pnpm versions in `mise.toml`. Set `DATABASE_URL` to a disposable
PostgreSQL database, `BETTER_AUTH_URL` to the app origin and `BETTER_AUTH_SECRET`
to a random secret in ignored `.env.local`.

```sh
pnpm install --frozen-lockfile
node --env-file=.env.local .neander/migrate.mjs
node --env-file=.env.local .neander/seed.mjs
pnpm dev
```

The seed also requires `DEMO_OWNER_PASSWORD` (at least 12 characters). Sign in
as `maya.chen@example.invalid` using that password. In Neander the password is
generated for each deployment and available in its application environment.
The seed creates a fictional Product Launch project with 20 issues, five labels,
three milestones and three cycles. Re-running it preserves edits and passwords.
The original invitation-only registration flow and 10-member workspace remain.

## Verify and publish

`pnpm check` typechecks; `pnpm test` checks the deployment recipe and entrypoint.
The shared Template workflow builds the Linux image, migrates a disposable
PostgreSQL database, seeds it, then verifies browser login, populated issues,
persistent edits and restart behavior. Its screenshot is the template thumbnail.

PRs verify only. Successful main pushes publish tested images to Artifact Registry,
release records to the private template bucket and the thumbnail to the public
assets bucket, then update `catalog/linear.json`. Source stays on GitHub at the
registered commit; no source archive is uploaded. The standard Neander Use
Template and Publish flows consume that registration.
