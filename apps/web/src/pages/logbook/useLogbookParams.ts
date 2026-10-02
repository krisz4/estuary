import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  TASK_EVENT_TYPES,
  type TaskEventType,
} from "@estuary/contracts";
import { DEFAULT_LOGBOOK_RANGE, isLogbookRange, type LogbookRange } from "@/features/logbook/range";
import { parseProjects } from "@/pages/tasks-list/useTaskListParams";

/**
 * The Logbook's URL state — everything a shared link should reproduce.
 *
 * Project scope is read the same way Inbox reads it (`?project=`, via
 * `parseProjects` + `useRememberProjectScope`) rather than a second control:
 * the header's project switcher stays the only project control on any screen.
 *
 * Not modeled on `useTaskListParams`: this page has no single paged list at
 * its top level — the archive (§8) is the only paged section, so its `page`
 * lives here as its own key rather than borrowing the list's page-reset rule,
 * which exists for a filter bar that does not apply to this screen.
 */
export type LogbookParams = {
  project: string[];
  range: LogbookRange;
  from?: string | undefined;
  to?: string | undefined;
  actor: string;
  type: TaskEventType[];
  archiveQ: string;
  archivePage: number;
  archivePageSize: number;
};

const isTaskEventType = (value: string): value is TaskEventType =>
  (TASK_EVENT_TYPES as readonly string[]).includes(value);

const parsePositiveInt = (raw: string | null, fallback: number, max: number): number => {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max);
};

export type UseLogbookParamsResult = LogbookParams & {
  setRange: (range: LogbookRange, bounds?: { from: string; to: string }) => void;
  setActor: (actor: string) => void;
  setType: (type: TaskEventType[]) => void;
  setArchiveQ: (q: string) => void;
  setArchivePage: (page: number) => void;
  setArchivePageSize: (pageSize: number) => void;
};

export const useLogbookParams = (): UseLogbookParamsResult => {
  const [searchParams, setSearchParams] = useSearchParams();

  const params = useMemo<LogbookParams>(() => {
    const rangeRaw = searchParams.get("range");
    const range = isLogbookRange(rangeRaw) ? rangeRaw : DEFAULT_LOGBOOK_RANGE;
    const from = searchParams.get("from") ?? undefined;
    const to = searchParams.get("to") ?? undefined;
    const typeRaw = searchParams.get("type");

    return {
      project: parseProjects(searchParams.getAll("project")),
      range:
        range === "custom" && (from === undefined || to === undefined)
          ? DEFAULT_LOGBOOK_RANGE
          : range,
      from: range === "custom" ? from : undefined,
      to: range === "custom" ? to : undefined,
      actor: searchParams.get("actor")?.trim().toLowerCase() ?? "",
      type: typeRaw !== null && isTaskEventType(typeRaw) ? [typeRaw] : [],
      archiveQ: searchParams.get("q") ?? "",
      archivePage: parsePositiveInt(
        searchParams.get("page"),
        DEFAULT_PAGE,
        Number.MAX_SAFE_INTEGER,
      ),
      archivePageSize: parsePositiveInt(
        searchParams.get("pageSize"),
        DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE,
      ),
    };
  }, [searchParams]);

  const patch = useCallback(
    (updates: Record<string, string | undefined>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(updates)) {
            if (value === undefined || value === "") next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return {
    ...params,
    setRange: (range, bounds) =>
      patch({
        range,
        from: range === "custom" ? bounds?.from : undefined,
        to: range === "custom" ? bounds?.to : undefined,
      }),
    setActor: (actor) => patch({ actor: actor.trim() === "" ? undefined : actor }),
    setType: (type) => patch({ type: type[0] }),
    setArchiveQ: (q) => patch({ q: q.trim() === "" ? undefined : q, page: undefined }),
    setArchivePage: (page) => patch({ page: page === DEFAULT_PAGE ? undefined : String(page) }),
    setArchivePageSize: (pageSize) =>
      patch({
        pageSize: pageSize === DEFAULT_PAGE_SIZE ? undefined : String(pageSize),
        page: undefined,
      }),
  };
};
