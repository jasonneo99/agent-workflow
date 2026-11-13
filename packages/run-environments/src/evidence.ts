import type { EnvironmentProfile } from "./schema.js";

/** Patterns select a test contract, never a command or permission to execute. */
export function verificationCommandMatches(command: string, pattern: string): boolean {
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'u').test(command);
}

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
    const status='(?:passed|failed|skipped|xfailed|xpassed|errors?|deselected)';
    const token=`\\d+ (?:${status}|warnings?|subtests ${status})`;
    const summaries = [...text.matchAll(new RegExp(`^(?:=+\\s*)?(${token}(?:, ${token})*) in [^\\r\\n]+?(?:\\s*=+)?$`,'gmu'))];
    if (summaries.length !== 1) return fail("Expected one complete pytest result summary.");
    const counts = [...summaries[0]![1]!.matchAll(new RegExp(`(\\d+) (subtests ${status}|${status}|warnings?)`,'gu'))]
      .map(item=>({count:Number(item[1]),kind:item[2]!.replace(/errors$/u,'error').replace(/warnings$/u,'warning')}));
    if (new Set(counts.map(item => item.kind)).size !== counts.length) return fail("Ambiguous pytest collection summary.");
    passed = counts.find(item => item.kind === "passed")?.count ?? 0;
    skipped = counts.find(item => item.kind === "skipped")?.count ?? 0;
    // Warnings and successful subtests never inflate primary test collection.
    cases = counts.filter(item=>item.kind!=='warning'&&!item.kind.startsWith('subtests ')).reduce((sum, item) => sum + item.count, 0);
    if (counts.some(item => !['passed','subtests passed','warning'].includes(item.kind) && item.count > 0)) return fail("Failed, skipped, deselected, or unverified pytest cases remain.", cases, passed, skipped);
  }
  if (cases < declaration.minimum_tests || passed !== cases || skipped !== 0 ||
      (declaration.expected_tests !== undefined && cases !== declaration.expected_tests)) {
    return fail("Required tests must execute and pass with zero skips and the declared collection size.", cases, passed, skipped);
  }
  return { status: "passed", cases, passed, skipped, reason: null };
}
