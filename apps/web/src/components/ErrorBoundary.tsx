import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui";

type Props = {
  children: ReactNode;
  /** Remounts the boundary when it changes — the route path, in practice. */
  resetKey?: string;
};

type State = { error: Error | null };

/**
 * Catches render crashes.
 *
 * A class, because React has no hook equivalent: `componentDidCatch` and
 * `getDerivedStateFromError` are the only way to intercept a throw from a
 * descendant's render.
 *
 * Mounted **inside `<main>`**, below the header, so a crashed page leaves the
 * user with working navigation instead of a blank document
 * (`docs/pages/App_Shell.md` § Providers).
 *
 * Note what this does *not* cover, because it is a common misreading: errors
 * thrown in event handlers, in `setTimeout`, and in async code never reach an
 * error boundary. Data-fetching failures are handled by each page's error panel
 * — this is the last resort for a genuine render bug.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only artefact of a render crash; without this it is lost
    // between the throw and the fallback.
    console.error("Render error caught by ErrorBoundary", error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    // Without this, a crash on one route leaves the fallback rendered forever:
    // navigating away changes the children but not the boundary's own state.
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private readonly reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        className="mx-auto my-12 flex max-w-lg flex-col items-start gap-3 rounded-lg border border-border bg-card p-6"
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-destructive-subtle text-destructive-subtle-foreground">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold text-foreground">This page stopped working</h1>
        <p className="text-sm text-muted-foreground">
          An unexpected error broke the screen. The rest of the app still works — try again, or go
          back to the task list.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={this.reset}>Try again</Button>
          <Button asChild variant="outline">
            {/*
              `onClick` resets as well as navigating. `resetKey` is the pathname,
              so a crash *on* /tasks makes this link a same-path navigation —
              the key never changes, the boundary never clears, and the most
              prominent escape hatch does nothing. That is precisely the list
              page, which is where a crash is most likely.
            */}
            <Link to="/tasks" onClick={this.reset}>
              Back to tasks
            </Link>
          </Button>
        </div>
      </div>
    );
  }
}
