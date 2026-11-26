import { Help, type Command } from "commander";

/** Everyday commands shown by `agentflow --help`, in the order a new user meets them.
 * Every other command still runs and keeps its own --help; `agentflow commands`
 * lists all of them. Nothing here removes or renames a command. */
export const HELP_GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: "Start here", commands: ["list", "commands", "doctor", "validate", "init-project", "onboard-project", "index-project", "bootstrap-storage", "migrate-storage", "ide-onboard"] },
  { title: "Run workflows", commands: ["run-and-watch", "run", "compile", "dynamic-plan", "dynamic-run", "worker", "status", "resume-run", "artifacts", "summarize-run", "export-run", "replay-run", "dashboard", "exec-command", "environments"] },
  { title: "Approvals and feedback", commands: ["approvals", "request-approval", "reply", "notifications", "feedback"] },
  { title: "Project context", commands: ["context-status", "context-report", "context-search", "context-brief"] },
  { title: "Model providers", commands: ["provider-check", "provider-use", "provider-credits"] },
  { title: "Learning", commands: ["learning-report", "learning-proposals", "learning-approvals", "learning-daemon-status"] },
];
export const OPERATOR_GROUP_TITLE = "Operator, hook and maintenance";

/** Groups of registered commands: the everyday groups, then everything else. */
export function groupCommands(program: Command): Array<{ title: string; commands: Command[] }> {
  const byName = new Map(program.commands.map(command => [command.name(), command]));
  const grouped = new Set<string>();
  const groups = HELP_GROUPS.map(group => ({
    title: group.title,
    commands: group.commands.flatMap(name => {
      const command = byName.get(name);
      if (!command) return [];
      grouped.add(name);
      return [command];
    }),
  })).filter(group => group.commands.length);
  const rest = program.commands.filter(command => !grouped.has(command.name()) && command.name() !== "help")
    .sort((a, b) => a.name().localeCompare(b.name()));
  return [...groups, { title: OPERATOR_GROUP_TITLE, commands: rest }];
}

function formatGroups(helper: Help, groups: Array<{ title: string; commands: Command[] }>): string {
  const helpWidth = helper.helpWidth || 80;
  const termWidth = Math.max(0, ...groups.flatMap(group => group.commands.map(command => helper.subcommandTerm(command).length)));
  const item = (command: Command) => {
    const term = helper.subcommandTerm(command), description = helper.subcommandDescription(command);
    const text = description ? helper.wrap(`${term.padEnd(termWidth + 2)}${description}`, helpWidth - 2, termWidth + 2) : term;
    return text.replace(/^/gmu, "  ");
  };
  return groups.map(group => `${group.title}:\n${group.commands.map(item).join("\n")}`).join("\n\n");
}

/** Root help shows the everyday groups; operator commands are listed by `commands`. */
export function applyHelpGroups(program: Command): void {
  program.configureHelp({
    formatHelp(command: Command, helper: Help): string {
      if (command !== program) return Help.prototype.formatHelp.call(helper, command, helper);
      // Render usage, description and options without the flat command list.
      const withoutCommands = Object.assign(Object.create(helper) as Help, { visibleCommands: () => [] });
      const base = Help.prototype.formatHelp.call(withoutCommands, command, withoutCommands).trimEnd();
      const groups = groupCommands(program);
      const everyday = groups.filter(group => group.title !== OPERATOR_GROUP_TITLE);
      const hidden = groups.find(group => group.title === OPERATOR_GROUP_TITLE)?.commands.length ?? 0;
      return `${base}\n\n${formatGroups(helper, everyday)}\n\n${hidden} operator, hook and maintenance commands are not shown.\nRun \`agentflow commands\` to list every command; \`agentflow help <command>\` works for all of them.\n`;
    },
  });
  program.command("commands")
    .description("List every command, grouped, including operator, hook and maintenance commands")
    .action(() => {
      const helper = program.createHelp();
      console.log(formatGroups(helper, groupCommands(program)));
    });
}
