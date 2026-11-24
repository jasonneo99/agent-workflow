import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

export interface ProviderAvailabilityScopeOptions {
  accountScope?: string;
  env?: Readonly<Record<string, string | undefined>>;
  hostIdentity?: string;
}

const credentialNames: Readonly<Record<string, readonly string[]>> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  muse: ["MUSE_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  groq: ["GROQ_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  nvidia: ["NVIDIA_NIM_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  "openai-compatible": ["OPENAI_COMPATIBLE_API_KEY"],
  byo: ["BYO_MODEL_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  local: ["LOCAL_MODEL_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
  kiro: ["KIRO_API_KEY"]
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function defaultHostIdentity(): string {
  // OS identity only: never resolve SDK credentials or inspect credential files.
  const principal = typeof process.getuid === "function" ? process.getuid() : userInfo().username;
  return JSON.stringify([hostname(), principal]);
}

/** Opaque storage key; neither credentials nor host identities leave this function. */
export function providerAvailabilityScopeKey(providerId: string, options: ProviderAvailabilityScopeOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitScope = options.accountScope ?? (env.AGENTFLOW_PROVIDER_ACCOUNT_SCOPE || undefined);
  if (explicitScope !== undefined) return digest([providerId, explicitScope]);

  const credential = (credentialNames[providerId] ?? []).map(name => env[name]).find(Boolean);
  if (credential) return digest([providerId, "credential-v1", digest(credential)]);

  // Named profiles and SDK credential chains are unresolved here. Never read
  // their files or assume that a profile name identifies a fleet-wide account.
  if (providerId === "bedrock" && !env.AWS_PROFILE && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return digest([providerId, "credential-v1", digest([env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN || ""])]);
  }
  return digest([providerId, "host-principal-v1", options.hostIdentity ?? defaultHostIdentity()]);
}
