/**
 * Generic GraphQL client for Kibo CMS APIs.
 *
 * Features:
 *  - Kibo CMS-specific headers: x-i18n-locale, x-tenant, Bearer auth
 *  - Optional rate limiting: sleeps N ms after every request (RATE_LIMIT_DELAY_MS)
 *  - Optional debug logging: prints op name, variables summary, timing, errors
 *  - Retry on network errors / 5xx with exponential backoff
 *  - Permanent schema errors (unknown field/type/arg) are NOT retried
 */

import { withRetry, sleep, RetryOptions } from "./retry";

export interface GraphQLClientOptions {
  url: string;
  apiKey: string;
  locale: string;
  tenant?: string;
  /** Base inter-request delay (ms). Adaptive throttling climbs from here. Default: 0. */
  rateLimit?: number;
  /** Ceiling for the adaptive throttle (ms). Default: 10000. */
  maxRateLimit?: number;
  /** When true, prints op name, variable summary, timing and errors to stdout. */
  debug?: boolean;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export class GraphQLError extends Error {
  constructor(
    message: string,
    public readonly errors: Array<{ message: string }>
  ) {
    super(message);
    this.name = "GraphQLError";
  }
}

export class GraphQLClient {
  private url: string;
  private headers: Record<string, string>;
  private debug: boolean;

  // ── Adaptive, per-tenant throttle ──────────────────────────────────────────
  // Each client is bound to one environment+tenant, so this state is per-tenant.
  // currentDelay is the inter-request pause; it climbs when the server signals
  // rate limiting (HTTP 429 / "rate limit" errors) and decays on sustained
  // success, so a big migration self-tunes instead of tripping Kibo's limits.
  private baseDelay: number;
  private currentDelay: number;
  private maxDelay: number;
  private successStreak = 0;

  constructor(options: GraphQLClientOptions) {
    this.url = options.url;
    this.baseDelay = options.rateLimit ?? 0;
    this.currentDelay = this.baseDelay;
    this.maxDelay = options.maxRateLimit ?? 10_000;
    this.debug = options.debug ?? false;
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      "x-i18n-locale": options.locale,
      "x-tenant": options.tenant ?? "root",
    };
  }

  /** Current adaptive inter-request delay (ms) — exposed for metrics/telemetry. */
  get throttleMs(): number {
    return this.currentDelay;
  }

  private async throttle(): Promise<void> {
    if (this.currentDelay > 0) await sleep(this.currentDelay);
  }

  /** Server signalled rate limiting — back off hard. Honor Retry-After if given. */
  private onRateLimited(retryAfterMs?: number): void {
    this.successStreak = 0;
    const bumped = Math.max(this.baseDelay, this.currentDelay) * 2 + 250;
    this.currentDelay = Math.min(this.maxDelay, Math.max(bumped, retryAfterMs ?? 0));
    if (this.debug) console.log(`  [throttle] rate-limited → delay ${this.currentDelay}ms`);
  }

  /** A request succeeded — decay the delay back toward the base after a streak. */
  private onSuccess(): void {
    if (this.currentDelay <= this.baseDelay) return;
    if (++this.successStreak >= 5) {
      this.successStreak = 0;
      this.currentDelay = Math.max(this.baseDelay, Math.floor(this.currentDelay * 0.7));
      if (this.debug) console.log(`  [throttle] cooling → delay ${this.currentDelay}ms`);
    }
  }

  /**
   * Verify the endpoint responds as a GraphQL API.
   * Throws a descriptive error if the URL is wrong or the API key is rejected.
   */
  async ping(): Promise<void> {
    try {
      await this.request<{ __typename: string }>(`{ __typename }`, undefined, { maxAttempts: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`GraphQL endpoint unreachable:\n  ${msg}`);
    }
  }

  async request<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    retryOptions?: RetryOptions
  ): Promise<T> {
    const opName = extractOpName(query);
    const start = Date.now();

    if (this.debug) {
      const varStr = variables
        ? JSON.stringify(variables).slice(0, 200).replace(/\s+/g, " ")
        : "—";
      console.log(`  [gql] → ${opName}`);
      console.log(`         vars: ${varStr}`);
    }

    let result: T;

    try {
      result = await withRetry(
        async () => {
          // Adaptive throttle: pace each attempt by the current per-tenant delay.
          await this.throttle();

          let response: Response;

          try {
            response = await fetch(this.url, {
              method: "POST",
              headers: this.headers,
              body: JSON.stringify({ query, variables }),
            });
          } catch (networkErr) {
            throw new Error(`Network error: ${String(networkErr)}`);
          }

          // Rate limited — back off and retry (honor Retry-After when present).
          if (response.status === 429) {
            const ra = response.headers.get("retry-after");
            let retryAfterMs: number | undefined;
            if (ra) {
              const secs = Number(ra);
              if (!Number.isNaN(secs)) retryAfterMs = secs * 1000;            // delta-seconds form
              else { const t = Date.parse(ra); if (!Number.isNaN(t)) retryAfterMs = Math.max(0, t - Date.now()); } // HTTP-date form
            }
            this.onRateLimited(retryAfterMs);
            throw new Error("Rate limited: HTTP 429");
          }

          if (response.status >= 500) {
            throw new Error(`Server error: HTTP ${response.status}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json") && !contentType.includes("application/graphql")) {
            const preview = await response.text().then((t) => t.slice(0, 120).replace(/\s+/g, " ").trim());
            throw new Error(
              `Endpoint did not return JSON (HTTP ${response.status}, Content-Type: ${contentType || "none"}).\n` +
              `  URL    : ${this.url}\n` +
              `  Preview: ${preview}\n` +
              `  → Check that your *_ADMIN_GQL_URL ends with /graphql and the API key is valid.`
            );
          }

          const json = (await response.json()) as GraphQLResponse<T>;

          if (json.errors && json.errors.length > 0) {
            const combined = json.errors.map((e) => e.message).join("; ");
            // Some servers report rate limiting as a GraphQL error, not a 429.
            if (/rate limit|too many requests|throttl/i.test(combined)) this.onRateLimited();
            throw new GraphQLError(combined, json.errors);
          }

          if (json.data === undefined) {
            throw new Error("GraphQL response missing data field");
          }

          this.onSuccess();
          return json.data;
        },
        {
          ...retryOptions,
          onRetry: (attempt, err) => {
            process.stderr.write(
              `  [retry ${attempt}] ${err instanceof Error ? err.message : String(err)}\n`
            );
            retryOptions?.onRetry?.(attempt, err);
          },
        }
      );
    } catch (err) {
      if (this.debug) {
        const elapsed = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [gql] ✗ ${opName}  ${elapsed}ms  ERROR: ${msg.slice(0, 200)}`);
      }
      throw err;
    }

    const elapsed = Date.now() - start;

    if (this.debug) {
      const respStr = JSON.stringify(result).slice(0, 200).replace(/\s+/g, " ");
      console.log(`  [gql] ← ${opName}  ${elapsed}ms  response: ${respStr}`);
    }

    return result;
  }
}

/** Extract the operation name from a GQL query/mutation string. */
function extractOpName(query: string): string {
  const match = query.match(/(?:query|mutation|subscription)\s+(\w+)/i);
  if (match) return match[1];
  // Inline shorthand: `{ __typename }` → "__typename"
  const inline = query.trim().replace(/\s+/g, " ").slice(0, 60);
  return inline;
}
