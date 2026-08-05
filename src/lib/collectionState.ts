export function withoutIds(current: Set<string>, ids: string[]): Set<string> {
  const next = new Set(current);
  for (const id of ids) next.delete(id);
  return next;
}

export function omitKeys<T>(current: Record<string, T>, keys: string[]): Record<string, T> {
  let changed = false;
  const next = { ...current };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : current;
}
