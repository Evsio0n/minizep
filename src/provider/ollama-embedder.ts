import type { Embedder } from './interfaces.js';
import { hashEmbed } from '../search/retrieval.js';

/**
 * Embedder backed by an Ollama server (e.g. qwen3-embedding:0.6b on a
 * Slurm-allocated GPU node, reached through an SSH tunnel).
 *
 * Zero npm dependencies — plain fetch against the Ollama HTTP API.
 */
export class OllamaEmbedder implements Embedder {
  private probe: Promise<boolean> | null = null;

  constructor(
    private baseUrl = process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11434',
    private model = process.env.MINIZEP_EMBED_MODEL ?? 'qwen3-embedding:0.6b',
  ) {}

  private available(): Promise<boolean> {
    if (this.probe === null) {
      this.probe = fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
        .then((r: { ok: boolean }) => r.ok)
        .catch(() => false);
    }
    return this.probe;
  }

  async embed(text: string): Promise<number[]> {
    if (!(await this.available())) throw new Error(`ollama not reachable at ${this.baseUrl}`);
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }
}

export interface FallbackEmbedderOptions {
  /**
   * Fall back to the deterministic hash embedder when every tier fails.
   * Off by default: hash vectors live in a different space (and usually have
   * a different dimension) than a real model's, so mixing them into one index
   * silently corrupts search. Only offline demos should turn this on.
   */
  allowHash?: boolean;
  /** hash-embedding dimension when allowHash is on (default 256) */
  dims?: number;
}

/**
 * Try a chain of embedders in order. The tiers are expected to serve the same
 * model (e.g. llama.cpp first, Ollama as a backup), and every tier must produce
 * vectors of the same length: a tier that answers with another dimension is
 * treated as failed. When every tier fails this throws, unless the hash
 * fallback was explicitly allowed.
 *
 * One instance never mixes vector spaces: whichever answers first — the model
 * chain or (when allowed) the hash fallback — is used for its whole lifetime.
 */
export class FallbackEmbedder implements Embedder {
  private readonly allowHash: boolean;
  private readonly hashDims: number;
  private space: 'model' | 'hash' | undefined;
  private seenDims: number | undefined;

  /** `opts` may be a number for compatibility: the old hash-dimension argument. */
  constructor(private chain: Embedder[], opts: FallbackEmbedderOptions | number = {}) {
    const o = typeof opts === 'number' ? { dims: opts } : opts;
    this.allowHash = o.allowHash ?? false;
    this.hashDims = o.dims ?? 256;
  }

  /** dimension of the vectors produced so far (undefined before the first) */
  get dims(): number | undefined {
    return this.seenDims;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedTraced(text)).vec;
  }

  /** which tier actually answered last — useful for demos/logging */
  lastTier = 'none';
  async embedTraced(text: string): Promise<{ vec: number[]; tier: string }> {
    const errors: string[] = [];
    if (this.space !== 'hash') {
      for (const e of this.chain) {
        const tier = e.constructor.name;
        try {
          const v = await e.embed(text);
          if (!v || v.length === 0) {
            errors.push(`${tier}: empty vector`);
          } else if (this.seenDims !== undefined && v.length !== this.seenDims) {
            errors.push(`${tier}: ${v.length} dims, expected ${this.seenDims}`);
          } else {
            this.space = 'model';
            this.seenDims = v.length;
            this.lastTier = tier;
            return { vec: v, tier };
          }
        } catch (err) {
          errors.push(`${tier}: ${(err as Error).message}`);
        }
      }
    }
    if (!this.allowHash || this.space === 'model') {
      throw new Error(`all embedding tiers failed (${errors.join('; ') || 'no tiers configured'})`);
    }
    this.space = 'hash';
    this.seenDims = this.hashDims;
    this.lastTier = 'HashEmbedder';
    return { vec: hashEmbed(text, this.hashDims), tier: this.lastTier };
  }
}
