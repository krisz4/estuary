import { type Checkpoint, type Verification } from "@estuary/contracts";
import { ExternalLink } from "lucide-react";

type QaEvidence = NonNullable<NonNullable<Verification["qa"]>["evidence"]>[number];

/** Only http(s) ever arrives (the contract enforces it); anything else is dropped, not linked. */
const safeUrl = (url: string): string | null => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

const KIND_LABEL: Record<QaEvidence["kind"], string> = {
  photo: "Photo",
  video: "Video",
  doc: "Document",
  link: "Link",
};

const EvidenceItems = ({ items }: { items: readonly QaEvidence[] | undefined }) => {
  const safe = (items ?? []).flatMap((item) => {
    const url = safeUrl(item.url);
    return url === null ? [] : [{ ...item, url }];
  });
  if (safe.length === 0) return null;
  const photos = safe.filter((item) => item.kind === "photo");
  const others = safe.filter((item) => item.kind !== "photo");
  return (
    <div className="flex flex-col gap-2">
      {photos.length === 0 ? null : (
        <ul aria-label="QA photos" className="flex flex-wrap gap-2">
          {photos.map((photo, i) => (
            <li key={i} className="max-w-full">
              <a
                href={photo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block max-w-full rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <img
                  src={photo.url}
                  alt={photo.description ?? "QA photo"}
                  loading="lazy"
                  className="block h-auto max-h-48 w-auto max-w-full rounded-md object-contain sm:max-w-64"
                />
              </a>
              {photo.description ? (
                <p className="mt-1 max-w-64 text-xs text-muted-foreground">{photo.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {others.length === 0 ? null : (
        <ul aria-label="QA evidence links" className="flex flex-col gap-1">
          {others.map((item, i) => (
            <li key={i} className="min-w-0">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1 break-all text-primary hover:underline"
              >
                {KIND_LABEL[item.kind]}
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              {item.description ? (
                <span className="text-muted-foreground"> — {item.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const VerificationPanel = ({ evidence }: { evidence: Verification | null | undefined }) =>
  evidence == null ? (
    <p className="text-sm text-muted-foreground">
      No verification evidence supplied. Review this handoff individually.
    </p>
  ) : (
    <section aria-label="Verification evidence" className="flex flex-col gap-2 text-sm">
      <p>
        Tested commit: <code className="break-all">{evidence.commit}</code>
      </p>
      <ul className="flex flex-col gap-1">
        {evidence.checks.map((check, i) => (
          <li key={i}>
            <strong>{check.result.replaceAll("_", " ")}</strong>:{" "}
            <code className="break-all">{check.command}</code>
            {check.output ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{check.output}</p>
            ) : null}
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-1">
        {evidence.criteria.map((item, i) => (
          <li key={i}>
            <strong>{item.result.replaceAll("_", " ")}</strong>: {item.criterion}
          </li>
        ))}
      </ul>
      {evidence.qa?.method === "device" ? (
        <div className="flex flex-col gap-1">
          <p>
            QA'd on <strong>{evidence.qa.target}</strong>
          </p>
          <ul className="flex flex-col gap-1">
            {evidence.qa.scenarios.map((item, i) => (
              <li key={i}>
                <strong>{item.result}</strong>: {item.scenario}
              </li>
            ))}
          </ul>
          {evidence.qa.notes ? (
            <p className="whitespace-pre-wrap text-muted-foreground">{evidence.qa.notes}</p>
          ) : null}
          <EvidenceItems items={evidence.qa.evidence} />
        </div>
      ) : evidence.qa?.method === "not_needed" ? (
        <p className="whitespace-pre-wrap">
          <strong>No device check needed</strong>: {evidence.qa.reason}
        </p>
      ) : null}
      {evidence.qa?.method === "not_needed" ? <EvidenceItems items={evidence.qa.evidence} /> : null}
      <p className="text-xs text-muted-foreground">
        Reported by the agent; confirm the evidence before approving.
      </p>
    </section>
  );
export const CheckpointPanel = ({ checkpoint }: { checkpoint: Checkpoint | null | undefined }) =>
  checkpoint == null ? null : (
    <section
      aria-label="Resume checkpoint"
      className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm"
    >
      <h2 className="font-semibold">Resume checkpoint</h2>
      {checkpoint.branch ? (
        <p>
          Branch: <code className="break-all">{checkpoint.branch}</code>
        </p>
      ) : null}
      {checkpoint.commit ? (
        <p>
          Commit: <code className="break-all">{checkpoint.commit}</code>
        </p>
      ) : null}
      <p className="whitespace-pre-wrap">
        <strong>Completed:</strong> {checkpoint.completed}
      </p>
      <p className="whitespace-pre-wrap">
        <strong>Remaining:</strong> {checkpoint.remaining}
      </p>
    </section>
  );
