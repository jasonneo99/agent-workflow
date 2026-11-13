export function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function round(value: number): number {
  return Number(value.toFixed(2));
}

export function groupBy<T>(items: T[], selectKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = selectKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

export function maxNumber(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

export function averageNullable(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numbers.length) {
    return null;
  }
  return round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}
