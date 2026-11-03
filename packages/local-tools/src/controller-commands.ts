/** Runtime capability tokens are enrollment authority, never worker commands. */
export const controllerCommandBoundary = 'Controller commands are runtime-owned and excluded even by broad command wildcards; request the underlying authorized test command and consume supplied workflow evidence instead.';

export function isControllerCommand(commandLine: string): boolean {
  const words = Array.from(commandLine.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/gu), match => match[1] ?? match[2] ?? match[0]);
  const executable=(words[0]??'').replace(/^.*[\\/]/u,'');
  if (/^agentflow(?:\.cmd|\.exe)?$/iu.test(executable)) return true;
  if (!/^npm(?:\.cmd|\.exe)?$/iu.test(executable)) return false;
  // npm's prefix/workspace flags may precede or follow `run`.
  let index = 1;
  const options = new Set(['--prefix', '-C', '--workspace', '-w', '--userconfig', '--cache']);
  const skipOptions = () => {
    while (words[index]?.startsWith('-') && words[index] !== '--') {
      const option = words[index++]!;
      if (options.has(option)) index += 1;
    }
  };
  skipOptions();
  if (!['run', 'run-script'].includes(words[index++] ?? '')) return false;
  skipOptions();
  if(words[index]==='--')index++;
  return words[index] === 'agentflow';
}

export function assertWorkerCommand(commandLine: string): void {
  if (isControllerCommand(commandLine)) throw Error(`Controller command rejected as a nested agent command: ${controllerCommandBoundary}`);
}

export function workerAllowedCommands(commands: readonly string[]): string[] {
  return commands.filter(command => !isControllerCommand(command));
}
