import { sql } from "drizzle-orm";

const seedKey = "product-launch-v1";
const issueSeed = [
  { title: "Approve launch positioning and messaging", status: "Todo", priority: "High", milestone: 0, cycle: 1, labels: ["Launch", "Design"], due: 3, estimate: 3, parent: null, assigned: true },
  { title: "Complete production launch readiness", status: "In Progress", priority: "High", milestone: 1, cycle: 1, labels: ["Backend", "Launch"], due: 8, estimate: 5, parent: null, assigned: true },
  { title: "Draft product positioning", status: "Done", priority: "Medium", milestone: 0, cycle: 0, labels: ["Research", "Design"], due: -20, estimate: 2, parent: 0, assigned: false },
  { title: "Review the launch announcement", status: "Todo", priority: "Low", milestone: 2, cycle: 2, labels: ["Launch"], due: 12, estimate: 1, parent: 0, assigned: true },
  { title: "Configure production monitoring", status: "In Review", priority: "High", milestone: 1, cycle: 1, labels: ["Backend"], due: -2, estimate: 3, parent: 1, assigned: true },
  { title: "Validate the rollback plan", status: "Backlog", priority: "Medium", milestone: 1, cycle: null, labels: ["Backend"], due: 16, estimate: 2, parent: 1, assigned: false },
  { title: "Prototype the public landing page", status: "Done", priority: "High", milestone: 0, cycle: 0, labels: ["Design"], due: -12, estimate: 5, parent: null, assigned: true },
  { title: "Build the public landing page", status: "In Progress", priority: "High", milestone: 2, cycle: 1, labels: ["Design", "Launch"], due: 10, estimate: 5, parent: null, assigned: true },
  { title: "Review landing page accessibility", status: "Todo", priority: "High", milestone: 2, cycle: 2, labels: ["Design"], due: 14, estimate: 3, parent: null, assigned: false },
  { title: "Test the page performance budget", status: "Backlog", priority: "Medium", milestone: 2, cycle: null, labels: ["Backend"], due: 20, estimate: 3, parent: null, assigned: false },
  { title: "Summarize private beta feedback", status: "Done", priority: "Medium", milestone: 0, cycle: 0, labels: ["Research"], due: -8, estimate: 2, parent: null, assigned: true },
  { title: "Resolve onboarding friction from beta", status: "In Progress", priority: "Urgent", milestone: 1, cycle: 1, labels: ["Research", "Launch"], due: -1, estimate: 5, parent: null, assigned: true },
  { title: "Review data retention requirements", status: "In Review", priority: "Medium", milestone: 1, cycle: 1, labels: ["Backend", "Research"], due: 7, estimate: 2, parent: null, assigned: false },
  { title: "Invite the first private beta cohort", status: "Todo", priority: "Low", milestone: 0, cycle: 2, labels: ["Launch"], due: 15, estimate: 1, parent: null, assigned: true },
  { title: "Run the billing smoke test", status: "Backlog", priority: "Urgent", milestone: 1, cycle: null, labels: ["Backend", "Bug"], due: 4, estimate: 3, parent: null, assigned: false },
  { title: "Finalize the release checklist", status: "Todo", priority: "Medium", milestone: 2, cycle: 2, labels: ["Launch"], due: 18, estimate: 2, parent: null, assigned: true },
  { title: "Fix mobile navigation spacing", status: "Done", priority: "Low", milestone: 0, cycle: 0, labels: ["Design", "Bug"], due: -6, estimate: 1, parent: null, assigned: false },
  { title: "Add product analytics events", status: "In Progress", priority: "Medium", milestone: 1, cycle: 1, labels: ["Backend"], due: 11, estimate: 3, parent: null, assigned: true },
  { title: "Prepare customer support response macros", status: "Backlog", priority: "Low", milestone: 2, cycle: null, labels: ["Launch"], due: 24, estimate: 2, parent: null, assigned: false },
  { title: "Create the launch retrospective template", status: "Todo", priority: "No priority", milestone: 2, cycle: 2, labels: ["Research"], due: 28, estimate: null, parent: null, assigned: false },
];

function drizzlize(text, parameters) {
  const chunks = [];
  const parameterPattern = /\$(\d+)/g;
  let offset = 0;
  for (const match of text.matchAll(parameterPattern)) {
    const position = match.index;
    chunks.push(sql.raw(text.slice(offset, position)), parameters[Number(match[1]) - 1]);
    offset = position + match[0].length;
  }
  chunks.push(sql.raw(text.slice(offset)));
  return sql.join(chunks);
}

async function query(executor, text, parameters = []) {
  if (typeof executor.query === "function") return executor.query(text, parameters);
  return executor.execute(drizzlize(text, parameters));
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function seedProductLaunch(executor, workspaceId, creatorId) {
  const claim = await query(executor,
    "INSERT INTO workspace_seed_state (workspace_id, seed_key) VALUES ($1, $2) ON CONFLICT (workspace_id, seed_key) DO NOTHING RETURNING id",
    [workspaceId, seedKey]);
  if (!claim.rows.length) return false;

  const projectId = crypto.randomUUID();
  await query(executor,
    "INSERT INTO projects (id, workspace_id, name, description, lead_user_id, start_date, target_date) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [projectId, workspaceId, "Product Launch", "Plan and deliver the next product launch, from private beta feedback through public release.", creatorId, dateOffset(-28), dateOffset(28)]);

  const milestoneNames = ["Foundation", "Private Beta", "Public Launch"];
  const milestoneIds = [];
  for (let index = 0; index < milestoneNames.length; index += 1) {
    const id = crypto.randomUUID();
    milestoneIds.push(id);
    await query(executor,
      "INSERT INTO milestones (id, workspace_id, project_id, name, target_date, position) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, workspaceId, projectId, milestoneNames[index], dateOffset([ -14, 7, 28 ][index]), index * 100]);
  }

  const labelNames = ["Bug", "Design", "Backend", "Launch", "Research"];
  const labelColors = ["#d97777", "#a78bfa", "#60a5fa", "#34d399", "#fbbf24"];
  const labelIds = new Map();
  for (let index = 0; index < labelNames.length; index += 1) {
    const id = crypto.randomUUID();
    labelIds.set(labelNames[index], id);
    await query(executor,
      "INSERT INTO labels (id, workspace_id, name, color) VALUES ($1, $2, $3, $4)",
      [id, workspaceId, labelNames[index], labelColors[index]]);
  }

  const cycleDefinitions = [
    { name: "Cycle 1", status: "Completed", start: -35, end: -22, goal: "Incorporate early research and prepare the beta experience." },
    { name: "Cycle 2", status: "Active", start: -7, end: 6, goal: "Complete launch readiness and address beta feedback." },
    { name: "Cycle 3", status: "Upcoming", start: 7, end: 20, goal: "Finish public launch preparation." },
  ];
  const cycleIds = [];
  for (const cycle of cycleDefinitions) {
    const id = crypto.randomUUID();
    cycleIds.push(id);
    await query(executor,
      "INSERT INTO cycles (id, workspace_id, name, goal, status, start_date, end_date) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, workspaceId, cycle.name, cycle.goal, cycle.status, dateOffset(cycle.start), dateOffset(cycle.end)]);
  }

  await query(executor,
    "INSERT INTO issue_number_counters (workspace_id, next_number) SELECT $1, COALESCE(MAX(issue_number), 0) + 1 FROM issues WHERE workspace_id = $1 ON CONFLICT (workspace_id) DO NOTHING",
    [workspaceId]);
  const [counter] = (await query(executor,
    "UPDATE issue_number_counters SET next_number = next_number + $2 WHERE workspace_id = $1 RETURNING next_number",
    [workspaceId, issueSeed.length])).rows;
  const firstNumber = counter.next_number - issueSeed.length;
  const issueIds = issueSeed.map(() => crypto.randomUUID());
  const statusPositions = new Map();

  for (let index = 0; index < issueSeed.length; index += 1) {
    const issue = issueSeed[index];
    const position = statusPositions.get(issue.status) ?? 0;
    statusPositions.set(issue.status, position + 100);
    const cycleId = issue.cycle === null ? null : cycleIds[issue.cycle];
    await query(executor,
      "INSERT INTO issues (id, workspace_id, issue_number, title, description, status, priority, assignee_id, creator_id, due_date, estimate, project_id, milestone_id, cycle_id, parent_issue_id, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
      [issueIds[index], workspaceId, firstNumber + index, issue.title, "", issue.status, issue.priority, issue.assigned ? creatorId : null, creatorId, dateOffset(issue.due), issue.estimate, projectId, milestoneIds[issue.milestone], cycleId, issue.parent === null ? null : issueIds[issue.parent], position]);
    await query(executor,
      "INSERT INTO issue_followers (issue_id, user_id) VALUES ($1, $2) ON CONFLICT (issue_id, user_id) DO NOTHING",
      [issueIds[index], creatorId]);
    await query(executor,
      "INSERT INTO activity (workspace_id, issue_id, actor_id, action, next_value) VALUES ($1, $2, $3, 'created', $4::jsonb)",
      [workspaceId, issueIds[index], creatorId, JSON.stringify({ title: issue.title })]);
    for (const labelName of issue.labels) {
      await query(executor,
        "INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2) ON CONFLICT (issue_id, label_id) DO NOTHING",
        [issueIds[index], labelIds.get(labelName)]);
    }
    if (cycleId) {
      await query(executor,
        "INSERT INTO cycle_membership_history (workspace_id, cycle_id, issue_id, action, actor_id) VALUES ($1, $2, $3, 'added', $4)",
        [workspaceId, cycleId, issueIds[index], creatorId]);
      if (issue.cycle === 1) {
        await query(executor,
          "INSERT INTO cycle_scope_events (workspace_id, cycle_id, issue_id, action, actor_id) VALUES ($1, $2, $3, 'added', $4)",
          [workspaceId, cycleId, issueIds[index], creatorId]);
      }
    }
  }

  for (const [blockerIndex, blockedIndex] of [[1, 14], [7, 15]]) {
    await query(executor,
      "INSERT INTO issue_relations (workspace_id, blocker_issue_id, blocked_issue_id, created_by_id) VALUES ($1, $2, $3, $4)",
      [workspaceId, issueIds[blockerIndex], issueIds[blockedIndex], creatorId]);
  }
  return true;
}
