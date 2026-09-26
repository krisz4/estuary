import { useLocation, useNavigate } from "react-router-dom";
import { useTaskFacetsQuery } from "@/api/tasks";
import { Select } from "@/components/ui";
import { isProjectScopedPath, projectScopeSearch, useProjectScope } from "@/stores/projectScope";
import { taskViewPath, useTaskView } from "@/stores/taskView";

/** Radix reserves `""` for "nothing selected", so "all" needs a value of its own. */
const ALL = "__all__";
/** Shown, disabled, while the list's chips select more than one project. */
const MULTIPLE = "__multiple__";

/**
 * The header's project picker — one repository's list, map, and inbox at a
 * time, for someone running agents on several.
 *
 * It only ever writes the URL (see `stores/projectScope.ts`):
 *
 * - On list, map, or inbox it swaps that screen's `project` param in place,
 *   keeping every other filter and dropping `page` — page 4 of every project is
 *   not a page of one.
 * - Anywhere else there is no filter to swap, so it goes to the remembered task
 *   view for that project.
 *
 * Hidden until at least one task has a project: a picker whose only option is
 * "All projects" is chrome with nothing to pick.
 */
export const ProjectSwitcher = () => {
  const { project, multiple } = useProjectScope();
  const { data: facets } = useTaskFacetsQuery();
  const view = useTaskView();
  const location = useLocation();
  const navigate = useNavigate();

  // The scoped project stays an option before (or without) the facets loading,
  // as the filter bar's chips do for a project arriving on a shared link.
  const projects = [
    ...new Set([...(facets?.projects ?? []), ...(project === null ? [] : [project])]),
  ].sort();
  if (projects.length === 0) return null;

  const options = [
    { value: ALL, label: "All projects" },
    ...(multiple ? [{ value: MULTIPLE, label: "Several projects", disabled: true }] : []),
    ...projects.map((value) => ({ value, label: value })),
  ];

  const select = (value: string) => {
    const next = value === ALL ? null : value;
    if (!isProjectScopedPath(location.pathname)) {
      void navigate(`${taskViewPath(view)}${projectScopeSearch(next)}`);
      return;
    }
    const params = new URLSearchParams(location.search);
    params.delete("project");
    params.delete("page");
    if (next !== null) params.append("project", next);
    const search = params.toString();
    void navigate({ pathname: location.pathname, search: search === "" ? "" : `?${search}` });
  };

  return (
    <Select
      aria-label="Current project"
      options={options}
      value={multiple ? MULTIPLE : (project ?? ALL)}
      onValueChange={select}
      className="h-9 w-auto max-w-[8.5rem] min-w-0 shrink-0 rounded-full border-border/80 bg-card px-3.5 text-sm font-medium shadow-sm hover:bg-muted sm:h-9 sm:max-w-[12rem] [&>span]:truncate"
    />
  );
};
