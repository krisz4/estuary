import { FilterX, Inbox, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Pagination } from "@/components/Pagination";
import { Button } from "@/components/ui";
import { useTicketFacetsQuery, useTicketsQuery } from "@/api/tickets";
import { TicketCardList, TicketCardListSkeleton } from "@/features/tickets/TicketCardList";
import { TicketFilterBar } from "@/features/tickets/TicketFilterBar";
import { TicketTable, TicketTableSkeleton } from "@/features/tickets/TicketTable";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/formatting";
import { MD_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useTicketListParams } from "@/pages/tickets-list/useTicketListParams";

/**
 * `/tickets` — the landing screen. Spec: `docs/pages/Tickets_List.md`.
 *
 * The page owns no list state of its own. Everything a user can change lives in
 * the URL through `useTicketListParams()`, which is what makes a filtered view
 * shareable, survive reload, and step backwards correctly. Nothing here is
 * mirrored into `useState`, and no fetched data is copied out of TanStack Query.
 */
export const TicketsListPage = () => {
  useDocumentTitle("Tickets");

  const { params, setPage, setPageSize, setSort, setFilters, clearFilters, activeFilterCount } =
    useTicketListParams();

  /**
   * `md` decides which of two different components renders — not which of two
   * rendered components is visible. See `MD_BREAKPOINT_QUERY`.
   */
  const isWide = useMediaQuery(MD_BREAKPOINT_QUERY);

  const facetsQuery = useTicketFacetsQuery();
  const ticketsQuery = useTicketsQuery(params);

  const { data, error, isPending, isFetching, isPlaceholderData, refetch } = ticketsQuery;

  const tickets = data?.data ?? [];
  const meta = data?.meta;

  /**
   * A refetch with previous data still on screen: dim it and mark it busy rather
   * than tearing it down for a skeleton. `isPlaceholderData` is true exactly when
   * `keepPreviousData` is showing the *last* page's rows while the next one
   * loads, which is the case the guidelines are about; `isFetching` also covers a
   * plain background refresh of the same page.
   */
  const isRefreshing = (isFetching && !isPending) || isPlaceholderData;

  const hasFilters = activeFilterCount > 0;

  return (
    <div className="flex flex-col gap-4">
      {/*
        No "New ticket" button here: `AppHeader` already renders one on every
        screen, and the design guidelines allow one primary action per view. Two
        identical buttons 60px apart is not redundancy, it is a question about
        whether they do the same thing.
      */}
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Tickets</h1>
        <p className="text-sm text-muted-foreground">
          Every support request, newest first by default.
        </p>
      </header>

      <TicketFilterBar
        params={params}
        facets={facetsQuery.data}
        onFiltersChange={setFilters}
        onSortChange={setSort}
        onClear={clearFilters}
        activeFilterCount={activeFilterCount}
        isWide={isWide}
      />

      {/*
        Announced, not shown — the visible count already sits in the pager's
        "Showing 1–20 of 63". A screen-reader user gets no layout to scan, so a
        filter change would otherwise be silent.
      */}
      <p aria-live="polite" className="sr-only">
        {meta === undefined ? "" : `${formatCount(meta.total, "ticket")} found`}
      </p>

      {/* A failed background refresh keeps the stale rows and explains itself above them. */}
      {error !== null && data !== undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : null}

      {isPending ? (
        isWide ? (
          <TicketTableSkeleton />
        ) : (
          <TicketCardListSkeleton />
        )
      ) : error !== null && data === undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : tickets.length === 0 ? (
        <ListEmptyState
          hasFilters={hasFilters}
          isPastEnd={meta !== undefined && meta.total > 0 && params.page > 1}
          onClearFilters={clearFilters}
          onFirstPage={() => setPage(1)}
        />
      ) : (
        <div
          aria-busy={isRefreshing || undefined}
          className={cn("transition-opacity", isRefreshing && "opacity-60")}
        >
          {isWide ? (
            <TicketTable tickets={tickets} sort={params.sort} onSortChange={setSort} />
          ) : (
            <TicketCardList tickets={tickets} />
          )}
        </div>
      )}

      {meta === undefined || (tickets.length === 0 && meta.total === 0) ? null : (
        <Pagination meta={meta} onPageChange={setPage} onPageSizeChange={setPageSize} />
      )}
    </div>
  );
};

/**
 * The empty state, in its three genuinely different flavours.
 *
 * "Nothing exists" and "nothing matches" are not the same screen: offering
 * "Create the first ticket" to someone whose filter is too narrow is the wrong
 * answer, and offering "Clear filters" to someone with an empty database is a
 * dead end. The third case — a real result set, but the URL points past its last
 * page — has its own action again, because clearing filters would throw away a
 * query that is working fine.
 */
const ListEmptyState = ({
  hasFilters,
  isPastEnd,
  onClearFilters,
  onFirstPage,
}: {
  hasFilters: boolean;
  isPastEnd: boolean;
  onClearFilters: () => void;
  onFirstPage: () => void;
}) => {
  if (isPastEnd) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nothing on this page"
        description="This page is past the end of the current result set."
        action={<Button onClick={onFirstPage}>Back to page 1</Button>}
      />
    );
  }

  if (hasFilters) {
    return (
      <EmptyState
        icon={FilterX}
        title="No tickets match these filters"
        description="Try removing a filter or widening the date range."
        action={
          <Button variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={Inbox}
      title="No tickets yet"
      description="When someone reports a problem, it will show up here."
      action={
        <Button asChild>
          <Link to="/tickets/new">
            <Plus aria-hidden="true" />
            Create the first ticket
          </Link>
        </Button>
      }
    />
  );
};
