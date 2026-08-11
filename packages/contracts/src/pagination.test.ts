import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  buildPaginationMeta,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginatedSchema,
  paginationMetaSchema,
} from "./pagination.js";

describe("pagination defaults", () => {
  it("pins the documented defaults and bounds", () => {
    expect(DEFAULT_PAGE).toBe(1);
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});

describe("buildPaginationMeta", () => {
  it("computes the envelope for a middle page", () => {
    expect(buildPaginationMeta({ page: 2, pageSize: 20, total: 63 })).toEqual({
      page: 2,
      pageSize: 20,
      total: 63,
      totalPages: 4,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });

  it("reports one page for an empty result so the pager never renders 'Page 1 of 0'", () => {
    const meta = buildPaginationMeta({ page: 1, pageSize: 20, total: 0 });
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPrevPage).toBe(false);
  });

  it("reports hasNextPage false on a page beyond the end", () => {
    const meta = buildPaginationMeta({ page: 9, pageSize: 20, total: 63 });
    expect(meta.totalPages).toBe(4);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPrevPage).toBe(true);
  });

  it("does not round a partial last page down", () => {
    expect(buildPaginationMeta({ page: 1, pageSize: 20, total: 21 }).totalPages).toBe(2);
  });

  it("produces meta that satisfies paginationMetaSchema", () => {
    expect(
      paginationMetaSchema.safeParse(buildPaginationMeta({ page: 1, pageSize: 20, total: 63 }))
        .success,
    ).toBe(true);
  });
});

describe("paginatedSchema", () => {
  const schema = paginatedSchema(z.object({ id: z.number() }).strict());

  it("validates { data, meta } together", () => {
    const payload = {
      data: [{ id: 1 }],
      meta: buildPaginationMeta({ page: 1, pageSize: 20, total: 1 }),
    };
    expect(schema.parse(payload)).toEqual(payload);
  });

  it("rejects a bare array — list responses are always enveloped", () => {
    expect(schema.safeParse([{ id: 1 }]).success).toBe(false);
  });
});
