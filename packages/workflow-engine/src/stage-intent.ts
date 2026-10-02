export interface StageIntent { projectId: string; owner: string; fencingToken: string }

/** Only the structured result of the supported acquisition command is ownership evidence. */
export function acquiredStageIntent(command: string, stdout: string, exitCode: number | null, timedOut: boolean): StageIntent | null {
  if (exitCode !== 0 || timedOut || !/^npm run reliability -- intent acquire(?:\s|$)/u.test(command)) return null;
  const start = stdout.indexOf("{\n");
  if (start < 0) return null;
  try {
    const value = JSON.parse(stdout.slice(start)) as StageIntent;
    if (typeof value.projectId !== "string" || typeof value.owner !== "string" || typeof value.fencingToken !== "string" || !/^[1-9]\d*$/u.test(value.fencingToken)) return null;
    const hasArgument = (name: string, value: string): boolean => {
      return [value, `'${value}'`, `"${value}"`].some((text) => command.includes(`--${name} ${text} `) || command.endsWith(`--${name} ${text}`));
    };
    return hasArgument("project", value.projectId) && hasArgument("owner", value.owner)
      ? { projectId: value.projectId, owner: value.owner, fencingToken: value.fencingToken } : null;
  } catch { return null; }
}
