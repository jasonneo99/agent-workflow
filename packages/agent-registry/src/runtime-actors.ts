import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import ts from 'typescript';

export interface RuntimeReceiptActorReference { agentId: string; sourcePath: string; line: number; writer: 'appendActionReceipt' | 'recordRunAction' }

function propertyName(node: ts.PropertyName): string | null {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

function literalAgentId(object: ts.ObjectLiteralExpression): string | null {
  const property = object.properties.find(candidate => ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === 'agentId');
  if (!property || !ts.isPropertyAssignment(property)) return null;
  return ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer) ? property.initializer.text : null;
}

export async function runtimeReceiptActorReferences(rootDir: string): Promise<RuntimeReceiptActorReference[]> {
  const files = await glob(['packages/**/*.ts', 'apps/**/*.ts'], { cwd: rootDir, absolute: true, nodir: true, ignore: ['**/*.test.ts', '**/*.integration.test.ts', '**/*.d.ts', '**/dist/**', '**/node_modules/**'] });
  const references: RuntimeReceiptActorReference[] = [];
  for (const file of files.sort()) {
    const source = await fs.readFile(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'appendActionReceipt' || node.expression.text === 'recordRunAction')) {
        const writer = node.expression.text;
        const argument = node.arguments[writer === 'appendActionReceipt' ? 1 : 0];
        if (argument && ts.isObjectLiteralExpression(argument)) {
          const agentId = literalAgentId(argument);
          if (agentId) references.push({ agentId, sourcePath: path.relative(rootDir, file), line: ast.getLineAndCharacterOfPosition(argument.getStart(ast)).line + 1, writer });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return references;
}

export function missingRuntimeReceiptActors(references: readonly RuntimeReceiptActorReference[], registeredAgentIds: ReadonlySet<string>) {
  return references.filter(reference => !registeredAgentIds.has(reference.agentId));
}
