import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { NotFoundPage } from "@/pages/not-found/NotFoundPage";
import { TaskCreatePage } from "@/pages/task-create/TaskCreatePage";
import { TaskDetailPage } from "@/pages/task-detail/TaskDetailPage";
import { TaskEditPage } from "@/pages/task-edit/TaskEditPage";
import { TasksBoardPage } from "@/pages/tasks-board/TasksBoardPage";
import { TasksListPage } from "@/pages/tasks-list/TasksListPage";

/**
 * The route table. Documented per screen in `docs/pages/`.
 *
 * **`/tasks/new` and `/tasks/board` are declared before
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
export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },

      { path: "tasks", element: <TasksListPage /> },

      { path: "tasks/new", element: <TaskCreatePage /> },

      { path: "tasks/board", element: <TasksBoardPage /> },

      { path: "tasks/:taskId", element: <TaskDetailPage /> },

      { path: "tasks/:taskId/edit", element: <TaskEditPage /> },

      { path: "inbox", element: <InboxPage /> },

      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
