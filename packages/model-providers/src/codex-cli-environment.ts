// Codex uses its own saved login at HOME/CODEX_HOME. Workflow storage and
// service credentials are not part of this child-process contract. Keep this
// list explicit so new parent configuration cannot silently enter the CLI.
const common = ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'] as const;
const windows = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;
const mac = ['__CF_USER_TEXT_ENCODING', 'SECURITYSESSIONID'] as const;

/** Platform/auth locations only; proxy, custom endpoint and service settings
 * need their own reviewed contract rather than inheriting the worker's env. */
export function codexCliChildEnvironment(parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  const keys = [...common, ...(platform === 'win32' ? windows : platform === 'darwin' ? mac : [])];
  for (const key of keys) {
    // Windows environment names are case-insensitive. Emit one canonical key
    // instead of passing duplicate PATH/Path entries to the child.
    const value = parent[key] ?? (platform === 'win32'
      ? Object.entries(parent).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
      : undefined);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
