/**
 * Exponential backoff retry utility.
 * Retries up to maxAttempts times with delays: 500ms → 1000ms → 2000ms
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, onRetry } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Permanent errors — retrying will never help, throw immediately
      const msg = err instanceof Error ? err.message : String(err);
      const isPermanent =
        // GraphQL schema / validation errors
        msg.includes("Cannot query field") ||
        msg.includes("Unknown type") ||
        msg.includes("Unknown argument") ||
        (msg.includes("Field") && msg.includes("doesn't exist")) ||
        // Selection-shape errors — deterministic; the caller drops the field and retries.
        msg.includes("must have a selection") ||
        msg.includes("must not have a selection") ||
        // Server-side storage deserialization failure on a corrupt field value
        // (e.g. Kibo CMS RichText "fromStorage" choking on a non-object value).
        // Deterministic per the stored data — retrying re-reads the same bad value.
        msg.includes('"fromStorage"') ||
        // HTML response: the endpoint returned a web page instead of JSON.
        // No amount of retrying will fix a wrong URL or missing API route.
        msg.includes("<!DOCTYPE") ||
        msg.includes("is not valid JSON");
      if (isPermanent) throw err;

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 500, 1000, 2000
        if (onRetry) {
          onRetry(attempt, err);
        }
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
