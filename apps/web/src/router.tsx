import { createBrowserRouter, Navigate, useLocation } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { InboxFocusPage } from "@/pages/inbox-focus/InboxFocusPage";
import { LogbookPage } from "@/pages/logbook/LogbookPage";
import { NotFoundPage } from "@/pages/not-found/NotFoundPage";
import { TaskCreatePage } from "@/pages/task-create/TaskCreatePage";
import { TaskDetailPage } from "@/pages/task-detail/TaskDetailPage";
import { TaskEditPage } from "@/pages/task-edit/TaskEditPage";
import { TasksMapPage } from "@/pages/tasks-map/TasksMapPage";
import { TasksListPage } from "@/pages/tasks-list/TasksListPage";

/**
 * `/tasks/floor` → `/tasks/map`, preserving the query string. The Foundry
 * design became Estuary and the route was renamed with it; a link written
 * before the rename (a bookmark, a chat message, `?task=42` shared mid-review)
 * still lands on the right task instead of a 404.
 */
const FloorRedirect = () => {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/tasks/map", search }} replace />;
};

/**
 * `/tasks/board` → `/tasks/map`, preserving the query string. The Kanban
 * board was retired in favor of the Estuary map view; a bookmark or shared
 * link to the old board still lands on the right task list instead of a 404.
 */
const BoardRedirect = () => {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/tasks/map", search }} replace />;
};

/**
 * The route table. Documented per screen in `docs/pages/`.
 *
 * **`/tasks/new`, `/tasks/board`, and `/tasks/map` are declared before
 * `/tasks/:taskId`.** React Router 7
 * ranks routes by specificity rather than by declaration order, so it happens to
 * resolve correctly either way today — but the ordering is written down as the
 * rule in `docs/pages/README.md` and in the implementation plan, and relying on
 * a ranking algorithm to save a mis-ordered table is a bet on an implementation
 * detail. Written in the safe order, both mechanisms agree.
 *
 * Every route sits under `AppLayout`, including the catch-all: a 404 that loses
 * the header leaves the user with no way out but the back button.
 */
/**
 * Exported (not just inlined into `createBrowserRouter`) so `router.test.tsx`
 * can mount the same table under `createMemoryRouter` — the redirect from `/`
 * is app behaviour worth a real regression test, not just eyeballing.
 */
export const routeChildren = [
  { index: true, element: <Navigate to="/tasks/map" replace /> },

  { path: "tasks", element: <TasksListPage /> },

  { path: "tasks/new", element: <TaskCreatePage /> },

  { path: "tasks/board", element: <BoardRedirect /> },

  { path: "tasks/map", element: <TasksMapPage /> },

  { path: "tasks/floor", element: <FloorRedirect /> },

  { path: "tasks/:taskId", element: <TaskDetailPage /> },

  { path: "tasks/:taskId/edit", element: <TaskEditPage /> },

  { path: "inbox", element: <InboxPage /> },

  { path: "inbox/focus", element: <InboxFocusPage /> },

  { path: "logbook", element: <LogbookPage /> },

  { path: "*", element: <NotFoundPage /> },
];

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: routeChildren,
  },
]);
