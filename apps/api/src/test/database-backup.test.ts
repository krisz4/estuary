import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
// The CLI runs on Node >=22.18; the repository's Node type baseline predates sqlite.
// @ts-expect-error node:sqlite is available in the required runtime
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("backs up uncheckpointed WAL data, restores it, and refuses an existing destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "estuary-backup-"));
  const source = join(dir, "source.db");
  const snapshot = join(dir, "snapshot.db");
  const restored = join(dir, "restored.db");
  copyFileSync(process.env.DATABASE_URL!.slice(5), source);
  const writer = new DatabaseSync(source);
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("scripts/database.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: `file:${source}` },
    });
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer
      .prepare("INSERT INTO Task (title, description, createdBy, updatedAt) VALUES (?, ?, ?, ?)")
      .run("WAL-only task", "Persist the active journal", "human:test", Date.now());
    expect(statSync(`${source}-wal`).size).toBeGreaterThan(0);
    const result = cli(["backup", snapshot]);
    expect(result.status, result.stderr).toBe(0);
    expect(cli(["verify", snapshot]).status).toBe(0);
    expect(cli(["restore", snapshot, restored]).status).toBe(0);
    const read = new DatabaseSync(restored, { readOnly: true });
    try {
      expect(read.prepare("SELECT title FROM Task").get().title).toBe("WAL-only task");
    } finally {
      read.close();
    }
    expect(cli(["restore", snapshot, restored]).status).toBe(1);
    expect(cli(["backup", source]).status).toBe(1);
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
