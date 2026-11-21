/**
 * Minimal unified diffs for Dev mode proposals.
 *
 * Agent edits are proposed, never applied directly: `buildUnifiedDiff`
 * renders the proposal, and Accept applies it per file or per hunk via
 * `applyDiffHunk` / `applyUnifiedDiff`, both of which verify the preimage
 * (context and removed lines must match the current file) before changing
 * anything. Line arrays keep a trailing "" element for content ending in a
 * newline, so joining reproduces the file byte-for-byte.
 */

export interface DiffLine {
  type: " " | "-" | "+";
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_LINES = 2000;

export function splitDiffLines(content: string): string[] {
  return content === "" ? [] : content.split("\n");
}

function joinDiffLines(lines: string[]): string {
  return lines.join("\n");
}

type EditOp = { kind: "equal" | "delete" | "insert"; text: string };

function diffLineOps(original: string[], proposed: string[]): EditOp[] {
  if (original.length > DIFF_MAX_LINES || proposed.length > DIFF_MAX_LINES) {
    // Whole-file replace for very large files: still a valid unified diff.
    return [
      ...original.map((text): EditOp => ({ kind: "delete", text })),
      ...proposed.map((text): EditOp => ({ kind: "insert", text }))
    ];
  }
  // LCS dynamic program over lines. Dev-turn files are small; the O(n*m)
  // table is bounded by DIFF_MAX_LINES.
  const rows = original.length + 1;
  const cols = proposed.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = original.length - 1; i >= 0; i -= 1) {
    for (let j = proposed.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        original[i] === proposed[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < original.length && j < proposed.length) {
    if (original[i] === proposed[j]) {
      ops.push({ kind: "equal", text: original[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "delete", text: original[i] });
      i += 1;
    } else {
      ops.push({ kind: "insert", text: proposed[j] });
      j += 1;
    }
  }
  while (i < original.length) {
    ops.push({ kind: "delete", text: original[i] });
    i += 1;
  }
  while (j < proposed.length) {
    ops.push({ kind: "insert", text: proposed[j] });
    j += 1;
  }
  return ops;
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function buildHunks(ops: EditOp[]): DiffHunk[] {
  // Group ops into hunks: a change plus DIFF_CONTEXT_LINES of context on
  // each side; merge hunks whose context would overlap.
  const changeIndexes = ops.map((op, index) => (op.kind === "equal" ? -1 : index)).filter((index) => index >= 0);
  if (!changeIndexes.length) return [];
  const groups: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(ops.length, index + DIFF_CONTEXT_LINES + 1);
    const last = groups.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      groups.push({ start, end });
    }
  }
  return groups.map((group) => {
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    let oldLine = 0;
    let newLine = 0;
    for (let index = 0; index < group.start; index += 1) {
      if (ops[index].kind !== "insert") oldLine += 1;
      if (ops[index].kind !== "delete") newLine += 1;
    }
    oldStart = oldLine + 1;
    newStart = newLine + 1;
    for (let index = group.start; index < group.end; index += 1) {
      const op = ops[index];
      if (op.kind === "equal") {
        lines.push({ type: " ", text: op.text });
        oldCount += 1;
        newCount += 1;
      } else if (op.kind === "delete") {
        lines.push({ type: "-", text: op.text });
        oldCount += 1;
      } else {
        lines.push({ type: "+", text: op.text });
        newCount += 1;
      }
    }
    // A hunk that only adds at the start of an empty file starts at line 0.
    const header = `@@ -${oldCount === 0 ? "0,0" : formatRange(oldStart, oldCount)} +${newCount === 0 ? "0,0" : formatRange(newStart, newCount)} @@`;
    return { header, oldStart: oldCount === 0 ? 0 : oldStart, oldCount, newStart: newCount === 0 ? 0 : newStart, newCount, lines };
  });
}

export function buildUnifiedDiff(path: string, original: string, proposed: string): string {
  if (original === proposed) return "";
  const ops = diffLineOps(splitDiffLines(original), splitDiffLines(proposed));
  const hunks = buildHunks(ops);
  const header = original === "" ? `--- /dev/null\n+++ b/${path}` : `--- a/${path}\n+++ b/${path}`;
  const body = hunks
    .map((hunk) => `${hunk.header}\n${hunk.lines.map((line) => `${line.type}${line.text}`).join("\n")}`)
    .join("\n");
  return `${header}\n${body}\n`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const rawLine of diffText.split("\n")) {
    const match = HUNK_HEADER.exec(rawLine);
    if (match) {
      current = {
        header: rawLine,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("\\")) continue;
    const type = rawLine[0];
    if (type === " " || type === "-" || type === "+") {
      current.lines.push({ type, text: rawLine.slice(1) });
    }
  }
  return hunks;
}

/** Apply one hunk to file content, verifying the preimage lines match. */
export function applyDiffHunk(original: string, hunk: DiffHunk): string {
  const lines = splitDiffLines(original);
  const startIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
  if (startIndex < 0 || startIndex > lines.length) {
    throw new Error(`Diff hunk starts outside the file: ${hunk.header}`);
  }
  let cursor = startIndex;
  for (const line of hunk.lines) {
    if (line.type === "+") continue;
    if (lines[cursor] !== line.text) {
      throw new Error(
        `Diff hunk does not apply cleanly at line ${cursor + 1}: expected ${JSON.stringify(line.text)}, found ${JSON.stringify(lines[cursor] ?? "")}.`
      );
    }
    cursor += 1;
  }
  if (cursor - startIndex !== hunk.oldCount) {
    throw new Error(`Diff hunk length mismatch: ${hunk.header}`);
  }
  const replacement = hunk.lines.filter((line) => line.type !== "-").map((line) => line.text);
  return joinDiffLines([...lines.slice(0, startIndex), ...replacement, ...lines.slice(startIndex + hunk.oldCount)]);
}

/** Apply every hunk in a unified diff, last hunk first so line numbers hold. */
export function applyUnifiedDiff(original: string, diffText: string): string {
  const hunks = parseDiffHunks(diffText);
  let content = original;
  for (const hunk of [...hunks].reverse()) {
    content = applyDiffHunk(content, hunk);
  }
  return content;
}
