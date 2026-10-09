#!/usr/bin/env python3
"""Bridge: deliver an Agent Workflow requester notification.

Reads one notification JSON object from stdin (as produced by the
`run_notifications` outbox):
    {"notificationId": ..., "runId": ..., "kind": ..., "title": ..., "body": ...}

Delivery, in order:
  1. Optional phone push via POST /mobile/notify -- only when the relay URL
     and AGENTFLOW_SERVER_TOKEN are set in this process's environment.
  2. macOS Notification Center on this Mac -- always available, no secrets.

Exits 0 when at least one backend reports delivery, 1 otherwise.
Never prints secrets.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

# Phone-push backend is opt-in: set AGENTFLOW_PUSH_RELAY_BASE_URL to your push
# relay's base URL (it must expose POST /mobile/notify). No default is baked
# in — private infrastructure endpoints do not belong in the open-source tree.
PUSH_RELAY_BASE_URL = os.environ.get("AGENTFLOW_PUSH_RELAY_BASE_URL", "").strip().rstrip("/")

# Optional installed app identity for local branding. Keep private app selection
# in the caller's runtime configuration; unset uses the notifier's default icon.
NOTIFICATION_SENDER_BUNDLE_ID = os.environ.get(
    "AGENTFLOW_NOTIFICATION_SENDER_BUNDLE_ID", ""
).strip()

_TERMINAL_NOTIFIER_CANDIDATES = (
    os.path.expanduser("~/.local/bin/terminal-notifier"),
    "/usr/local/bin/terminal-notifier",
    "/opt/homebrew/bin/terminal-notifier",
)


def _terminal_notifier_path():
    for _p in _TERMINAL_NOTIFIER_CANDIDATES:
        if os.path.isfile(_p) and os.access(_p, os.X_OK):
            return _p
    return None


def _applescript_safe(text):
    # AppleScript string literals do NOT process backslash escapes: a
    # literal double-quote terminates the string and breaks the script
    # (json-style \" escaping does NOT work). Swap for single quotes.
    return text.replace('"', "'").replace("\r", " ").replace("\n", " ")


def send_relay_push(title: str, body: str) -> bool:
    token = os.environ.get("AGENTFLOW_SERVER_TOKEN", "").strip()
    if not token or not PUSH_RELAY_BASE_URL:
        return False
    payload = {
        "title": f"Agent Workflow: {title}"[:100],
        "body": body[:1000],
        "category": "agent-workflow.notification",
        "severity": "warning",
        "source": "agent-workflow",
    }
    try:
        request = urllib.request.Request(
            PUSH_RELAY_BASE_URL + "/mobile/notify",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status == 200
    except Exception:
        return False


def send_macos_notification(title: str, body: str) -> bool:
    # Preferred: terminal-notifier, optionally attributed to a configured app.
    tn = _terminal_notifier_path()
    if tn:
        try:
            result = subprocess.run(
                [tn, *(["-sender", NOTIFICATION_SENDER_BUNDLE_ID]
                       if NOTIFICATION_SENDER_BUNDLE_ID else []),
                 "-title", "Agent Workflow",
                 "-subtitle", title[:100],
                 "-message", body[:500]],
                capture_output=True,
                timeout=15,
            )
            if result.returncode == 0:
                return True
        except Exception:
            pass
    # Fallback: osascript (shows the generic script icon).
    safe_title = _applescript_safe(title)[:120]
    safe_body = _applescript_safe(body)[:400]
    script = (
        f'display notification "{safe_body}" '
        f'with title "Agent Workflow" subtitle "{safe_title}"'
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            timeout=15,
        )
        return result.returncode == 0
    except Exception:
        return False


LOG_PATH = os.path.expanduser("~/.agent-workflow/notify-bridge.log")

def _log(line):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass

def main() -> int:
    try:
        raw = sys.stdin.read()
        notification = json.loads(raw) if raw.strip() else {}
    except Exception:
        notification = {}
    # Log metadata only — never the body, which may contain project context.
    _log(json.dumps({"ts": __import__("time").time(), "received": {
        "id": notification.get("id"),
        "kind": notification.get("kind"),
        "title": str(notification.get("title", ""))[:80],
    }}))
    title = str(notification.get("title", "Notification")).strip() or "Notification"
    body = str(notification.get("body", "")).strip()

    push_ok = send_relay_push(title, body)
    macos_ok = send_macos_notification(title, body)
    delivered = push_ok or macos_ok
    _log(json.dumps({"ts": __import__("time").time(), "delivered": delivered,
                     "push": push_ok, "macos": macos_ok}))
    return 0 if delivered else 1


if __name__ == "__main__":
    sys.exit(main())
