import { mkdir, stat } from "node:fs/promises";
import EmbeddedPostgres from "embedded-postgres";

const databaseDirectory = ".local/embedded-postgres";
await mkdir(".local", { recursive: true });
const database = new EmbeddedPostgres({
  databaseDir: databaseDirectory,
  user: "neander_dev",
  password: "neander_dev_only",
  port: 55432,
  persistent: true,
  autoRehydrateSymlinks: true,
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});

try {
  await stat(`${databaseDirectory}/PG_VERSION`);
} catch {
  await database.initialise();
}

await database.start();
const client = database.getPgClient();
await client.connect();
try {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", ["neander_dev"]);
  if (result.rowCount === 0) await database.createDatabase("neander_dev");
} finally {
  await client.end();
}
console.log("Embedded PostgreSQL is running at 127.0.0.1:55432. Press Ctrl+C to stop it; data is kept in .local/embedded-postgres.");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await database.stop();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise(() => {});
