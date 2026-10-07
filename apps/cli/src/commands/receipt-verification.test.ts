import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("verify-receipts actual CLI handler returns failure for invalid JSON and text results", async () => {
  const source = ts.createSourceFile("system.ts", readFileSync(new URL("./system.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let handler: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "action" && node.expression.expression.getText(source).includes('.command("verify-receipts")')) {
      handler = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler, "production CLI action exists");
  const js = ts.transpile(`(${handler.getText(source)})`, { target: ts.ScriptTarget.ES2022 });
  for (const valid of [true, false]) for (const json of [true, false]) {
    const runtime = { exitCode: 0 };
    const output: string[] = [];
    const action = new Function("verifyRunReceiptChain", "process", "console", `return ${js}`)(
      async () => ({ valid, checked: valid ? 1 : 0, brokenAt: valid ? undefined : 0, reason: valid ? undefined : "synthetic failure" }),
      runtime, { log: (text: string) => output.push(text), error: (text: string) => output.push(text) },
    );
    await action({ run: "synthetic-run", json });
    assert.equal(runtime.exitCode, valid ? 0 : 1);
    if (json) assert.equal(JSON.parse(output[0]).valid, valid);
  }
});
