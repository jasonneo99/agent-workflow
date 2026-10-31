# Scoped native PTY fixtures

Isolated commands deny writes outside their disposable scratch directory. Native
PTY allocation is also denied by default. A project may explicitly list exact
recipes in `actions.scoped_native_pty_commands`; this list grants no command
authority and never matches prefixes or wildcard patterns. The command still
needs its ordinary allowlist grant and passes every blocked-command check.

With write isolation enabled on macOS, only an exact listed recipe receives
write-data access to `/dev/ptmx` and its own dynamically allocated slave PTYs.
Slave access requires the kernel-issued `com.apple.sandbox.pty` extension as
well as a bounded device-name match. Other already-existing terminals receive
no write grant. Direct and descendant project/host file writes remain denied.
Other platforms still fail closed for isolated commands. No unsandboxed fallback
or arbitrary device path option exists.

The extension rule follows the operating system shipped application sandbox
profile. The regression exercises a real allocation, a separately pre-existing
PTY, direct and descendant foreign-file writes, and omitted/near recipe denial.

This is a native test capability, not installed product, deployment, or approval
authority. Source test success does not adopt a new runtime. Existing frozen
review policies and historical results retain their original meaning; runtime
adoption and same-run recovery must use the maintained integrity and recovery
paths.
