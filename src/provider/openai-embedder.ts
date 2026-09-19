import type { Embedder } from './interfaces.js';

/**
 * Generic OpenAI-compatible embeddings client (`POST /v1/embeddings`).
 * Works with: vLLM, llama.cpp llama-server, TEI, Infinity, LiteLLM,
 * OpenAI/Azure/SiliconFlow/DeepSeek-compatible clouds — anything that
 * speaks the de-facto standard.
 */
export class OpenAIEmbedder implements Embedder {
  constructor(
    private baseUrl = process.env.MINIZEP_OPENAI_EMBED_URL ?? 'http://127.0.0.1:11435',
    private model = process.env.MINIZEP_OPENAI_EMBED_MODEL ?? 'Qwen/Qwen3-Embedding-0.6B',
    private apiKey = process.env.MINIZEP_OPENAI_EMBED_KEY ?? 'local',
  ) {}

  async embed(text: string): Promise<number[]> {
    const vecs = await this.embedBatch([text]);
    return vecs[0];
  }

  /** Batched — vLLM/TEI benefit hugely from batching. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}
