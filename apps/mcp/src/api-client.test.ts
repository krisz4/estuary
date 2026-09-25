import { describe, expect, it } from "vitest";

import { toQueryString } from "./api-client.js";

describe("toQueryString", () => {
  it("repeats array keys, stringifies scalars, and drops undefined", () => {
    expect(
      toQueryString({ status: ["todo", "blocked"], page: 2, assigneeIsNull: true, q: undefined }),
    ).toBe("?status=todo&status=blocked&page=2&assigneeIsNull=true");
  });

  it("is empty when nothing is left", () => {
    expect(toQueryString(undefined)).toBe("");
    expect(toQueryString({ q: undefined })).toBe("");
  });
});
