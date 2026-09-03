import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * `z.coerce` because query strings are always strings: `?page=2` arrives as
 * "2". Coercing here rather than in each route means a handler receives a
 * real number and cannot forget the conversion.
 *
 * MAX_PAGE_SIZE is a hard ceiling, not a suggestion -- without it a caller
 * can ask for pageSize=1000000 and turn a paginated endpoint into a full
 * table scan.
 */
export const paginationQueryShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

export type PaginationQuery = {
  page: number;
  pageSize: number;
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

/** Offset for a 1-based page number. Kept here so it is defined exactly once. */
export function toOffset({ page, pageSize }: PaginationQuery): number {
  return (page - 1) * pageSize;
}
