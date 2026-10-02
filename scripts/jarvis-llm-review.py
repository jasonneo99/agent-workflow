#!/usr/bin/env python3
"""Nightly LLM code review for Jarvis, routed through Agent Workflow architects.

Runs on loki (where the agentflow CLI lives). Each night:
  1. Selects up to 5 Python files from the Jarvis codebase on the jarvis host,
     rotating via a state file so the whole codebase gets covered over time.
  2. Reviews each file with the `code-review` workflow (technical-architect
     agent) via `agentflow run-and-watch`.
  3. Converts findings to dashboard proposals in the jarvis learnings DB
     (medium/high risk, never auto-applied), deduplicated by opportunity_id.

Schedule: launchd com.jarvis.llm-review, daily 4:00 AM on loki.
Bounds: max 5 files/night, ~8k tokens input per file (truncated with note).
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

REPO = Path("/Users/jasonmiller/Projects/Agent Workflow")
PROJECT_DIR = Path.home() / "jarvis-llm-review"
STATE_PATH = Path.home() / ".config" / "jarvis-llm-review" / "state.json"
JARVIS_APP_DIR = "/Users/jasonmiller/Library/Application Support/Jarvis"
MAX_FILES = 5
MAX_CHARS_PER_FILE = 32000  # ~8k tokens
REVIEW_DAYS = 30  # don't re-review unmodified files within this window

# Files the AST scanner already covers well; skip backup noise.
EXCLUDE_RES = [
    re.compile(r"\.bak$"), re.compile(r"~$"), re.compile(r"__pycache__"),
    re.compile(r"^fan-telemetry-backup/"), re.compile(r"^backups/"),
    re.compile(r"/venv/"),
]

FINDING_RE = re.compile(
    r"\[(?P<category>[a-z_]+)\]\s+(?P<file>[^\s:]+\.py):(?P<line>\d+)\s+"
    r"[\u2014\u2013-]\s*(?P<title>.+?)\s+[\u2014\u2013-]\s*confidence:(?P<confidence>high|medium|low)\s+"
    r"Issue:\s*(?P<issue>.+?)\s+Fix:\s*(?P<fix>.+?)\s+Impact:\s*(?P<impact>.+)",
    re.DOTALL,
)

HIGH_RISK_CATEGORIES = {"concurrency_correctness"}


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ssh_jarvis(cmd):
    r = sh(["ssh", "-o", "ConnectTimeout=10", "jarvis", cmd])
    if r.returncode != 0:
        raise RuntimeError("jarvis ssh failed: %s" % r.stderr.strip()[:200])
    return r.stdout


def load_state():
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {"files": {}}


def save_state(state):
    STATE_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=1))
    try:
        STATE_PATH.chmod(0o600)
    except OSError:
        pass


def get_jarvis_files():
    """List candidate .py files on the jarvis host: path, bytes, mtime."""
    probe = (
        "import json,os; "
        "d='/Users/jasonmiller/Library/Application Support/Jarvis'; "
        "rows=[{'path': f, 'size': os.path.getsize(d+'/'+f), "
        "'mtime': os.path.getmtime(d+'/'+f)} "
        "for f in sorted(os.listdir(d)) if f.endswith('.py')]; "
        "print(json.dumps(rows))"
    )
    out = ssh_jarvis(
        '"/Users/jasonmiller/Library/Application Support/Jarvis/venv/bin/python3" -c "%s"' % probe
    )
    files = []
    for f in json.loads(out):
        rel = f["path"]
        if any(rx.search(rel) for rx in EXCLUDE_RES):
            continue
        files.append({"path": rel, "size": f["size"], "mtime": f["mtime"]})
    return files


def select_files(files, state):
    now = time.time()
    scored = []
    for f in files:
        rec = state["files"].get(f["path"])
        if rec and rec.get("hash") == file_hash_hint(f) and now - rec.get("reviewed_at", 0) < REVIEW_DAYS * 86400:
            continue  # reviewed recently and unmodified
        recency_boost = 1.0 + min(30, (now - f["mtime"]) / 86400) / 30.0
        score = f["size"] * recency_boost
        scored.append((score, f))
    scored.sort(reverse=True)
    return [f for _, f in scored[:MAX_FILES]]


def file_hash_hint(f):
    # mtime+size as a cheap change detector (full hash after sync)
    return "%d:%d" % (f["size"], int(f["mtime"]))


def sync_files(files):
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    proj = PROJECT_DIR / ".agent-workflow"
    proj.mkdir(exist_ok=True)
    (proj / "project.yaml").write_text(
        "project:\n  name: jarvis-review\n"
        "  summary: Nightly LLM code review staging for Jarvis codebase files.\n"
        "  autonomy: 2\ncontext:\n  include:\n    - '*.py'\npolicy:\n  profile: local\n"
    )
    synced = []
    for f in files:
        dest = PROJECT_DIR / f["path"]
        r = sh(["scp", "-q", "-o", "ConnectTimeout=10",
                "jarvis:%s/%s" % (JARVIS_APP_DIR, f["path"]), str(dest)])
        if r.returncode != 0:
            print("sync failed for %s: %s" % (f["path"], r.stderr.strip()[:150]), file=sys.stderr)
            continue
        synced.append(f)
    return synced


def file_content_truncated(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    if len(text) > MAX_CHARS_PER_FILE:
        return text[:MAX_CHARS_PER_FILE] + "\n\n[NOTE: file truncated for review; %d chars omitted]" % (len(text) - MAX_CHARS_PER_FILE)
    return text


def run_review(rel_path, content):
    """Queue and watch one code-review run; return (run_id, findings_text)."""
    task = ("Review the file %s for optimizations and risks. "
            "File content follows.\n---\n%s" % (rel_path, content))
    r = sh([
        "npx", "tsx", "apps/cli/src/index.ts", "run-and-watch", "code-review",
        "-p", str(PROJECT_DIR), "--skip-index", "-t", task,
        "--timeout-ms", "600000",
    ], cwd=str(REPO))
    out = r.stdout + r.stderr
    m = re.search(r"workflow_runs/([0-9a-f-]{36})", out)
    if not m:
        print("no run id found for %s" % rel_path, file=sys.stderr)
        return None, ""
    run_id = m.group(1)
    return run_id, out


def fetch_findings(run_id):
    r = sh([
        "npx", "tsx", "apps/cli/src/index.ts", "status",
        "-r", run_id, "--artifacts", "--json",
    ], cwd=str(REPO))
    try:
        data = json.loads(r.stdout)
    except Exception as e:
        print("status json parse failed for %s: %s" % (run_id, e), file=sys.stderr)
        return []
    findings = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "findings" and isinstance(v, list):
                    findings.extend(str(x) for x in v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(data)
    return findings


def parse_findings(raw_list):
    parsed = []
    for raw in raw_list:
        for m in FINDING_RE.finditer(raw):
            d = m.groupdict()
            parsed.append({
                "category": d["category"],
                "file": d["file"],
                "line": int(d["line"]),
                "title": d["title"].strip(),
                "confidence": d["confidence"],
                "issue": d["issue"].strip(),
                "fix": d["fix"].strip(),
                "impact": d["impact"].strip(),
            })
    # drop low-confidence (prompt asks for med/high only; belt and suspenders)
    return [p for p in parsed if p["confidence"] in ("high", "medium")]


def opportunity_id(p):
    h = hashlib.sha256(("%s:%d:%s" % (p["file"], p["line"], p["title"])).encode()).hexdigest()[:16]
    return "v1:llm_review:%s" % h


def write_proposals(proposals):
    """Insert proposals into the jarvis DB over ssh, deduplicated."""
    if not proposals:
        return 0
    # Pipe JSON to the helper on the jarvis host via stdin.
    remote_cmd = (
        '"/Users/jasonmiller/Library/Application Support/Jarvis/venv/bin/python3" '
        '"/Users/jasonmiller/Library/Application Support/Jarvis/jarvis_proposal_insert.py"'
    )
    ssh_proc = subprocess.Popen(
        ["ssh", "-o", "ConnectTimeout=10", "jarvis", remote_cmd],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )
    out, err = ssh_proc.communicate(json.dumps(proposals), timeout=60)
    m = re.search(r"inserted (\d+)", out)
    if not m:
        print("proposal insert failed: %s" % err.strip()[:200], file=sys.stderr)
        return 0
    return int(m.group(1))


def log_activity(detail):
    try:
        inner = (
            'import os; from jarvis_learning_db import LearningDB; '
            'LearningDB().log_activity("learn", "llm_review", os.environ["LLM_DETAIL"])'
        )
        cmd = (
            "cd '/Users/jasonmiller/Library/Application Support/Jarvis' && "
            'LLM_DETAIL=%s ./venv/bin/python3 -c "%s"' % (shlex.quote(detail), inner)
        )
        ssh_jarvis(cmd)
    except Exception as e:
        print('activity log failed: %s' % e, file=sys.stderr)


def main():
    t0 = time.time()
    state = load_state()
    files = get_jarvis_files()
    selected = select_files(files, state)
    if not selected:
        print("nothing to review (all recently covered)")
        return 0
    print("selected: %s" % ", ".join(f["path"] for f in selected))
    synced = sync_files(selected)
    all_proposals = []
    reviewed = []
    for f in synced:
        content = file_content_truncated(str(PROJECT_DIR / f["path"]))
        run_id, _out = run_review(f["path"], content)
        if not run_id:
            continue
        raw = fetch_findings(run_id)
        parsed = parse_findings(raw)
        print("%s: run %s, %d raw findings, %d parsed" % (f["path"], run_id[:8], len(raw), len(parsed)))
        for p in parsed:
            risk = "high" if p["category"] in HIGH_RISK_CATEGORIES else "medium"
            desc = ("[%s] %s:%d — %s (confidence: %s)\nIssue: %s\nFix sketch: %s\nEstimated impact: %s"
                    % (p["category"], p["file"], p["line"], p["title"],
                       p["confidence"], p["issue"], p["fix"], p["impact"]))
            all_proposals.append({
                "opportunity_id": opportunity_id(p),
                "risk": risk,
                "description": desc,
            })
        # record rotation state with content hash
        h = hashlib.sha256(Path(PROJECT_DIR / f["path"]).read_bytes()).hexdigest()[:16]
        state["files"][f["path"]] = {"hash": h, "reviewed_at": time.time()}
        reviewed.append(f["path"])
    save_state(state)
    inserted = write_proposals(all_proposals)
    mins = (time.time() - t0) / 60
    log_activity("LLM review: %d files reviewed (%s), %d findings -> %d new proposals in %.1f min"
                 % (len(reviewed), ",".join(reviewed), len(all_proposals), inserted, mins))
    print("done: %d files, %d findings, %d new proposals" % (len(reviewed), len(all_proposals), inserted))
    return 0


if __name__ == "__main__":
    sys.exit(main())
