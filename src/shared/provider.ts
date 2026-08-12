/**
 * Provider layer — builds GraphQL clients from resolved EnvironmentConfig and
 * provides capability discovery (which operations a target actually exposes).
 *
 * Centralising client construction here means the CLI, the future API, and the
 * engine all create clients the same way, with consistent locale / rate-limit /
 * debug defaults pulled from the consolidated config.
 */

import { GraphQLClient } from "./graphql";
import { EnvironmentConfig, getRateLimitDelay, getDebug, getLocale } from "./config";

export interface CreateClientOptions {
  /** Use the Manage API URL instead of the Admin GQL URL. */
  useManage?: boolean;
  locale?: string;
  rateLimit?: number;
  debug?: boolean;
}

/** Build a GraphQLClient for one environment, defaulting from consolidated config. */
export function createClient(env: EnvironmentConfig, opts: CreateClientOptions = {}): GraphQLClient {
  const url = opts.useManage ? env.manageUrl : env.adminGqlUrl;
  if (!url) {
    throw new Error(
      `Environment is missing a ${opts.useManage ? "Manage API (manageUrl)" : "Admin GQL (adminGqlUrl)"} URL`
    );
  }
  return new GraphQLClient({
    url,
    apiKey: env.apiKey,
    tenant: env.tenant,
    locale: opts.locale ?? getLocale(),
    rateLimit: opts.rateLimit ?? getRateLimitDelay(),
    debug: opts.debug ?? getDebug(),
  });
}

/**
 * Field names of a GraphQL type (default "Mutation"). Used for capability
 * discovery — e.g. does this target expose `createPromoBanner` yet?
 */
export async function typeFieldNames(client: GraphQLClient, typeName = "Mutation"): Promise<string[]> {
  const r = await client.request<{ __type: { fields: Array<{ name: string }> } | null }>(
    `{ __type(name: "${typeName}") { fields { name } } }`,
    undefined,
    { maxAttempts: 1 }
  );
  return r.__type?.fields?.map((f) => f.name) ?? [];
}
