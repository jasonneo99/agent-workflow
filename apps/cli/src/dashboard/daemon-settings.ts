import { trustSettingsFromForm } from "../../../../packages/daemon-control/src/settings.js";

export function parseDaemonSettingsRequest(form: Pick<FormData, "get">) {
  return { daemonTrustLevels: trustSettingsFromForm(form) };
}
