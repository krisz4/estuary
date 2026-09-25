import { taskSchema, type Task } from "@helpdesk/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { FetchLike } from "../api-client.js";
import type { Config } from "../config.js";
import { createServer } from "../server.js";

/**
 * Drives the real `McpServer` — schemas, SDK validation, handlers — through an
 * in-memory MCP client, with `fetch` swapped for a recorder. A test states what
 * the API answers and asserts on what the server asked for and what the model
 * would read back.
 */

export interface RecordedRequest {
  method: string;
  /** Path after the base URL, without the query string: `/tasks/42/transition`. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Sent verbatim instead of JSON — for proxies answering with HTML. */
  raw?: string;
}

export type Responder = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export const TEST_API_URL = "http://api.test/api/v1";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  apiUrl: TEST_API_URL,
  actor: "agent:test-bot",
  token: undefined,
  defaultProject: undefined,
  ...overrides,
});

export const createFakeFetch = (responder: Responder) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      path: url.pathname.replace(new URL(TEST_API_URL).pathname, ""),
      query: url.searchParams,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const reply = await responder(request);
    const payload = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(payload, { status: reply.status });
  };
  return { fetchImpl, requests };
};

export const connect = async (responder: Responder, config: Partial<Config> = {}) => {
  const fake = createFakeFetch(responder);
  const server = createServer(testConfig(config), fake.fetchImpl);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content.map((part) => part.text).join("\n"), isError: result.isError === true };
  };

  return { client, call, requests: fake.requests, close: () => client.close() };
};

/* ------------------------------------------------------------------ *
 * Fixtures — parsed through the contract, so a fixture that drifts from the
 * real response shape fails loudly instead of testing a shape the API never sends.
 * ------------------------------------------------------------------ */

export const makeTask = (overrides: Partial<Task> = {}): Task =>
  taskSchema.parse({
    id: 42,
    reference: "TASK-000042",
    title: "Fix the login redirect",
    description: "Users land on a blank page after signing in.",
    status: "backlog",
    statusNote: null,
    priority: "medium",
    project: "helpdesk",
    assignee: null,
    acceptanceCriteria: null,
    links: [],
    parentId: null,
    createdBy: "agent:test-bot",
    claim: null,
    version: 1,
    openDependencyCount: 0,
    openDecision: null,
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    commentCount: 0,
    comments: [],
    decisions: [],
    parent: null,
    children: [],
    dependencies: [],
    dependents: [],
    ...overrides,
  });

export const apiError = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): FakeResponse => ({
  status,
  body: {
    error: { code, message, ...(details === undefined ? {} : { details }), requestId: "req-1" },
  },
});
