export function newestSourceMtime(rootDir: string, dirs?: string[]): number;
export function selectLaunchEntry(rootDir: string, env?: Record<string, string | undefined>): { mode: "tsx" | "dist"; entry: string };
