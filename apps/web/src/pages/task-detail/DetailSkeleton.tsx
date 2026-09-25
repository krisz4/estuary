import { Skeleton } from "@/components/ui";

/**
 * Loading placeholder for the detail page.
 *
 * Mirrors the real layout — header block, description card, comment cards, and
 * the aside above `md` — rather than showing a centred spinner. The guidelines
 * rule the spinner out for a concrete reason: it collapses the page to nothing
 * and snaps it back to full height, which reads worse than a slow load.
 */
export const DetailSkeleton = () => (
  <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading task">
    <div className="flex flex-col gap-3">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-3/4 max-w-lg" />
    </div>

    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </div>

      <div className="flex w-full flex-col gap-4 md:w-72 md:shrink-0">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
    </div>
  </div>
);
