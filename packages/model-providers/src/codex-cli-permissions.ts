import path from "node:path";

/** Changes to this version require repeating the native dispatcher controls. */
export const qualifiedCodexCliVersion = "0.160.0";

export function assertCodexCliVersion(output: string): void {
  if (output.trim() !== `codex-cli ${qualifiedCodexCliVersion}`) {
    throw Object.assign(new Error(`Codex CLI requires qualified version ${qualifiedCodexCliVersion}; execution was not started.`), {
      code: "CODEX_CLI_UNQUALIFIED_VERSION", retryable: false
    });
  }
}

const disabledFeatures = [
  "shell_tool", "unified_exec", "unified_exec_tty", "apps", "plugins", "remote_plugin", "hooks",
  "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser",
  "image_generation", "view_image", "multi_agent", "multi_agent_v2", "code_mode", "code_mode_host",
  "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "goals", "sleep_tool",
  "daemon_auto_start", "auth_elicitation", "memories", "mcp_oauth_refresh_coordination", "shell_snapshot",
  "enable_request_compression"
] as const;

/** Native tools get no repository/auth-home grant. Structured actions stay controller-owned. */
export function codexCliPermissionArgs(ownedDirectory: string, resolvedBinary: string): string[] {
  const roots = [...new Set([path.resolve(ownedDirectory), path.resolve(resolvedBinary)])];
  const filesystem = [`\":minimal\"=\"read\"`, ...roots.map(root => `${JSON.stringify(root)}=\"read\"`)];
  const config = [
    'approval_policy="never"', 'default_permissions="agentflow_stage_readonly"',
    `permissions.agentflow_stage_readonly.filesystem={${filesystem.join(",")}}`,
    "permissions.agentflow_stage_readonly.network.enabled=false", "agents.enabled=false",
    "project_doc_max_bytes=0", 'web_search="disabled"', "skills.bundled.enabled=false",
    "skills.include_instructions=false", "analytics.enabled=false",
    ...disabledFeatures.map(feature => `features.${feature}=false`)
  ];
  return ["--strict-config", ...config.flatMap(value => ["--config", value])];
}
