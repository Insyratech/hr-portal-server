export function ok<T>(data: T, meta: Record<string, unknown> = {}) {
  return {
    success: true as const,
    data,
    meta,
  };
}
