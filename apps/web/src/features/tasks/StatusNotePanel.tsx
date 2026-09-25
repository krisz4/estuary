import { type TaskStatus } from "@helpdesk/contracts";
import {
  Ban,
  CircleHelp,
  ClipboardCheck,
  Hand,
  MessageSquareText,
  PauseCircle,
  PenLine,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The "why" of the current status — `statusNote` — framed by what that status
 * means.
 *
 * The note is one field on the wire, but it is a different thing per status:
 * the reason a task is blocked, the manual step a human has to take, the
 * change summary an agent handed to QA. A bare "Status note" heading would
 * make the reader work that out; the heading says it.
 *
 * `statusNote` is replaced on every transition — the history is the activity
 * timeline — so this panel always describes the status the task is in now.
 */

type Framing = { heading: string; icon: LucideIcon; className: string };

const NEUTRAL = "border-border bg-muted/40";

const FRAMING: Record<TaskStatus, Framing> = {
  backlog: { heading: "Note", icon: MessageSquareText, className: NEUTRAL },
  needs_refinement: {
    heading: "What's unclear",
    icon: PenLine,
    className: "border-warning/40 bg-warning-subtle/60",
  },
  todo: { heading: "Latest note", icon: MessageSquareText, className: NEUTRAL },
  in_progress: { heading: "Latest note", icon: MessageSquareText, className: NEUTRAL },
  blocked: {
    heading: "Blocked because…",
    icon: Ban,
    className: "border-destructive/40 bg-destructive-subtle/60",
  },
  needs_user_decision: {
    heading: "Decision needed",
    icon: CircleHelp,
    className: "border-primary/40 bg-primary-subtle/40",
  },
  needs_user_action: {
    heading: "What you need to do",
    icon: Hand,
    className: "border-primary/40 bg-primary-subtle/40",
  },
  needs_qa: {
    heading: "QA summary",
    icon: ClipboardCheck,
    className: "border-primary/40 bg-primary-subtle/40",
  },
  done: { heading: "Closing note", icon: MessageSquareText, className: NEUTRAL },
  deferred: { heading: "Deferred because…", icon: PauseCircle, className: NEUTRAL },
};

/** The heading the panel uses for a status — also the inbox's per-item label. */
export const statusNoteHeading = (status: TaskStatus): string => FRAMING[status].heading;

export type StatusNotePanelProps = {
  status: TaskStatus;
  note: string;
  /** `2` on the detail page; `4` inside an inbox item, whose title is an `h3`. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
};

export const StatusNotePanel = ({
  status,
  note,
  headingLevel = 2,
  className,
}: StatusNotePanelProps) => {
  const { heading, icon: Icon, className: tone } = FRAMING[status];
  const Heading = `h${headingLevel}` as const;

  return (
    <section
      aria-label={heading}
      className={cn("flex flex-col gap-1.5 rounded-lg border p-4", tone, className)}
    >
      <Heading className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {heading}
      </Heading>
      {/* Text node + `whitespace-pre-wrap`, like every other agent-written body. */}
      <p className="text-sm whitespace-pre-wrap text-foreground">{note}</p>
    </section>
  );
};
