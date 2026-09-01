/**
 * DynamoDB pages with a `LastEvaluatedKey` -- an item key, not an offset.
 * There is no OFFSET and no total count, because both would require reading
 * every matching item.
 *
 * That is a better pagination model than page numbers, not a worse one: a
 * cursor stays correct when rows are inserted or deleted mid-listing, where
 * `?page=3` silently skips or repeats items. It just cannot answer "how many
 * pages are there", so the API does not pretend to.
 *
 * The key is base64url-encoded to make it URL-safe and, more importantly, to
 * make it look opaque so callers do not start depending on its contents.
 */
export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Returns undefined for anything unparseable rather than throwing.
 *
 * A cursor is caller-supplied input, so it will eventually arrive truncated by
 * a URL shortener or hand-edited. Treating a bad cursor as "start from the
 * beginning" is the least surprising behaviour; throwing would turn a stale
 * bookmark into a 500.
 */
export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
