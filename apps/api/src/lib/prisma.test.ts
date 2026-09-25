import { describe, expect, it } from "vitest";

import { makeTask } from "../test/factories.js";
import { prisma, writeTransaction } from "./prisma.js";

/**
 * The in-process write queue (`docs/engineering/DATABASE.md` § Concurrent
 * writes). Its two promises: interactive write transactions never overlap, and
 * one that fails does not wedge the ones behind it.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("writeTransaction", () => {
  it("keeps working after a transaction rejects, and rolls the rejected one back", async () => {
    const failed = writeTransaction(async (tx) => {
      await tx.task.create({
        data: { title: "Rolled back", description: "Never committed", createdBy: "human:t" },
      });
      throw new Error("boom");
    });
    const after = writeTransaction((tx) => tx.task.count());

    await expect(failed).rejects.toThrow("boom");
    expect(await after).toBe(0);

    // And the queue is still usable for a real write afterwards.
    const created = await writeTransaction((tx) =>
      tx.task.create({
        data: { title: "Committed", description: "Written after a failure", createdBy: "human:t" },
      }),
    );
    expect(await prisma.task.count()).toBe(1);
    expect(created.title).toBe("Committed");
  });

  it("runs queued transactions one at a time, in submission order", async () => {
    const log: string[] = [];
    const step = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };

    await Promise.all([
      writeTransaction(step("a")),
      writeTransaction(step("b")),
      writeTransaction(step("c")),
    ]);

    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("returns the transaction's value", async () => {
    const task = await makeTask();

    expect(
      await writeTransaction((tx) => tx.task.findUnique({ where: { id: task.id } })),
    ).toMatchObject({ id: task.id });
  });
});
