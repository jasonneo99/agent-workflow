/** Server-side paging and filtering for long dashboard lists. */

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export interface DashboardPage<T> { items: T[]; page: number; pages: number; total: number; pageSize: number }

export function pageOf<T>(items: readonly T[], params: URLSearchParams, pageSize: number, key = "page"): DashboardPage<T> {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const requested = Number.parseInt(params.get(key) ?? "1", 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pages) : 1;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pages, total: items.length, pageSize };
}

/** Case-insensitive match of `query` against any of the given fields. */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
}

/** "Showing 26–50 of 120" with Previous/Next links that keep every other parameter. */
export function pagerHtml(basePath: string, params: URLSearchParams, result: DashboardPage<unknown>, label: string, key = "page"): string {
  if (result.total <= result.pageSize) return "";
  const href = (page: number) => {
    const next = new URLSearchParams(params);
    if (page <= 1) next.delete(key); else next.set(key, String(page));
    const query = next.toString();
    return escapeAttribute(`${basePath}${query ? `?${query}` : ""}`);
  };
  const first = (result.page - 1) * result.pageSize + 1;
  const last = Math.min(result.total, result.page * result.pageSize);
  const previous = result.page > 1 ? `<a class="button secondary" rel="prev" href="${href(result.page - 1)}">Previous</a>` : "";
  const nextLink = result.page < result.pages ? `<a class="button secondary" rel="next" href="${href(result.page + 1)}">Next</a>` : "";
  return `<nav class="pager" aria-label="${escapeAttribute(label)} pages"><span class="muted">Showing ${first}–${last} of ${result.total}</span>${previous}${nextLink}</nav>`;
}
