import { ACTOR_HEADER, ANONYMOUS_ACTOR, slugifyActorName } from "@helpdesk/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "@/stores/safeStorage";

/**
 * Who the person at this browser says they are, and the shared secret the API
 * may ask for.
 *
 * ## Why this is a store
 *
 * There are no accounts (`docs/features/Actors.md`): an actor is a
 * self-declared label sent on every request in `X-Actor`, so the audit trail
 * can tell a human's change from an agent's. The label is a fact about *this
 * person on this machine* — exactly the shape `taskView` is — and it must never
 * travel in a shared link, so it is neither server state nor URL state.
 *
 * `apiToken` is the `Authorization: Bearer` secret a self-hosted server can
 * require (`API_TOKEN`). Persisting it to `localStorage` makes it readable by
 * any script on the origin; that is the accepted trade for a shared-secret gate
 * on a tool with no login, and the dialog says where it is kept.
 *
 * ## What is *not* persisted
 *
 * `isDialogOpen` and `unauthorized` are transient UI state that more than one
 * component needs — the header's "You" button, the 401 banner, and the comment
 * composer's "set your name" link all open the same dialog. `partialize` keeps
 * them out of storage, so a reload never reopens a dialog or re-shows a stale
 * banner.
 */

export const SESSION_STORAGE_KEY = "helpdesk.session";

export type SessionState = {
  displayName: string;
  apiToken: string;
  /** The session dialog is open. */
  isDialogOpen: boolean;
  /** The last request came back `UNAUTHORIZED`. Cleared by saving the dialog. */
  unauthorized: boolean;
  save: (values: { displayName: string; apiToken: string }) => void;
  setDialogOpen: (open: boolean) => void;
  reportUnauthorized: () => void;
};

const INITIAL = {
  displayName: "",
  apiToken: "",
  isDialogOpen: false,
  unauthorized: false,
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      ...INITIAL,
      save: ({ displayName, apiToken }) =>
        set({
          displayName: displayName.trim(),
          apiToken: apiToken.trim(),
          unauthorized: false,
          isDialogOpen: false,
        }),
      setDialogOpen: (open) =>
        set((state) => (state.isDialogOpen === open ? state : { isDialogOpen: open })),
      // Same no-op guard as `taskView.setView`: every failing poll reports a
      // 401, and re-notifying every subscriber each time for a flag that is
      // already up would re-render the header on a timer.
      reportUnauthorized: () =>
        set((state) => (state.unauthorized ? state : { unauthorized: true })),
    }),
    {
      name: SESSION_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ displayName: state.displayName, apiToken: state.apiToken }),
      /*
        Validated, not trusted — the same rule as `taskView`. A hand-edited
        `{"displayName": 7}` must not reach `slugifyActorName` as a number.
      */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Record<"displayName" | "apiToken", unknown>>;
        return {
          ...current,
          displayName: typeof stored.displayName === "string" ? stored.displayName : "",
          apiToken: typeof stored.apiToken === "string" ? stored.apiToken : "",
        };
      },
    },
  ),
);

/**
 * `"Krisz Tian"` → `"human:krisz-tian"`, or `null` when no usable name is set.
 * `null` means "send no header" — the server attributes the write to
 * `human:anonymous`, which is the honest label for someone who has not said.
 */
export const actorFromDisplayName = (displayName: string): string | null => {
  const slug = slugifyActorName(displayName);
  return slug === null ? null : `human:${slug}`;
};

/**
 * The headers every request carries, from the store's *current* value.
 *
 * Read at request time through `getState()`, not captured when a hook
 * rendered: a poll that fires a minute after the user set their name must send
 * it.
 */
export const sessionHeaders = (
  state: Pick<SessionState, "displayName" | "apiToken"> = useSessionStore.getState(),
): Record<string, string> => {
  const headers: Record<string, string> = {};

  const actor = actorFromDisplayName(state.displayName);
  if (actor !== null) headers[ACTOR_HEADER] = actor;

  const token = state.apiToken.trim();
  if (token !== "") headers.Authorization = `Bearer ${token}`;

  return headers;
};

/** The actor this browser writes as — what "Posting as …" shows. */
export const useSessionActor = (): string =>
  useSessionStore((state) => actorFromDisplayName(state.displayName) ?? ANONYMOUS_ACTOR);

/** Opens the session dialog from anywhere. */
export const openSessionDialog = (): void => useSessionStore.getState().setDialogOpen(true);

/** For tests: the store is a module singleton that outlives `cleanup()`. */
export const resetSessionStore = (): void => {
  useSessionStore.setState(INITIAL);
  safeStorage.removeItem(SESSION_STORAGE_KEY);
};
