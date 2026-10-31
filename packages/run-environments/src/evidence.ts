import type { EnvironmentProfile } from "./schema.js";

export interface TestEvidence {
  status: "passed" | "failed";
  cases: number | null;
  passed: number | null;
  skipped: number | null;
  reason: string | null;
}

export function testEvidence(
  result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; outputTruncated?: boolean },
  declaration: EnvironmentProfile["verification"][number]
): TestEvidence {
  const fail = (reason: string, cases: number | null = null, passed: number | null = null, skipped: number | null = null): TestEvidence =>
    ({ status: "failed", cases, passed, skipped, reason });
  if (result.exitCode !== 0 || result.timedOut) return fail("The test process failed or timed out.");
  if (result.outputTruncated) return fail("Test output was truncated; complete collection is unproven.");
  const text = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/gu, "").replaceAll("\r\n", "\n");
  let cases: number, passed: number, skipped: number;
  if (declaration.format === "node-test") {
    const count = (label: string) => {
      const matches = [...text.matchAll(new RegExp(`^(?:#|ℹ) ${label} (\\d+)\\s*$`, "gmu"))];
      return matches.length === 1 ? Number(matches[0]![1]) : null;
    };
    const total = count("tests"), pass = count("pass"), skip = count("skipped");
    if (total === null || pass === null || skip === null || count("fail") !== 0 || count("cancelled") !== 0 || count("todo") !== 0) {
      return fail("Expected one complete successful Node test summary.", total, pass, skip);
    }
    cases = total; passed = pass; skipped = skip;
  } else if (declaration.format === "unittest") {
    const counts = [...text.matchAll(/^Ran (\d+) tests? in [^\r\n]+$/gmu)];
    const outcomes = [...text.matchAll(/^OK(?: \(([^\r\n]*)\))?\s*$/gmu)];
    if (counts.length !== 1 || outcomes.length !== 1 || /expected failures|unexpected successes|^FAILED|^ERROR:/mu.test(text)) {
      return fail("Expected one complete successful unittest summary.");
    }
    cases = Number(counts[0]![1]);
    skipped = Number(/(?:^|[, ])skipped=(\d+)/u.exec(outcomes[0]![1] ?? "")?.[1] ?? 0);
    passed = cases - skipped;
  } else {
    const summaries = [...text.matchAll(/^(?:=+\s*)?((?:\d+ (?:passed|failed|skipped|xfailed|xpassed|errors?|deselected)(?:, )?)+) in [^\r\n]+?(?:\s*=+)?$/gmu)];
    if (summaries.length !== 1) return fail("Expected one complete pytest result summary.");
    const counts = [...summaries[0]![1]!.matchAll(/(\d+) (passed|failed|skipped|xfailed|xpassed|errors?|deselected)/gu)];
    if (new Set(counts.map(item => item[2])).size !== counts.length) return fail("Ambiguous pytest collection summary.");
    passed = Number(counts.find(item => item[2] === "passed")?.[1] ?? 0);
    skipped = Number(counts.find(item => item[2] === "skipped")?.[1] ?? 0);
    cases = counts.reduce((sum, item) => sum + Number(item[1]), 0);
    if (counts.some(item => !["passed", "skipped"].includes(item[2]!) && Number(item[1]) > 0)) return fail("Failed, deselected, or unverified pytest cases remain.", cases, passed, skipped);
  }
  if (cases < declaration.minimum_tests || passed !== cases || skipped !== 0 ||
      (declaration.expected_tests !== undefined && cases !== declaration.expected_tests)) {
    return fail("Required tests must execute and pass with zero skips and the declared collection size.", cases, passed, skipped);
  }
  return { status: "passed", cases, passed, skipped, reason: null };
}
