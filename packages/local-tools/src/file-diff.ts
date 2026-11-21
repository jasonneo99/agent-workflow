/**
 * Minimal unified diffs for Dev mode proposals.
 *
 * Agent edits are proposed, never applied directly: `buildUnifiedDiff`
 * renders the proposal, and Accept applies it per file or per hunk via
 * `applyDiffHunk` / `applyUnifiedDiff`, both of which verify the preimage
 * (context and removed lines must match the current file) before changing
 * anything.
 *
 * Line model: diffs are built in the same model as the repo's
 * `applyUnifiedPatch` — a trailing newline terminates the last line rather
 * than starting an empty one — so proposal diffs round-trip through the
 * repo's patch tools. A final line that lacks its trailing newline is
 * marked with the standard "\ No newline at end of file" marker, so
 * apply/invert reproduce it exactly. `applyDiffHunk` itself splits content
 * keeping a trailing "" element, which always sits outside every hunk
 * range, so the file's trailing newline survives application unchanged.
 * The one gap this leaves: a change that ONLY adds or removes a trailing
 * newline on an otherwise unchanged last line produces no diff and is
 * reported as no change.
 */

export interface DiffLine {
  type: " " | "-" | "+";
  text: string;
  /**
   * "\ No newline at end of file" for this line: for '+' lines the new side
   * lacks a trailing newline, for '-' lines the old side does, and for ' '
   * lines both sides do. A shared last line whose two sides disagree on the
   * trailing newline is not marked (that difference alone produces no diff).
   */
  noNewline?: boolean;
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

/** Lines in the repo patch model: a trailing newline terminates the last line. */
export function splitPatchLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
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

function buildHunks(ops: EditOp[], originalEndsWithNewline: boolean, proposedEndsWithNewline: boolean): DiffHunk[] {
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
    // A hunk reaching the end of the file marks a final line that lacks its
    // trailing newline, so apply/invert reproduce it exactly.
    if (group.end === ops.length) {
      const lastOld = [...lines].reverse().find((line) => line.type === " " || line.type === "-");
      const lastNew = [...lines].reverse().find((line) => line.type === " " || line.type === "+");
      if (lastOld?.type === "-" && !originalEndsWithNewline) lastOld.noNewline = true;
      if (lastNew?.type === "+" && !proposedEndsWithNewline) lastNew.noNewline = true;
      if (lastOld === lastNew && lastOld?.type === " " && !originalEndsWithNewline && !proposedEndsWithNewline) {
        lastOld.noNewline = true;
      }
    }
    // A hunk that only adds at the start of an empty file starts at line 0.
    const header = `@@ -${oldCount === 0 ? "0,0" : formatRange(oldStart, oldCount)} +${newCount === 0 ? "0,0" : formatRange(newStart, newCount)} @@`;
    return { header, oldStart: oldCount === 0 ? 0 : oldStart, oldCount, newStart: newCount === 0 ? 0 : newStart, newCount, lines };
  });
}

export function buildUnifiedDiff(path: string, original: string, proposed: string): string {
  if (original === proposed) return "";
  const ops = diffLineOps(splitPatchLines(original), splitPatchLines(proposed));
  const hunks = buildHunks(ops, original.endsWith("\n") || original === "", proposed.endsWith("\n") || proposed === "");
  const header = original === "" ? `--- /dev/null\n+++ b/${path}` : `--- a/${path}\n+++ b/${path}`;
  const body = hunks
    .map((hunk) => `${hunk.header}\n${hunk.lines.map((line) => `${line.type}${line.text}${line.noNewline ? "\n\\ No newline at end of file" : ""}`).join("\n")}`)
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
    if (rawLine.startsWith("\\")) {
      const previous = current.lines.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
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
  let result = joinDiffLines([...lines.slice(0, startIndex), ...replacement, ...lines.slice(startIndex + hunk.oldCount)]);
  // A hunk reaching the end of the file decides the result's trailing
  // newline: an added final line without a marker means the new file ends
  // with a newline; a marked one means it does not. A context final line
  // keeps the original's trailing newline.
  const hasTrailingNewline = original.endsWith("\n");
  const realLines = hasTrailingNewline ? lines.length - 1 : lines.length;
  if (startIndex + hunk.oldCount >= realLines) {
    const lastNew = [...hunk.lines].reverse().find((line) => line.type === " " || line.type === "+");
    if (lastNew) {
      const newHasTrailing = lastNew.type === "+" ? lastNew.noNewline !== true : lastNew.noNewline === true ? false : hasTrailingNewline;
      if (newHasTrailing && result !== "" && !result.endsWith("\n")) result += "\n";
      if (!newHasTrailing && result.endsWith("\n")) result = result.slice(0, -1);
    }
  }
  return result;
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

/**
 * Recover the preimage of a unified diff: apply every hunk backwards, last
 * hunk first, verifying the new-side lines match. The exact inverse of
 * applyUnifiedDiff for diffs built by buildUnifiedDiff, including new-file
 * diffs (whose preimage is the empty string).
 */
export function invertUnifiedDiff(proposed: string, diffText: string): string {
  const hunks = parseDiffHunks(diffText);
  const lines = splitDiffLines(proposed);
  for (const hunk of [...hunks].reverse()) {
    const startIndex = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (startIndex < 0 || startIndex > lines.length) {
      throw new Error(`Diff hunk starts outside the file: ${hunk.header}`);
    }
    const newSide = hunk.lines.filter((line) => line.type !== "-").map((line) => line.text);
    const oldSide = hunk.lines.filter((line) => line.type !== "+").map((line) => line.text);
    for (const [offset, text] of newSide.entries()) {
      if (lines[startIndex + offset] !== text) {
        throw new Error(
          `Diff hunk does not invert cleanly at line ${startIndex + offset + 1}: expected ${JSON.stringify(text)}, found ${JSON.stringify(lines[startIndex + offset] ?? "")}.`
        );
      }
    }
    if (newSide.length !== hunk.newCount) {
      throw new Error(`Diff hunk length mismatch: ${hunk.header}`);
    }
    // EOF state of the working content before this hunk is inverted.
    const workingHasTrailingNewline = lines.length > 0 && lines.at(-1) === "";
    const realLines = workingHasTrailingNewline ? lines.length - 1 : lines.length;
    const reachesEnd = startIndex + hunk.newCount >= realLines;
    lines.splice(startIndex, newSide.length, ...oldSide);
    if (reachesEnd) {
      const lastOld = [...hunk.lines].reverse().find((line) => line.type === " " || line.type === "-");
      if (lastOld) {
        const oldHasTrailing = lastOld.type === "-" ? lastOld.noNewline !== true : lastOld.noNewline === true ? false : workingHasTrailingNewline;
        if (oldHasTrailing && lines.length > 0 && lines.at(-1) !== "") lines.push("");
        if (!oldHasTrailing && lines.length > 0 && lines.at(-1) === "") lines.pop();
      }
    }
  }
  return joinDiffLines(lines);
}
