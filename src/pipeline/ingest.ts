import type { GraphStore } from '../store/memory-store.js';
import type { Embedder, LLMProvider } from '../provider/interfaces.js';
import type { EntityEdge, EntityNode, EpisodicNode } from '../model/types.js';
import { isFactActive, uuid } from '../model/types.js';
import { Mutex } from '../util/mutex.js';
import { contentHash } from '../util/hash.js';

/** What one ingestion actually changed — surfaced to callers (CLI, MCP tools). */
export interface IngestResult {
  episode: EpisodicNode;
  /** entities created or updated by this episode */
  entities: EntityNode[];
  /** edges created (deduped repeats are not listed) */
  facts: EntityEdge[];
  /** facts refreshed because the same statement was repeated */
  reinforced: EntityEdge[];
  /** existing facts closed by this episode (terminations / contradictions) */
  invalidated: EntityEdge[];
  /** true when extraction failed and the episode was stored unprocessed */
  failed?: boolean;
  /** why extraction failed (present when failed === true) */
  error?: string;
  /** true when this exact content had already been ingested into this group */
  duplicate?: boolean;
}

export interface IngestOptions {
  /**
   * Skip content already ingested into the same group (default true).
   * Compares a normalised content hash, so re-sending the same note is a no-op.
   */
  idempotent?: boolean;
}

/**
 * Ingestion pipeline, mirroring Graphiti's add_episode():
 *   1. persist the episode (L0 provenance)
 *   2. LLM extraction of candidate entities, facts and invalidations
 *   3. node resolution: dedupe against existing entities by name
 *   4. edge resolution:
 *        a. exact dedupe (same endpoints + same fact text)
 *        b. contradiction detection -> temporal supersede
 *           (old fact gets invalidAt/expiredAt, NEVER deleted)
 *        c. explicit invalidations -> close the named relation, no new edge
 *   5. embed names + facts for vector search
 *
 * Production guarantees:
 *   - serialised: concurrent addEpisode() calls run one at a time, so graph
 *     mutations never interleave across await points
 *   - idempotent: identical content in the same group is ingested once
 *   - failure-isolated: an extraction failure stores the episode as 'failed'
 *     (raw text preserved) and reports the error instead of throwing away work
 */
export class IngestPipeline {
  private readonly mutex = new Mutex();

  constructor(
    private store: GraphStore,
    private llm: LLMProvider,
    private embedder: Embedder,
  ) {}

  async addEpisode(
    input: {
      groupId: string;
      content: string;
      source?: EpisodicNode['source'];
      sourceDescription?: string;
      validAt?: Date;
      name?: string;
    },
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    return this.mutex.runTracked(() => this.addEpisodeSerial(input, options));
  }

  /**
   * Re-process episodes whose extraction previously failed.
   *
   * Failed episodes hold raw text that was never turned into graph facts; this
   * is the recovery path for an LLM outage. A successful retry replaces the
   * failed record, a failed retry just refreshes its error message.
   */
  async retryFailed(groupId?: string): Promise<{ retried: number; succeeded: number; stillFailing: number }> {
    const failed = (await this.store.getEpisodes(groupId)).filter((e) => e.status === 'failed');
    let succeeded = 0;
    let stillFailing = 0;

    for (const ep of failed) {
      const res = await this.addEpisode(
        {
          groupId: ep.groupId,
          content: ep.content,
          source: ep.source,
          sourceDescription: ep.sourceDescription,
          validAt: ep.validAt,
          name: ep.name,
        },
        { idempotent: false },
      );

      if (res.failed) {
        stillFailing++;
        // addEpisode stored a fresh failed record; keep the original instead
        await this.store.removeEpisode(res.episode.uuid);
        ep.error = res.error;
        await this.store.addEpisode(ep);
      } else {
        succeeded++;
        await this.store.removeEpisode(ep.uuid);
      }
    }

    return { retried: failed.length, succeeded, stillFailing };
  }

  /** The real work; only ever executed while holding the mutex. */
  private async addEpisodeSerial(
    input: {
      groupId: string;
      content: string;
      source?: EpisodicNode['source'];
      sourceDescription?: string;
      validAt?: Date;
      name?: string;
    },
    options: IngestOptions,
  ): Promise<IngestResult> {
    const now = new Date();
    const touchedEntities: EntityNode[] = [];
    const createdFacts: EntityEdge[] = [];
    const reinforcedFacts: EntityEdge[] = [];
    const invalidatedFacts: EntityEdge[] = [];
    const hash = contentHash(input.content);

    // 0. idempotency: the same text in the same group is ingested once
    if (options.idempotent !== false) {
      const seen = (await this.store
        .getEpisodes(input.groupId))
        .find((e) => e.contentHash === hash && e.status !== 'failed');
      if (seen) {
        return {
          episode: seen,
          entities: [],
          facts: [],
          reinforced: [],
          invalidated: [],
          duplicate: true,
        };
      }
    }

    const episode: EpisodicNode = {
      type: 'episode',
      uuid: uuid(),
      groupId: input.groupId,
      name: input.name ?? input.content.slice(0, 60),
      source: input.source ?? 'text',
      sourceDescription: input.sourceDescription ?? 'user input',
      content: input.content,
      validAt: input.validAt ?? now,
      createdAt: now,
      contentHash: hash,
    };
    await this.store.addEpisode(episode);

    // 2. extraction
    const knownNames = (await this.store.getEntities(input.groupId)).map((e) => e.name);
    // hand the LLM the active facts that this text plausibly talks about, so a
    // termination can name the exact relation it closes instead of inventing one
    const lower = input.content.toLowerCase();
    const entityName = new Map((await this.store.getEntities(input.groupId)).map((e) => [e.uuid, e.name]));
    const knownFacts = (await this.store.getFacts(input.groupId))
      .filter((f) => isFactActive(f))
      .filter((f) => {
        const s = (entityName.get(f.sourceNodeUuid) ?? '').toLowerCase();
        const t = (entityName.get(f.targetNodeUuid) ?? '').toLowerCase();
        return (s && lower.includes(s)) || (t && lower.includes(t));
      })
      .slice(0, 20)
      .map((f) => ({
        sourceName: entityName.get(f.sourceNodeUuid) ?? '',
        targetName: entityName.get(f.targetNodeUuid) ?? '',
        relation: f.name,
        fact: f.fact,
      }));
    const extraction = await this.llm
      .extract(input.content, knownNames, knownFacts)
      .catch((err: Error) => err);

    // failure isolation: keep the raw episode (it is the most valuable thing we
    // hold), mark it failed, and report — never discard the text or half-write
    // a graph. A later pass can retry everything with status === 'failed'.
    if (extraction instanceof Error) {
      episode.status = 'failed';
      episode.error = extraction.message.slice(0, 500);
      await this.store.addEpisode(episode);
      return {
        episode,
        entities: [],
        facts: [],
        reinforced: [],
        invalidated: [],
        failed: true,
        error: episode.error,
      };
    }
    episode.status = 'processed';

    // 3. node resolution
    const resolved = new Map<string, EntityNode>();
    for (const cand of extraction.entities) {
      const existing = await this.store.findEntityByName(input.groupId, cand.name);
      if (existing) {
        // merge: keep node, extend labels, refresh summary
        existing.labels = [...new Set([...existing.labels, ...cand.labels])];
        existing.summary = cand.summary || existing.summary;
        await this.store.upsertEntity(existing);
        resolved.set(cand.name.toLowerCase(), existing);
        touchedEntities.push(existing);
        continue;
      }
      const node: EntityNode = {
        type: 'entity',
        uuid: uuid(),
        groupId: input.groupId,
        name: cand.name,
        labels: cand.labels,
        summary: cand.summary,
        attributes: {},
        createdAt: now,
      };
      node.nameEmbedding = await this.embedder.embed(node.name);
      await this.store.upsertEntity(node);
      resolved.set(cand.name.toLowerCase(), node);
      touchedEntities.push(node);
    }

    // 4. edge resolution
    for (const cand of extraction.facts) {
      const src = resolved.get(cand.sourceName.toLowerCase()) ?? (await this.store.findEntityByName(input.groupId, cand.sourceName));
      const tgt = resolved.get(cand.targetName.toLowerCase()) ?? (await this.store.findEntityByName(input.groupId, cand.targetName));
      if (!src || !tgt) continue;

      const existingBetween = (await this.store.getFactsForEntity(src.uuid)).filter(
        (f) => f.sourceNodeUuid === tgt.uuid || f.targetNodeUuid === tgt.uuid,
      );

      // a. exact dedupe
      const dup = existingBetween.find(
        (f) => f.sourceNodeUuid === src.uuid && f.targetNodeUuid === tgt.uuid && f.fact === cand.fact,
      );
      if (dup && isFactActive(dup)) {
        dup.episodes.push(episode.uuid);
        await this.store.updateFact(dup);
        reinforcedFacts.push(dup);
        continue;
      }

      // b. contradiction -> supersede
      const activeBetween = existingBetween.filter((f) => isFactActive(f));
      const contradicted = await this.llm.detectContradiction(
        { sourceName: cand.sourceName, targetName: cand.targetName, fact: cand.fact },
        activeBetween.map((f) => ({ fact: f.fact, validAt: f.validAt, invalidAt: f.invalidAt })),
      );
      if (contradicted) {
        for (const old of activeBetween) {
          old.expiredAt = now;
          old.invalidAt = old.invalidAt ?? cand.validAt ?? now;
          await this.store.updateFact(old);
          invalidatedFacts.push(old);
        }
      }

      const edge: EntityEdge = {
        type: 'fact',
        uuid: uuid(),
        groupId: input.groupId,
        sourceNodeUuid: src.uuid,
        targetNodeUuid: tgt.uuid,
        name: cand.relation,
        fact: cand.fact,
        episodes: [episode.uuid],
        validAt: cand.validAt ?? episode.validAt,
        invalidAt: cand.invalidAt,
        createdAt: now,
        attributes: {},
      };
      edge.factEmbedding = await this.embedder.embed(cand.fact);
      await this.store.addFact(edge);
      createdFacts.push(edge);
    }

    // 5. explicit invalidations: close existing relations WITHOUT creating a
    // redundant "LEFT/QUIT/ENDED" edge (the fix for termination modeling)
    for (const inv of extraction.invalidations) {
      const src = resolved.get(inv.sourceName.toLowerCase()) ?? (await this.store.findEntityByName(input.groupId, inv.sourceName));
      const tgt = resolved.get(inv.targetName.toLowerCase()) ?? (await this.store.findEntityByName(input.groupId, inv.targetName));
      if (!src || !tgt) continue;

      const candidates = (await this.store
        .getFactsForEntity(src.uuid))
        .filter((f) => f.sourceNodeUuid === tgt.uuid || f.targetNodeUuid === tgt.uuid)
        .filter((f) => isFactActive(f))
        .filter((f) => !invalidatedFacts.includes(f))
        // when the LLM named a relation, prefer it; otherwise close all active
        // relations between this pair (a plain "they parted ways" statement)
        .filter((f) => !inv.relation || f.name.toUpperCase() === inv.relation.toUpperCase());

      for (const f of candidates) {
        f.invalidAt = inv.invalidAt ?? episode.validAt;
        f.expiredAt = now;
        f.attributes = { ...f.attributes, invalidatedBy: inv.reason ?? input.content.slice(0, 120) };
        await this.store.updateFact(f);
        invalidatedFacts.push(f);
      }
    }

    return {
      episode,
      entities: touchedEntities,
      facts: createdFacts,
      reinforced: reinforcedFacts,
      invalidated: invalidatedFacts,
    };
  }
}
