import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { parseProjects } from "@/pages/tasks-list/useTaskListParams";
import { safeStorage } from "@/stores/safeStorage";

/**
 * The project the user is focused on — the header's project switcher.
 *
 * ## URL first, store second
 *
 * The scope **is** the `project` query param on the three screens that filter
 * by it — list, map, inbox — so a shared `/inbox?project=web-app` shows
 * exactly that, and the switcher only ever rewrites the URL. What the store adds
 * is the same thing `taskView` adds: the screens without a list URL (detail,
 * create, edit) have nowhere to keep it, so without a memory the header's
 * "Tasks" and "Inbox" links — and the inbox badge — would fall back to every
 * project the moment a task was opened. Someone running agents on three repos
 * reads that as the dashboard forgetting which repo they were in.
 *
 * ## Who writes it
 *
 * Only the scoped screens, through `useRememberProjectScope`, from their URL.
 * Exactly one project selected is a scope; none, or several, is "all projects".
 * Recording arrival rather than the switcher's clicks means a pasted link, a
 * bookmark, and clearing the chip on the list all agree — the store follows the
 * URL and never drives it.
 */

export const PROJECT_SCOPE_STORAGE_KEY = "estuary.projectScope";

/** The pathnames whose `project` param *is* the scope. */
export const PROJECT_SCOPED_PATHS = [
  "/tasks",
  "/tasks/map",
  "/inbox",
  "/inbox/focus",
  "/logbook",
] as const;

export const isProjectScopedPath = (pathname: string): boolean =>
  (PROJECT_SCOPED_PATHS as readonly string[]).includes(pathname);

export type ProjectScopeState = {
  /** A project slug, or `null` for every project. */
  project: string | null;
  setProject: (project: string | null) => void;
};

export const useProjectScopeStore = create<ProjectScopeState>()(
  persist(
    (set) => ({
      project: null,
      setProject: (project) => set((state) => (state.project === project ? state : { project })),
    }),
    {
      name: PROJECT_SCOPE_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),

      // Validated like the URL is: a hand-edited value must not become a filter
      // the API rejects with a 422 on every header render.
      merge: (persisted, current) => {
        const raw = (persisted as Partial<ProjectScopeState> | undefined)?.project;
        const [project] = typeof raw === "string" ? parseProjects([raw]) : [];
        return { ...current, project: project ?? null };
      },
    },
  ),
);

/** The single project a set of `project` params narrows to, or `null`. */
export const scopeFromProjects = (projects: readonly string[]): string | null =>
  projects.length === 1 ? (projects[0] ?? null) : null;

export type ProjectScope = {
  /** The project in scope, or `null` for all. */
  project: string | null;
  /** The URL selects more than one project — the list's chips can; the switcher cannot. */
  multiple: boolean;
};

/**
 * The current scope: the URL's on a scoped screen, the remembered one elsewhere.
 * For the header, which renders on every screen.
 */
export const useProjectScope = (): ProjectScope => {
  const { pathname, search } = useLocation();
  const remembered = useProjectScopeStore((state) => state.project);

  if (!isProjectScopedPath(pathname)) return { project: remembered, multiple: false };
  const projects = parseProjects(new URLSearchParams(search).getAll("project"));
  return { project: scopeFromProjects(projects), multiple: projects.length > 1 };
};

/** Records the scope a scoped screen's URL selects. Called by list, map, and inbox. */
export const useRememberProjectScope = (projects: readonly string[]): void => {
  const project = scopeFromProjects(projects);
  useEffect(() => {
    useProjectScopeStore.getState().setProject(project);
  }, [project]);
};

/** `?project=<slug>`, or `""` for every project. */
export const projectScopeSearch = (project: string | null): string =>
  project === null ? "" : `?${new URLSearchParams({ project }).toString()}`;

/** For tests — see `resetTaskViewStore` for why a module singleton needs this. */
export const resetProjectScopeStore = (): void => {
  useProjectScopeStore.setState({ project: null });
  safeStorage.removeItem(PROJECT_SCOPE_STORAGE_KEY);
};
