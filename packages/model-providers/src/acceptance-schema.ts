import type { StructuredAcceptanceContract } from "./types.js";

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object", additionalProperties: false, properties, required: Object.keys(properties)
});

/** Validate transport claims without coercion; storage remains the evidence authority. */
export function acceptanceContractShapeError(value: unknown, contract: StructuredAcceptanceContract): string | null {
  const validate = (candidate: unknown, schema: Schema, location: string): string | null => {
    if (Array.isArray(schema.anyOf)) {
      return schema.anyOf.some((branch) => validate(candidate, branch as Schema, location) === null)
        ? null : `${location} does not match an acceptance schema deliverable`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(candidate)) return `${location} has an invalid acceptance schema value`;
    if (schema.type === "array") {
      if (!Array.isArray(candidate)) return `${location} must be an array`;
      for (let index = 0; index < candidate.length; index += 1) {
        const error = validate(candidate[index], schema.items as Schema, `${location}[${index}]`);
        if (error) return error;
      }
    } else if (schema.type === "object") {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return `${location} must be an object`;
      const record = candidate as Record<string, unknown>;
      const properties = schema.properties as Record<string, Schema>;
      for (const key of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) return `${location}.${key} is required by the acceptance schema`;
      }
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${location} contains an unknown acceptance schema property`;
        const error = validate(record[key], properties[key], `${location}.${key}`);
        if (error) return error;
      }
    } else if (typeof candidate !== schema.type) {
      return `${location} has an invalid acceptance schema type`;
    }
    return null;
  };
  return validate(value, acceptanceContractSchema(contract), "acceptanceContract");
}

const text = { type: "string" };
const strings = { type: "array", items: text };
const literal = (value: string | number | boolean): Schema => ({ type: typeof value, enum: [value] });
const gates = ["implementation", "verification", "packaging", "supervision"];

/** Transport schema only. Storage still resolves and validates every evidence claim. */
export function acceptanceContractSchema(contract: StructuredAcceptanceContract): Schema {
  const reference = object(Object.fromEntries([
    "artifactUri", "runId", "taskId", "stageId", "contentHash", "observedAt", "subjectHash"
  ].map((key) => [key, text])));
  const referenceProperties = reference.properties as Record<string, Schema>;
  referenceProperties.kind = { type: "string", enum: ["file_write", "command_output", "acceptance_audit"] };
  (reference.required as string[]).push("kind");
  return object({
    ...(contract.sourcePaths ? { sourcePaths: { type: "array", items: { type: "string", enum: contract.sourcePaths } } } : {}),
    version: literal(contract.version), contractId: literal(contract.contractId),
    projectId: literal(contract.projectId), originRunId: literal(contract.originRunId),
    taskHash: literal(contract.taskHash), subjectHash: literal(contract.subjectHash),
    deliverables: { type: "array", items: { anyOf: contract.deliverables.map((item) => object({
      id: literal(item.id), description: literal(item.description),
      ...(item.advisory === undefined ? {} : { advisory: literal(item.advisory) }),
      ...(item.severity === undefined ? {} : { severity: literal(item.severity) }),
      // Structured-output providers support scalar enums, not array-valued enums.
      // Exact membership and order remain frozen by the storage evaluator.
      requiredGates: { type: "array", items: { type: "string", enum: item.requiredGates } },
      status: { type: "string", enum: ["pending", "delivered", "verified", "failed", "blocked"] },
      receipts: object(Object.fromEntries(gates.map((gate) => [gate, { type: "array", items: reference }]))),
      gaps: strings
    })) } }
  });
}
