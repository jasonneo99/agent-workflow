import { evaluateCandidate } from "./index.js";

let input = "";
for await (const chunk of process.stdin) input += String(chunk);
try {
  process.stdout.write(`${JSON.stringify(evaluateCandidate(JSON.parse(input)))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
