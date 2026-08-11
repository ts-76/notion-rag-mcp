export function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readUnknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
