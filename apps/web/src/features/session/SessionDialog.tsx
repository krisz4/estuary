import { ACTOR_NAME_MAX } from "@estuary/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@/components/ui";
import { actorFromDisplayName, useSessionStore } from "@/stores/session";

/**
 * "You" — the display name your writes are attributed to, and the API token.
 *
 * Opened from the header, from the 401 banner, and from the comment composer's
 * "posting as" line; all three go through the session store's `isDialogOpen`,
 * so there is one dialog rather than three copies of it.
 *
 * The draft lives in component state and is committed only on Save. Radix
 * unmounts the content on close, so every opening starts from the stored
 * values rather than from whatever was half-typed and dismissed last time.
 */
export const SessionDialog = () => {
  const isOpen = useSessionStore((state) => state.isDialogOpen);
  const setDialogOpen = useSessionStore((state) => state.setDialogOpen);

  return (
    <Dialog open={isOpen} onOpenChange={setDialogOpen}>
      <DialogContent>
        <SessionForm onDone={() => setDialogOpen(false)} />
      </DialogContent>
    </Dialog>
  );
};

const SessionForm = ({ onDone }: { onDone: () => void }) => {
  const queryClient = useQueryClient();
  const storedName = useSessionStore((state) => state.displayName);
  const storedToken = useSessionStore((state) => state.apiToken);
  const save = useSessionStore((state) => state.save);

  const [displayName, setDisplayName] = useState(storedName);
  const [apiToken, setApiToken] = useState(storedToken);
  const [showToken, setShowToken] = useState(false);
  const showTokenId = useId();

  const actor = actorFromDisplayName(displayName);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const tokenChanged = apiToken.trim() !== storedToken;
        save({ displayName, apiToken });
        toast.success(actor === null ? "Saved. You're anonymous." : `Saved. You're ${actor}.`);
        // Anything that failed with a 401 is worth asking again with the new
        // token. A name change alone affects writes only, so reads stay put.
        if (tokenChanged) void queryClient.invalidateQueries();
        onDone();
      }}
    >
      <DialogHeader>
        <DialogTitle>You</DialogTitle>
        <DialogDescription>
          There are no accounts. Your name labels what you change, so the activity log can tell your
          edits from an agent&apos;s.
        </DialogDescription>
      </DialogHeader>

      <Field
        label="Your name"
        help={
          actor === null
            ? "Leave blank to act as anonymous."
            : `Your changes are recorded as ${actor}.`
        }
      >
        {(field) => (
          <Input
            {...field}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={ACTOR_NAME_MAX}
            autoComplete="name"
            placeholder="Krisz"
            autoFocus
          />
        )}
      </Field>

      <Field
        label="API token"
        help="Only needed if the server was started with API_TOKEN. Kept in this browser's local storage."
      >
        {(field) => (
          <Input
            {...field}
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            type={showToken ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>

      <label htmlFor={showTokenId} className="-mt-2 flex w-fit items-center gap-2 text-sm">
        <input
          id={showTokenId}
          type="checkbox"
          className="size-4 accent-primary"
          checked={showToken}
          onChange={(event) => setShowToken(event.target.checked)}
        />
        Show token
      </label>

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
};
