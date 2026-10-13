import { describe, expect, it } from "vitest";

import { ApiClient, toQueryString } from "./api-client.js";

it("separates same-actor processes and can resume an explicit session", () => {
  const config = { apiUrl: "http://localhost:4000/api/v1", actor: "agent:codex", token: undefined };
  const first = new ApiClient(config);
  const second = new ApiClient(config);
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(new ApiClient({ ...config, sessionId: first.sessionId }).sessionId).toBe(first.sessionId);
});

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
