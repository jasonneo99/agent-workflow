

export function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatSignedRate(value: number | null): string {
  if (value === null) return "";
  return `${value > 0 ? "+" : ""}${value}%`;
}

export function runApprovalLevelLabel(level: string): string {
  return ({
    "0": "Advisory only",
    "1": "Draft artifacts",
    "2": "Edit local files",
    "3": "Run local commands and tests",
    "4": "External actions with approval",
    "5": "Trusted scheduled automation",
    "wide-open": "All configured actions"
  } as Record<string, string>)[level] ?? "Custom policy";
}

export function runApprovalLevelRank(level: string): number {
  return level === "wide-open" ? 6 : Number.parseInt(level, 10);
}

export function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T | Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
