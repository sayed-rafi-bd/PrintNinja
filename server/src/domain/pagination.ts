// Shared list shape (REFACTORING.md section 9): every list has one
// shape, bounded per-user lists included.
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
}

export function toPage<T>(
  items: T[],
  total: number,
  query: { page: number; pageSize: number },
): Page<T> {
  return {
    items,
    page: query.page,
    page_size: query.pageSize,
    total,
    has_more: query.page * query.pageSize < total,
  };
}
