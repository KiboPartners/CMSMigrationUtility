/**
 * Resolve a content-model catalog row by modelId for dependency hydration.
 */

import { GraphQLClient, CatalogItem } from "@kibo-cms-clone-tool/shared";
import { listSourceModels } from "./provision";

export async function fetchModelById(
  manageClient: GraphQLClient,
  modelId: string
): Promise<CatalogItem | null> {
  const want = modelId.toLowerCase();
  const models = await listSourceModels(manageClient);
  const m = models.find(
    (x) => x.modelId.toLowerCase() === want || x.name.toLowerCase() === want
  );
  if (!m) return null;
  return {
    type: "model",
    id: m.modelId,
    label: m.name,
    metadata: {
      fields: m.fieldCount,
      singularApiName: m.singularApiName,
      pluralApiName: m.pluralApiName,
      group: m.group,
    },
  };
}
