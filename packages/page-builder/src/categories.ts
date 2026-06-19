/**
 * Category utilities — gracefully skipped if the API has no category operations.
 */

import { GraphQLClient, logger } from "@kibo-cms-clone-tool/shared";
import { PageBuilderOps } from "./ops";

export interface PbCategory {
  slug: string;
  name: string;
  url: string;
  layout: string;
}

/** Wrap a query/mutation body in the namespace if one was discovered. */
export function wrap(namespace: string | null, body: string): string {
  return namespace ? `${namespace} { ${body} }` : body;
}

function buildListCategoriesQuery(ops: PageBuilderOps): string {
  const inner = `${ops.listCategories} { data { slug name url layout } error { message } }`;
  return `query ListCategories { ${wrap(ops.namespace, inner)} }`;
}

function buildCreateCategoryMutation(ops: PageBuilderOps): string {
  const inner = `${ops.createCategory}(data: $data) { data { slug name } error { message } }`;
  return `mutation CreateCategory($data: PbCreateCategoryInput!) { ${wrap(ops.mutNamespace, inner)} }`;
}

export async function listCategories(
  client: GraphQLClient,
  ops: PageBuilderOps
): Promise<PbCategory[]> {
  if (!ops.listCategories) return [];

  type Resp = Record<string, { data: PbCategory[]; error: { message: string } | null }>;

  const resp = await client.request<Resp>(buildListCategoriesQuery(ops));
  const ns = ops.namespace ?? ops.listCategories;
  // Response path: either resp[namespace][listCategories] or resp[listCategories]
  const result = ops.namespace
    ? (resp[ops.namespace] as unknown as Record<string, { data: PbCategory[]; error: { message: string } | null }>)[ops.listCategories]
    : resp[ops.listCategories];

  if (!result) return [];
  if (result.error) throw new Error(`Failed to list categories: ${result.error.message}`);
  return result.data;
}

export async function syncCategories(
  targetClient: GraphQLClient,
  ops: PageBuilderOps,
  categories: PbCategory[],
  dryRun: boolean
): Promise<Set<string>> {
  if (!ops.listCategories) {
    logger.log("\n📂 Categories: not supported by this API — skipping.");
    return new Set();
  }

  logger.log("\n📂 Syncing categories...");
  const targetCategories = await listCategories(targetClient, ops);
  const targetSlugs = new Set(targetCategories.map((c) => c.slug));

  for (const cat of categories) {
    if (targetSlugs.has(cat.slug)) {
      logger.log(`  ✓ "${cat.slug}" already exists`);
      continue;
    }
    if (!ops.createCategory) {
      logger.warn(`  ⚠  No createCategory operation — skipping "${cat.slug}"`);
      continue;
    }
    if (dryRun) {
      logger.log(`  [dry-run] Would create category "${cat.slug}"`);
      targetSlugs.add(cat.slug);
      continue;
    }

    type CreateResp = Record<string, { data: { slug: string } | null; error: { message: string } | null }>;
    const resp = await targetClient.request<CreateResp>(
      buildCreateCategoryMutation(ops),
      { data: { slug: cat.slug, name: cat.name, url: cat.url, layout: cat.layout } }
    );

    const result = ops.mutNamespace
      ? (resp[ops.mutNamespace] as unknown as CreateResp)[ops.createCategory]
      : resp[ops.createCategory];

    if (result?.error) {
      logger.warn(`  ⚠  Could not create "${cat.slug}": ${result.error.message}`);
    } else {
      logger.log(`  ✅ Created category "${cat.slug}"`);
      targetSlugs.add(cat.slug);
    }
  }

  return targetSlugs;
}
