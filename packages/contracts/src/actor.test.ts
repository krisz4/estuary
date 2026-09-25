import { describe, expect, it } from "vitest";
import {
  ACTOR_NAME_MAX,
  actorKindOf,
  actorNameOf,
  actorSchema,
  ANONYMOUS_ACTOR,
  slugifyActorName,
  storedActorSchema,
  SYSTEM_ACTOR,
} from "./actor.js";

describe("actorSchema", () => {
  it.each(["agent:claude-code", "human:krisz", "human:a.b_c@d/e-f", "agent:7"])(
    "accepts %s unchanged",
    (actor) => {
      expect(actorSchema.parse(actor)).toBe(actor);
    },
  );

  it("trims and lowercases in the schema, not the service", () => {
    // `createdBy` is an exact-match filter and SQLite's `equals` is
    // case-sensitive: `Agent:Claude-Code` must not become a second actor.
    expect(actorSchema.parse("  Agent:Claude-Code ")).toBe("agent:claude-code");
  });

  it("rejects system: from the wire — it is reserved for the server's own writes", () => {
    expect(actorSchema.safeParse(SYSTEM_ACTOR).success).toBe(false);
    expect(actorSchema.safeParse("system:anything").success).toBe(false);
  });

  it.each([
    ["no kind", "claude-code"],
    ["an empty kind", ":claude-code"],
    ["an unknown kind", "robot:claude-code"],
    ["an empty name", "agent:"],
    ["a space in the name", "human:mary jane"],
    ["a name starting with punctuation", "agent:-lead"],
    ["a second colon", "agent:claude:code"],
    ["a non-ASCII name", "human:zoë"],
    ["an empty string", ""],
  ])("rejects %s (%j)", (_label, actor) => {
    expect(actorSchema.safeParse(actor).success).toBe(false);
  });

  it(`caps the name at ${ACTOR_NAME_MAX} characters`, () => {
    expect(actorSchema.safeParse(`agent:${"a".repeat(ACTOR_NAME_MAX)}`).success).toBe(true);
    expect(actorSchema.safeParse(`agent:${"a".repeat(ACTOR_NAME_MAX + 1)}`).success).toBe(false);
  });

  it("accepts the anonymous fallback it attributes header-less requests to", () => {
    expect(actorSchema.parse(ANONYMOUS_ACTOR)).toBe(ANONYMOUS_ACTOR);
  });
});

describe("storedActorSchema", () => {
  it("accepts system: on responses, where the server is a legitimate author", () => {
    expect(storedActorSchema.parse(SYSTEM_ACTOR)).toBe(SYSTEM_ACTOR);
  });

  it("rejects an empty actor", () => {
    expect(storedActorSchema.safeParse("").success).toBe(false);
  });
});

describe("actorKindOf / actorNameOf", () => {
  it.each([
    ["agent:claude-code", "agent", "claude-code"],
    ["human:krisz", "human", "krisz"],
    [SYSTEM_ACTOR, "system", "taskmanager"],
  ] as const)("splits %s into %s / %s", (actor, kind, name) => {
    expect(actorKindOf(actor)).toBe(kind);
    expect(actorNameOf(actor)).toBe(name);
  });

  it("treats anything that is not agent: or system: as human", () => {
    // The one rule keyed on kind restricts *agents*; an unrecognised value
    // falling to `human` keeps it from being mistaken for one.
    expect(actorKindOf("robot:x")).toBe("human");
    expect(actorKindOf("claude-code")).toBe("human");
  });
});

describe("slugifyActorName", () => {
  it.each([
    ["Krisz", "krisz"],
    ["  Krisz  ", "krisz"],
    ["Mary Jane Watson", "mary-jane-watson"],
    ["John O'Brien", "john-o-brien"],
    ["a.b_c@d/e-f", "a.b_c@d/e-f"],
    ["Zoë", "zo"],
    ["---Krisz---", "krisz"],
    ["@home", "home"],
    ["Dev  Ops!!", "dev-ops"],
  ])("turns %j into %j", (displayName, slug) => {
    expect(slugifyActorName(displayName)).toBe(slug);
  });

  it.each(["", "   ", "!!!", "---", "日本語"])(
    "returns null when nothing usable remains in %j",
    (displayName) => {
      expect(slugifyActorName(displayName)).toBeNull();
    },
  );

  it(`caps the slug at ${ACTOR_NAME_MAX} characters`, () => {
    expect(slugifyActorName("x".repeat(ACTOR_NAME_MAX * 2))).toBe("x".repeat(ACTOR_NAME_MAX));
  });

  it.each(["Krisz", "Mary Jane Watson", "John O'Brien", "@home", "x".repeat(200)])(
    "produces a name that human:<slug> accepts, for %j",
    (displayName) => {
      // The whole point: whatever the viewer types into "Your name" must turn
      // into an X-Actor the API will not 422.
      const slug = slugifyActorName(displayName);
      expect(actorSchema.parse(`human:${slug}`)).toBe(`human:${slug}`);
    },
  );
});
