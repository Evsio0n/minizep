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

/**
 * Try a chain of embedders in order; fall back to the deterministic
 * hash embedder so the pipeline never hard-fails offline.
 */
export class FallbackEmbedder implements Embedder {
  constructor(private chain: Embedder[], private dims = 256) {}

  async embed(text: string): Promise<number[]> {
    for (const e of this.chain) {
      try {
        const v = await e.embed(text);
        if (v && v.length > 0) return v;
      } catch {
        // try next
      }
    }
    return hashEmbed(text, this.dims);
  }

  /** which tier actually answered last — useful for demos/logging */
  lastTier = 'hash';
  async embedTraced(text: string): Promise<{ vec: number[]; tier: string }> {
    for (const e of this.chain) {
      try {
        const v = await e.embed(text);
        if (v && v.length > 0) {
          this.lastTier = e.constructor.name;
          return { vec: v, tier: this.lastTier };
        }
      } catch {
        // try next
      }
    }
    this.lastTier = 'HashEmbedder';
    return { vec: hashEmbed(text, this.dims), tier: this.lastTier };
  }
}
