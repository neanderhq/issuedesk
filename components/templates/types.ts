export type IssueTemplate = {
  id: string; name: string; title: string; description: string;
  priority: "No priority" | "Urgent" | "High" | "Medium" | "Low";
  projectId: string | null; labelIds: string[]; version: number; defaultsError?: string | null;
};
