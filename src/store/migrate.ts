import type { GraphStore } from './memory-store.js';
import type { Embedder } from '../provider/interfaces.js';
import type { EntityEdge, EntityNode, EpisodicNode } from '../model/types.js';

export interface MigrateReport {
  episodes: number;
  entities: number;
  facts: number;
  /** entities merged because the target enforces name uniqueness */
  mergedEntities: Array<{ name: string; from: string; to: string }>;
  /** embeddings recomputed (model or dimension change) */
  reembedded: number;
  /** facts whose endpoints could not be resolved and were skipped */
  skippedFacts: string[];
}

export interface MigrateOptions {
  /**
   * Recompute embeddings instead of copying them. Required when moving to a
   * store whose vector dimension differs from the snapshot's (e.g. switching
   * from the 256-dim hash embedder to 1024-dim Qwen3).
   */
  reembed?: Embedder;
  onProgress?: (message: string) => void;
}

/**
 * Move a JSON snapshot into any GraphStore.
 *
 * Entities are inserted before facts (facts reference them), and endpoints are
 * remapped through the target's canonical entity uuids so a name-merge cannot
 * leave a dangling reference.
 */
export async function migrateSnapshot(
  json: string,
  target: GraphStore,
  opts: MigrateOptions = {},
): Promise<MigrateReport> {
  const log = opts.onProgress ?? (() => {});
  const data = JSON.parse(json, reviveDates) as {
    episodes?: EpisodicNode[];
    entities?: EntityNode[];
    facts?: EntityEdge[];
  };

  const report: MigrateReport = {
    episodes: 0,
    entities: 0,
    facts: 0,
    mergedEntities: [],
    reembedded: 0,
    skippedFacts: [],
  };

  // 1. episodes are independent
  for (const ep of data.episodes ?? []) {
    await target.addEpisode(ep);
    report.episodes++;
  }
  log(`migrated ${report.episodes} episodes`);

  // 2. entities, remembering which source uuid each name resolved to
  const canonical = new Map<string, string>(); // source uuid -> target uuid
  for (const node of data.entities ?? []) {
    if (opts.reembed) {
      node.nameEmbedding = await opts.reembed.embed(node.name);
      report.reembedded++;
    }
    const before = await target.findEntityByName(node.groupId, node.name);
    await target.upsertEntity(node);
    const after = await target.findEntityByName(node.groupId, node.name);
    const targetUuid = after?.uuid ?? node.uuid;
    canonical.set(node.uuid, targetUuid);
    if (before && before.uuid !== node.uuid) {
      report.mergedEntities.push({ name: node.name, from: node.uuid, to: targetUuid });
    }
    report.entities++;
  }
  log(`migrated ${report.entities} entities (${report.mergedEntities.length} merged by name)`);

  // 3. facts, with remapped endpoints
  for (const fact of data.facts ?? []) {
    const source = canonical.get(fact.sourceNodeUuid) ?? fact.sourceNodeUuid;
    const targetNode = canonical.get(fact.targetNodeUuid) ?? fact.targetNodeUuid;

    const bothExist = (await target.getEntity(source)) && (await target.getEntity(targetNode));
    if (!bothExist) {
      report.skippedFacts.push(fact.fact);
      continue;
    }
    if (opts.reembed) {
      fact.factEmbedding = await opts.reembed.embed(fact.fact);
      report.reembedded++;
    }
    await target.addFact({ ...fact, sourceNodeUuid: source, targetNodeUuid: targetNode });
    report.facts++;
  }
  log(`migrated ${report.facts} facts (${report.skippedFacts.length} skipped)`);

  return report;
}

const DATE_KEYS = new Set(['validAt', 'invalidAt', 'expiredAt', 'createdAt']);
function reviveDates(k: string, v: unknown): unknown {
  if (typeof v === 'string' && DATE_KEYS.has(k)) return new Date(v);
  return v;
}
