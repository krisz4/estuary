import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui";
import { Container } from "@/components/layout/Container";
import { openSessionDialog, useSessionStore } from "@/stores/session";

/**
 * Shown under the header after any request comes back `UNAUTHORIZED`.
 *
 * The error panels on the screen already say what failed; this says what to do
 * about it, once, for every failing request at once — the same missing token
 * breaks the list, the stats badge and every poll together, and three panels
 * each pointing at the dialog would be noise. Saving the dialog clears it.
 */
export const UnauthorizedBanner = () => {
  const unauthorized = useSessionStore((state) => state.unauthorized);
  if (!unauthorized) return null;

  return (
    <div
      role="alert"
      className="border-b border-warning/40 bg-warning-subtle text-warning-subtle-foreground"
    >
      <Container className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm">
        <KeyRound className="size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          This server needs an API token. Add it under <strong>You</strong>, then try again.
        </p>
        <Button size="sm" variant="outline" onClick={openSessionDialog}>
          Set API token
        </Button>
      </Container>
    </div>
  );
};
