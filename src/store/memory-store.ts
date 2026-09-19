import type { EntityEdge, EntityNode, EpisodicNode, UUID } from '../model/types.js';
import { isFactActive } from '../model/types.js';

/**
 * Graph persistence boundary.
 *
 * Every method is async: an in-memory implementation could be synchronous, but
 * a database-backed one cannot, and the pipeline must not care which it has.
 */
export interface GraphStore {
  // episodes
  addEpisode(ep: EpisodicNode): Promise<void>;
  getEpisodes(groupId?: string): Promise<EpisodicNode[]>;
  /** remove an episode record (used when a failed episode is reprocessed) */
  removeEpisode(uuid: UUID): Promise<void>;

  // entities
  upsertEntity(node: EntityNode): Promise<void>;
  getEntity(uuid: UUID): Promise<EntityNode | undefined>;
  findEntityByName(groupId: string, name: string): Promise<EntityNode | undefined>;
  getEntities(groupId?: string): Promise<EntityNode[]>;

  // facts
  addFact(edge: EntityEdge): Promise<void>;
  updateFact(edge: EntityEdge): Promise<void>;
  getFact(uuid: UUID): Promise<EntityEdge | undefined>;
  getFacts(groupId?: string): Promise<EntityEdge[]>;
  getFactsForEntity(uuid: UUID): Promise<EntityEdge[]>;
  getFactsBetween(a: UUID, b: UUID): Promise<EntityEdge[]>;
}

/** Stores that can dump/restore themselves as JSON (used by FilePersistence). */
export interface Snapshotable {
  toJSON(): string;
  loadJSON(json: string): void;
}

export function isSnapshotable(store: GraphStore): store is GraphStore & Snapshotable {
  const s = store as Partial<Snapshotable>;
  return typeof s.toJSON === 'function' && typeof s.loadJSON === 'function';
}

/**
 * In-memory graph with adjacency indexes. Fast, dependency-free, and the
 * reference implementation the other backends are tested against.
 */
export class MemoryGraphStore implements GraphStore, Snapshotable {
  private episodes = new Map<UUID, EpisodicNode>();
  private entities = new Map<UUID, EntityNode>();
  private facts = new Map<UUID, EntityEdge>();
  private byName = new Map<string, UUID>();
  private byEntity = new Map<UUID, Set<UUID>>();

  async addEpisode(ep: EpisodicNode): Promise<void> {
    this.episodes.set(ep.uuid, ep);
  }
  async getEpisodes(groupId?: string): Promise<EpisodicNode[]> {
    return [...this.episodes.values()].filter((e) => !groupId || e.groupId === groupId);
  }
  async removeEpisode(uuid: UUID): Promise<void> {
    this.episodes.delete(uuid);
  }

  async upsertEntity(node: EntityNode): Promise<void> {
    // Mirror the database's UNIQUE (group_id, lower(name)) constraint: a second
    // entity with the same name in the same group updates the existing one.
    // Its uuid stays stable — facts already point at it, and stable identity is
    // what a database would do too.
    const key = `${node.groupId}::${node.name.toLowerCase()}`;
    const existingUuid = this.byName.get(key);
    if (existingUuid && existingUuid !== node.uuid) {
      const existing = this.entities.get(existingUuid);
      if (existing) {
        existing.labels = node.labels;
        existing.summary = node.summary;
        existing.attributes = node.attributes;
        existing.nameEmbedding = node.nameEmbedding ?? existing.nameEmbedding;
        existing.name = node.name;
      }
      return;
    }
    this.entities.set(node.uuid, node);
    this.byName.set(key, node.uuid);
  }

  async getEntity(uuid: UUID): Promise<EntityNode | undefined> {
    return this.entities.get(uuid);
  }
  async findEntityByName(groupId: string, name: string): Promise<EntityNode | undefined> {
    const id = this.byName.get(`${groupId}::${name.toLowerCase()}`);
    return id ? this.entities.get(id) : undefined;
  }
  async getEntities(groupId?: string): Promise<EntityNode[]> {
    return [...this.entities.values()].filter((n) => !groupId || n.groupId === groupId);
  }

  async addFact(edge: EntityEdge): Promise<void> {
    this.facts.set(edge.uuid, edge);
    this.link(edge.sourceNodeUuid, edge.uuid);
    this.link(edge.targetNodeUuid, edge.uuid);
  }
  async updateFact(edge: EntityEdge): Promise<void> {
    this.facts.set(edge.uuid, edge);
  }
  private link(entity: UUID, fact: UUID): void {
    let set = this.byEntity.get(entity);
    if (!set) this.byEntity.set(entity, (set = new Set()));
    set.add(fact);
  }
  async getFact(uuid: UUID): Promise<EntityEdge | undefined> {
    return this.facts.get(uuid);
  }
  async getFacts(groupId?: string): Promise<EntityEdge[]> {
    return [...this.facts.values()].filter((f) => !groupId || f.groupId === groupId);
  }
  async getFactsForEntity(uuid: UUID): Promise<EntityEdge[]> {
    const ids = this.byEntity.get(uuid);
    if (!ids) return [];
    return [...ids].map((id) => this.facts.get(id)!).filter(Boolean);
  }
  async getFactsBetween(a: UUID, b: UUID): Promise<EntityEdge[]> {
    return (await this.getFactsForEntity(a)).filter(
      (f) => (f.sourceNodeUuid === b || f.targetNodeUuid === b) && isFactActive(f),
    );
  }

  toJSON(): string {
    return JSON.stringify(
      {
        episodes: [...this.episodes.values()],
        entities: [...this.entities.values()],
        facts: [...this.facts.values()],
      },
      null,
      2,
    );
  }

  loadJSON(json: string): void {
    const data = JSON.parse(json, reviveDates) as {
      episodes: EpisodicNode[];
      entities: EntityNode[];
      facts: EntityEdge[];
    };
    this.episodes.clear();
    this.entities.clear();
    this.facts.clear();
    this.byName.clear();
    this.byEntity.clear();
    for (const ep of data.episodes ?? []) this.episodes.set(ep.uuid, ep);
    for (const n of data.entities ?? []) {
      this.entities.set(n.uuid, n);
      this.byName.set(`${n.groupId}::${n.name.toLowerCase()}`, n.uuid);
    }
    for (const f of data.facts ?? []) {
      this.facts.set(f.uuid, f);
      this.link(f.sourceNodeUuid, f.uuid);
      this.link(f.targetNodeUuid, f.uuid);
    }
  }
}

/** ISO date strings under known keys back into Date objects. */
const DATE_KEYS = new Set(['validAt', 'invalidAt', 'expiredAt', 'createdAt']);
function reviveDates(k: string, v: unknown): unknown {
  if (typeof v === 'string' && DATE_KEYS.has(k)) return new Date(v);
  return v;
}
