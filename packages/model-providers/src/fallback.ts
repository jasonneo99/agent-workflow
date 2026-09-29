export type ModelAttemptFailure = {
  providerId: string;
  model: string;
  status: number | null;
  category: "funding" | "rate_limit" | "model_access" | "authentication" | "request" | "unknown";
  retryNextModel: boolean;
  message: string;
};

export class ModelCandidatesExhaustedError extends Error {
  readonly providerId: string;
  readonly attempts: ModelAttemptFailure[];
  readonly providerFallbackAllowed: boolean;

  constructor(providerId: string, attempts: ModelAttemptFailure[], cause?: unknown) {
    super(`${providerId} exhausted eligible model candidates (${attempts.map((attempt) => `${attempt.model}:${attempt.status ?? attempt.category}`).join(", ")}).`, { cause });
    this.name = "ModelCandidatesExhaustedError";
    this.providerId = providerId;
    this.attempts = attempts;
    this.providerFallbackAllowed = attempts.length > 0 && attempts.every((attempt) => attempt.retryNextModel);
  }
}

export function modelCandidatesExhaustedError(providerId: string, attempts: ModelAttemptFailure[], cause?: unknown): ModelCandidatesExhaustedError {
  return new ModelCandidatesExhaustedError(providerId, attempts, cause);
}

export function classifyModelAttemptFailure(error: unknown, providerId: string, model: string): ModelAttemptFailure {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; error?: { message?: unknown }; $metadata?: { httpStatusCode?: unknown } };
  const statusValue = candidate?.status ?? candidate?.statusCode ?? candidate?.$metadata?.httpStatusCode;
  const status = typeof statusValue === "number" ? statusValue : null;
  const rawMessage = [candidate?.message, candidate?.error?.message, candidate?.code]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join(" ");
  const normalized = rawMessage.toLowerCase();
  let category: ModelAttemptFailure["category"] = "unknown";
  let retryNextModel = false;

  if (status === 401 || /invalid api key|authentication|unauthorized/u.test(normalized)) {
    category = "authentication";
  } else if (status === 402 || /insufficient (?:funds|credits)|payment required|billing|credit balance/u.test(normalized)) {
    category = "funding";
    retryNextModel = true;
  } else if (status === 429 || /rate limit|quota/u.test(normalized)) {
    category = "rate_limit";
    retryNextModel = true;
  } else if (status === 403 || status === 404 || /model.*(?:not found|unavailable|not supported|access|permission)|does not have access/u.test(normalized)) {
    category = "model_access";
    retryNextModel = true;
  } else if (status === 400) {
    category = "request";
    retryNextModel = /model|capacity|region|tier|access/u.test(normalized);
  }

  return {
    providerId,
    model,
    status,
    category,
    retryNextModel,
    message: sanitizeProviderError(rawMessage || String(error))
  };
}

function sanitizeProviderError(value: string): string {
  return value
    .replace(/(?:sk|key|token|secret)[-_][a-z0-9_-]{8,}/giu, "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 500);
}
