/** Order only already-requested commands. Declarations do not grant execution
 * authority or add commands that policy/approval selection withheld.
 */
export function verificationCommandsFirst(requested: readonly string[], declared: readonly string[]): string[] {
  const commands = [...new Set(requested)];
  const required = new Set(declared);
  return [
    ...[...required].filter(command => commands.includes(command)),
    ...commands.filter(command => !required.has(command))
  ];
}
