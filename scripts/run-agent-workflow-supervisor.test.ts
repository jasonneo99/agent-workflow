import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./run-agent-workflow-supervisor.sh", import.meta.url), "utf8");

test("supervisor can load OTLP authorization from a named macOS Keychain item", () => {
  assert.match(source, /AGENTFLOW_OTEL_AUTHORIZATION_KEYCHAIN_SERVICE/u);
  assert.match(source, /find-generic-password -a "\$otel_keychain_account" -s "\$otel_keychain_service" -w/u);
  assert.match(source, /export OTEL_EXPORTER_OTLP_HEADERS="Authorization=\$otel_authorization"/u);
  assert.match(source, /unset otel_authorization/u);
});

test("supervisor leaves Keychain untouched unless a service is configured", () => {
  assert.match(source, /if \[\[ -n "\$otel_keychain_service" \]\]; then/u);
});
