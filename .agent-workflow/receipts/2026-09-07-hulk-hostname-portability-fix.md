# Hulk hostname portability fix

- Date: 2026-09-07
- Actor: Jason Miller via Codex
- Triggering canary: `8f9b5882-afde-4aba-a15c-56fd7930759b`

The fallback test assumed its local execution host could never be named `hulk`.
That assumption fails when the complete suite is intentionally delegated to the
Hulk machine. The test now verifies the actual contract: fallback is explicitly
reported, the requested host remains Hulk, the execution host equals the real
local hostname, and the fallback output is preserved.

This changes test portability only. It does not relax fail-closed execution or
enable fallback in any fleet canary.
