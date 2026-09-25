import { Skeleton } from "@/components/ui";

/** Loading placeholder shaped like `TicketForm`, so the page does not jump. */
export const FormSkeleton = () => (
  <div className="flex max-w-2xl flex-col gap-5" aria-busy="true" aria-label="Loading ticket">
    <FieldSkeleton />
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-32 w-full" />
    </div>
    <div className="grid gap-5 sm:grid-cols-2">
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton />
    </div>
    <FieldSkeleton />
    <FieldSkeleton />
    <FieldSkeleton />
  </div>
);

const FieldSkeleton = () => (
  <div className="flex flex-col gap-1.5">
    <Skeleton className="h-4 w-24" />
    <Skeleton className="h-10 w-full sm:h-9" />
  </div>
);
