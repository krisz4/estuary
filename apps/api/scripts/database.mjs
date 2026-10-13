import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, openSync, closeSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { config } from "dotenv";
config({ quiet: true });
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const [mode, first, second] = args;
const verify = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .some((row) => row.integrity_check !== "ok")
    )
      throw new Error("Database integrity check failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("Database has broken foreign keys");
    for (const table of ["Task", "Comment", "Decision", "TaskEvent", "_prisma_migrations"])
      db.prepare(`SELECT COUNT(*) FROM "${table}"`).get();
    return db.prepare("SELECT COUNT(*) AS tasks FROM Task").get().tasks;
  } finally {
    db.close();
  }
};
const configuredPath = () => {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith("file:") || url.includes("?"))
    throw new Error("Set DATABASE_URL to a SQLite file path");
  const path = url.slice(5);
  return resolve(fileURLToPath(new URL("../prisma/", import.meta.url)), path);
};
try {
  if (!["backup", "restore", "verify"].includes(mode) || !first || (mode === "restore" && !second))
    throw new Error(
      "Usage: database.mjs backup OUTPUT | restore BACKUP NEW_DATABASE | verify DATABASE",
    );
  const source = mode === "backup" ? configuredPath() : resolve(first);
  if (!existsSync(source)) throw new Error("Source database does not exist");
  verify(source);
  if (mode === "verify") {
    process.stdout.write(`Verified ${source}: ${verify(source)} tasks\n`);
  } else {
    const target = resolve(mode === "restore" ? second : first);
    if (["", "-wal", "-shm", "-journal"].some((suffix) => existsSync(target + suffix)))
      throw new Error(
        "Destination or SQLite sidecars already exist; choose a new path. Restore never overwrites a live database.",
      );
    closeSync(openSync(target, "wx", 0o600));
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, target);
      process.stdout.write(`Verified ${mode}: ${target} (${verify(target)} tasks)\n`);
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    } finally {
      db.close();
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
