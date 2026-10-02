import { actorKindOf, actorNameOf } from "@estuary/contracts";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui";
import { openSessionDialog, useSessionActor } from "@/stores/session";

/**
 * The header's "You" button. Shows who this browser writes as, and opens the
 * session dialog.
 *
 * Two buttons for two breakpoints, for the same reason as the header's "New
 * task": an icon-only button needs an `aria-label`, and a labelled one must not
 * carry a second, different accessible name.
 */
export const SessionControl = () => {
  const actor = useSessionActor();
  const name =
    actorKindOf(actor) === "human" && actorNameOf(actor) !== "anonymous"
      ? actorNameOf(actor)
      : null;
  const label =
    name === null
      ? "You: anonymous. Set your name and API token."
      : `You: ${name}. Change your name or API token.`;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="sm:hidden"
        onClick={openSessionDialog}
        aria-label={label}
      >
        <UserRound aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        className="hidden max-w-[10rem] sm:inline-flex"
        onClick={openSessionDialog}
        title={label}
      >
        <UserRound aria-hidden="true" />
        <span className="truncate">{name ?? "You"}</span>
      </Button>
    </>
  );
};
