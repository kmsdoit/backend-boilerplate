import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Cursor pagination, not page numbers.
 *
 * This is forced by the store -- DynamoDB pages with a `LastEvaluatedKey` and
 * has no OFFSET -- but it is also the better contract. A cursor stays correct
 * when items are inserted or removed mid-listing; `?page=3` silently skips or
 * repeats items when the underlying set shifts under it.
 *
 * What it cannot give you is a total count, because counting means reading
 * every matching item. The response therefore has no `total` and no
 * `pageCount`, and no amount of client convenience justifies adding one: it
 * would turn every list request into a full scan.
 */
export const paginationQueryShape = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  /** Opaque. Comes from a previous response's `nextCursor`; never constructed by a caller. */
  cursor: z.string().min(1).optional(),
};

export type PaginationQuery = {
  limit: number;
  cursor?: string;
};

export type Page<T> = {
  items: T[];
  /** Absent when there are no more items. Its presence is the only "has more" signal. */
  nextCursor?: string;
};
