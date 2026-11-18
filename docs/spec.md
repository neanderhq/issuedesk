# Team Tracker: Linear-style project and issue tracker with cycles

One shared workspace for a team of up to 10 people. Real users, persistent PostgreSQL data, no mock data, no browser-only storage. Original design inspired by Linear's density and clarity; do not copy Linear's logo, name or assets.

## Stack and rules
- Keep the starter's stack: Next.js App Router, TypeScript, API route handlers, Drizzle + PostgreSQL with versioned migrations, Better Auth with email + password through the Neander Better Auth block, Tailwind + shadcn/ui components and lucide icons. No hand-written global CSS beyond tokens; no hard-coded colors outside the theme.
- Every API route: session required (401 when signed out), active workspace membership required (403/404 otherwise), role checked on the server, input validated with zod (400 with a clear message, never 500), ids validated before queries, errors logged with console.error.
- Every non-GET request: Origin must match the app origin (403), JSON content type required except the upload routes (415), body size limits (64 KB JSON, 5 MB uploads) (413).
- Production only: CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy; poweredByHeader false. Do not apply CSP in development.
- Passwords: minimum 12 characters. Names max 120 characters. Login rate limiting must read the client IP from x-forwarded-for.
- Dates are stored in UTC and formatted with one fixed format on server and client (no hydration mismatches). Drag and drop contexts use stable ids.
- Every list, card and form must work at 375 px wide with no horizontal page scroll. Hidden labels must not escape their containers.

## Accounts and team
- The first account created on an empty database creates the workspace and becomes Admin. After that, sign up is possible ONLY through a valid invitation. /signup without a valid token is rejected by the server.
- Roles: Admin and Member. Admins invite and remove members, change roles, and edit workspace settings (name, issue key prefix). Members cannot. The last Admin cannot be removed or demoted.
- Invitations: Admin enters email + role; the server creates a single-use token (stored hashed, expires in 7 days) and shows a copyable invite link (nothing is emailed). Pending invitations can be revoked. Active members + pending invitations is capped at 10.
- Removing a member: membership is deactivated, all their sessions are revoked immediately, every later request from them gets 401/403, their open issues become unassigned (with an activity entry), their past comments and history stay and show their name with "(removed)".
- Password recovery: "Forgot password" on the login page records a reset request. Admins see pending requests in Settings > Members and generate a one-time reset link (valid 1 hour) to share with that member; Admins can also generate a reset link for any member at any time. Signed-in users can change their own password (their other sessions are revoked).
- Log in, log out, expired session: an expired or revoked session sends the user to /login?expired=1 with a message.

## Issues
- Unique identifier: workspace key prefix + sequential number (for example TT-42), allocated atomically, never reused.
- Fields: title (1 to 200 chars, required), description (Markdown, rendered sanitized, max 20,000 chars), status, priority (No priority, Urgent, High, Medium, Low), assignee (an active member or nobody), labels (many; create/edit/delete labels with a color), due date, estimate (integer points 0 to 100 or empty), project, milestone (of that project), cycle, parent issue.
- Workflow statuses in this order: Backlog, Todo, In Progress, In Review, Done.
- Sub-issues: an issue can have sub-issues (one level); the parent shows sub-issue progress.
- Blocking dependencies: "A blocks B". No self-reference, no duplicates, no circular chains (server rejects them). An issue is Blocked while any blocker is not Done and not archived; show a Blocked badge.
- Comments: Markdown, edit/delete own comment (Admins may delete any). @mentions through a member picker, stored as user ids.
- Attachments: files on an issue. Allowed: png, jpg, gif, webp, pdf, txt, md, csv, json, docx, xlsx. Max 5 MB each, max 10 per issue. Check the real file type, reject SVG/HTML/executables. Stored in PostgreSQL. Download ONLY through an authenticated API route that checks workspace membership; no public URLs; Content-Disposition attachment (inline only for images); nosniff.
- Activity history on every issue: who changed what, from which value to which value, and when, for every field, comment, attachment, relation, cycle change, archive and restore.
- Followers: creator, assignee, commenters and mentioned users follow automatically; Follow/Unfollow button.
- Archive and restore: archived issues leave every view and search, appear in an Archive view, and restore with all details, comments, attachments and history intact.

## Views (all read the same API and the same data)
- Backlog, Board (five status columns), compact List (grouped by status), My Issues (assigned to me).
- Board: drag issues between statuses, reorder inside a status, drop into an empty column. Order is saved on the server and survives refresh. The server computes positions from "move issue X before/after issue Y in status S" inside a transaction; the client never sends absolute indexes.
- Bulk update in list views: select many issues, then set status, priority, assignee, labels, project, cycle, or archive.
- Mobile alternatives: every issue has a "Move to" action (status + top/bottom/up/down) and bulk actions work by tap; the board scrolls sideways with snap.
- Search by identifier, title and description (case-insensitive). Filters, combinable: project, status, priority, assignee, label, cycle. Clear empty state with "Clear filters".
- Saved views: name + filters + layout, private or shared with the workspace; create, rename, update, delete.

## Projects
- Create, edit, archive and restore projects: name, description, project lead (a member), start and target dates, milestones (name, target date, order).
- Progress is computed from the underlying non-archived issues: done / total, by count and by estimate points, for the project and per milestone. Never stored as a hand-edited number.
- Seed once, when the workspace is created: a sample project "Product Launch" with 3 milestones, about 20 realistic issues across all statuses and priorities, labels, due dates (some overdue), estimates, 2 parent issues with sub-issues, 2 blocking dependencies, one completed cycle, one active cycle and one upcoming cycle. If the sample data is deleted it must not come back.

## Cycles (sprints)
- Fields: name (default "Cycle N"), goal, start date, end date. Default length two weeks, dates editable, no overlapping cycles.
- States: Upcoming, Active, Completed. At most one Active cycle (enforced in the database). "Start cycle" and "Close cycle" actions.
- Planning: add issues to a cycle from the backlog or from any project (single and bulk); move issues between cycles; remove from a cycle.
- Cycle page: scope, completed, remaining and blocked work, by issue count and by estimate points, plus a breakdown per assignee. Unestimated issues count as 0 points and are shown as "n unestimated".
- Cycle-filtered board and list views.
- After a cycle has started, every addition and removal is recorded (who, when, which issue) and shown as "Scope changes".
- Closing a cycle: it becomes Completed and read-only; a snapshot keeps which issues were completed and which were not; unfinished issues are carried into the next upcoming cycle (created if missing) or sent back to the backlog, by choice. The completed cycle's page still lists them as "carried over". History of previous cycles is never lost.

## Collaboration and data
- Live updates without manual refresh: a database-backed change cursor per workspace that clients poll every 3 seconds (paused when the tab is hidden), refetching what changed. It must work across several server instances; no in-memory state.
- Conflicting edits must never silently overwrite. Every issue, comment, project and cycle has a version number. Updates send only the changed fields plus the version they were based on. On a mismatch the server returns 409 with the current record. The client re-applies automatically when the fields the user changed were not changed by the other person; otherwise it shows "Someone else changed this", keeps the user's text and lets them choose.
- Notification inbox: notifications for being assigned, being @mentioned, and activity on followed issues (never for your own actions). Unread badge, mark read/unread, mark all read, click opens the issue.
- CSV export of issues (all or the current filter). Cells starting with = + - @ are escaped.
- CSV import: max 1 MB and 500 rows. Validate every row (required title, valid status/priority, assignee email must be an active member, YYYY-MM-DD dates, numeric estimate, existing project). Show a preview with errors per row and column, then import the valid rows and report the skipped ones. Unknown labels are created.

## Edge cases that must behave well
Empty workspace sections and empty columns, very long titles and descriptions without spaces, missing titles, overdue dates shown in red, invalid ids, expired sessions, network errors (message + rollback, no silent loss), two people editing or dragging the same issue.

## Out of scope
GitHub or other integrations, AI agents, SSO, native apps, advanced analytics, roadmap/timeline views.

## Phases
1. Auth, workspace, roles, invitations, password recovery, security baseline, app shell.
2. Database schema and API for labels, projects, milestones, issues, relations, comments, activity; sample data.
3. Issue list views (Backlog, List, My Issues) and the issue detail page.
4. Board with drag and drop, saved ordering, bulk updates, mobile "Move to".
5. Search, filters, saved views, archive and restore.
6. Projects and milestones with computed progress.
7. Cycles: planning, active cycle stats, scope changes, close and carry over.
8. Live updates, conflict handling, notification inbox.
9. Attachments, CSV import and export.
10. Security and mobile pass, production build, publish.
