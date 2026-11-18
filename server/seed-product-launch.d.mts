import type { SQL } from "drizzle-orm";

type QueryResult = { rows: unknown[] };
type SeedExecutor =
  | { execute: (query: SQL) => Promise<QueryResult> }
  | { query: (text: string, parameters: unknown[]) => Promise<QueryResult> };

export function seedProductLaunch(executor: SeedExecutor, workspaceId: string, creatorId: string): Promise<boolean>;
