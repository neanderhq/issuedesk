# Issue templates

Admins manage named workspace templates from **Issue templates**. Members can browse them and apply one from **New issue**. Templates copy title, description prompts, priority, labels and an optional project into an editable draft. Status, assignee, due date and estimate remain the reporter's choices.

Applying over changed template fields asks before replacement; **Keep draft** changes nothing. A changed project clears an incompatible milestone. Deleted or archived default references must be repaired by an Admin before application. Changes to a template never update existing issues or already applied drafts. Names are unique within a workspace, ignoring case. Concurrent edits/deletions require the current version and return a conflict without losing draft text.

Templates are stored in PostgreSQL through workspace-scoped routes; only Admins may write them. The additive migration preserves existing data. Form builders, recurring work and sub-issue inheritance are outside this release.
