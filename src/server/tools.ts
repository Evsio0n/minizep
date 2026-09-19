import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Minizep } from '../index.js';
import type { FilePersistence } from '../store/persistence.js';
import type { EntityEdge, EntityNode, FactWithContext } from '../model/types.js';
import type { JobQueue } from '../jobs/queue.js';

/** Everything the tool handlers need, injected so transports can differ. */
export interface ToolContext {
  zep: Minizep;
  persistence: FilePersistence;
  jobs: JobQueue;
  llmLabel: string;
  storeLabel: string;
  defaultGroup: string;
}

const iso = (d?: Date) => (d ? d.toISOString() : null);

function validity(f: EntityEdge): string {
  if (!f.invalidAt && !f.expiredAt) return 'still true';
  const end = f.invalidAt ?? f.expiredAt!;
  return `true ${iso(f.validAt)?.slice(0, 10) ?? '?'} \u2192 ${iso(end)?.slice(0, 10)}`;
}

function formatFact(r: FactWithContext): string {
  return `${r.sourceName} --${r.fact.name}--> ${r.targetName} | "${r.fact.fact}" | ${validity(r.fact)}`;
}

function ok(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Registers every minizep tool on a server instance. Shared by stdio and HTTP. */
export function registerTools(server: McpServer, ctx: ToolContext): void {

  server.registerTool(
    'add_memory',
    {
      title: 'Add memory',
      description:
        'Ingest text into the temporal knowledge graph. Extracts entities and facts, and marks ' +
        'relationships that the text says have ended as invalid (historical facts are kept, not deleted).',
      inputSchema: {
        content: z.string().min(1).describe('The text to remember (a message, note, or document excerpt)'),
        group_id: z.string().optional().describe(`Memory namespace (default "${ctx.defaultGroup}")`),
        valid_at: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp for when this happened in the real world (defaults to now)'),
        source: z.enum(['text', 'json', 'markdown']).optional(),
        name: z.string().optional().describe('Short label for this episode'),
        async: z
          .boolean()
          .optional()
          .describe(
            'Queue the work and return a job id immediately instead of waiting. ' +
              'Extraction takes seconds; use this for long documents or bulk ingestion, ' +
              'then poll memory_job_status.',
          ),
      },
    },
    async ({ content, group_id, valid_at, source, name, async: runAsync }) => {
      const groupId = group_id ?? ctx.defaultGroup;

      const ingest = () =>
        ctx.zep.ingest.addEpisode({
          groupId,
          content,
          source,
          name,
          validAt: valid_at ? new Date(valid_at) : undefined,
        });

      if (runAsync) {
        const job = ctx.jobs.submit(`add_memory:${groupId}`, async () => {
          const r = await ingest();
          ctx.persistence.schedule(ctx.zep);
          return r;
        });
        return ok(
          `queued job ${job.id}\nstatus: ${job.status}\npoll memory_job_status with this id`,
          { job_id: job.id, status: job.status },
        );
      }

      const started = Date.now();
      const result = await ingest();
      ctx.persistence.schedule(ctx.zep);

      const lines = [
        `episode ${result.episode.uuid.slice(0, 8)} stored in group "${groupId}" (${Date.now() - started}ms)`,
        `entities: ${result.entities.length ? result.entities.map((e) => e.name).join(', ') : '(none)'}`,
        `new facts: ${result.facts.length ? result.facts.map((f) => f.fact).join(' ; ') : '(none)'}`,
        `reinforced: ${result.reinforced.length}`,
        `invalidated: ${
          result.invalidated.length ? result.invalidated.map((f) => f.fact).join(' ; ') : '(none)'
        }`,
      ];
      return ok(lines.join('\n'), {
        episode_uuid: result.episode.uuid,
        entities: result.entities.map((e) => e.name),
        facts: result.facts.map((f) => f.fact),
        invalidated: result.invalidated.map((f) => f.fact),
      });
    },
  );

  server.registerTool(
    'search_facts',
    {
      title: 'Search facts',
      description:
        'Hybrid search (BM25 + embeddings + rank fusion) over facts. By default only currently-true ' +
        'facts are returned; pass at= to time-travel, or include_historical=true for the full history.',
      inputSchema: {
        query: z.string().min(1),
        group_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        at: z.string().optional().describe('ISO-8601 instant: return only facts true at that time'),
        include_historical: z.boolean().optional().describe('Include facts that are no longer true'),
      },
    },
    async ({ query, group_id, limit, at, include_historical }) => {
      const rows = await ctx.zep.searchFacts(query, {
        groupId: group_id ?? ctx.defaultGroup,
        limit: limit ?? 10,
        at: at ? new Date(at) : undefined,
        includeHistorical: include_historical ?? false,
      });
      if (!rows.length) return ok('no matching facts');
      return ok(rows.map(formatFact).join('\n'), {
        facts: rows.map((r) => ({
          fact: r.fact.fact,
          relation: r.fact.name,
          source: r.sourceName,
          target: r.targetName,
          valid_at: iso(r.fact.validAt),
          invalid_at: iso(r.fact.invalidAt),
        })),
      });
    },
  );

  server.registerTool(
    'facts_about',
    {
      title: 'Facts about an entity',
      description: 'Every fact touching one entity, with its temporal validity window.',
      inputSchema: {
        entity: z.string().min(1).describe('Entity name, e.g. "Alice"'),
        group_id: z.string().optional(),
        at: z.string().optional(),
        include_historical: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ entity, group_id, at, include_historical, limit }) => {
      const rows = await ctx.zep.factsAbout(entity, {
        groupId: group_id ?? ctx.defaultGroup,
        at: at ? new Date(at) : undefined,
        includeHistorical: include_historical ?? false,
        limit: limit ?? 50,
      });
      if (!rows.length) return ok(`no facts about "${entity}"`);
      return ok(rows.map(formatFact).join('\n'));
    },
  );

  server.registerTool(
    'facts_at',
    {
      title: 'Time travel',
      description: 'What the graph believed was true at a given instant (bi-temporal query).',
      inputSchema: {
        timestamp: z.string().describe('ISO-8601 instant, e.g. 2024-06-01T00:00:00Z'),
        group_id: z.string().optional(),
      },
    },
    async ({ timestamp, group_id }) => {
      const rows = await ctx.zep.factsAt(new Date(timestamp), group_id ?? ctx.defaultGroup);
      if (!rows.length) return ok(`nothing was true at ${timestamp}`);
      return ok(rows.map(formatFact).join('\n'));
    },
  );

  server.registerTool(
    'list_entities',
    {
      title: 'List entities',
      description: 'Entities in the graph, optionally filtered by a name/summary substring.',
      inputSchema: {
        query: z.string().optional(),
        group_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, group_id, limit }) => {
      const q = query?.toLowerCase();
      const rows = (await ctx.zep.store.getEntities(group_id ?? ctx.defaultGroup))
        .filter((e: EntityNode) => !q || e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
        .slice(0, limit ?? 50);
      if (!rows.length) return ok('no entities');
      return ok(rows.map((e) => `${e.name} [${e.labels.join(',')}] — ${e.summary}`).join('\n'));
    },
  );

  server.registerTool(
    'list_episodes',
    {
      title: 'List episodes',
      description: 'Raw ingested data (provenance). Everything in the graph traces back to these.',
      inputSchema: {
        group_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ group_id, limit }) => {
      const rows = (await ctx.zep.store.getEpisodes(group_id ?? ctx.defaultGroup))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit ?? 20);
      if (!rows.length) return ok('no episodes');
      return ok(
        rows
          .map((e) => `${e.uuid.slice(0, 8)} ${iso(e.validAt)?.slice(0, 10)} — ${e.content.slice(0, 120)}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'memory_job_status',
    {
      title: 'Ingestion job status',
      description:
        'Check an asynchronous add_memory job. Omit job_id to list recent jobs.',
      inputSchema: {
        job_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ job_id, limit }) => {
      if (job_id) {
        const job = ctx.jobs.get(job_id);
        if (!job) return ok(`no job ${job_id}`);
        const lines = [
          `job      : ${job.id}`,
          `status   : ${job.status}`,
          `label    : ${job.label}`,
          `created  : ${job.createdAt.toISOString()}`,
          job.finishedAt ? `finished : ${job.finishedAt.toISOString()}` : '',
        ].filter(Boolean);
        if (job.error) lines.push(`error    : ${job.error}`);
        if (job.result) {
          const r = job.result as { entities?: unknown[]; facts?: unknown[]; invalidated?: unknown[]; failed?: boolean };
          lines.push(
            `entities : ${r.entities?.length ?? 0}`,
            `facts    : ${r.facts?.length ?? 0}`,
            `invalidated: ${r.invalidated?.length ?? 0}`,
          );
          if (r.failed) lines.push('(extraction failed; the episode is stored for retry)');
        }
        return ok(lines.join('\n'), { job_id: job.id, status: job.status });
      }
      const jobs = ctx.jobs.list(limit ?? 20);
      if (jobs.length === 0) return ok('no jobs');
      return ok(
        jobs.map((j) => `${j.id.slice(0, 8)} ${j.status.padEnd(9)} ${j.label}`).join('\n'),
      );
    },
  );

  server.registerTool(
    'graph_stats',
    {
      title: 'Graph statistics',
      description: 'Counts of episodes, entities, active and historical facts.',
      inputSchema: {},
    },
    async () => {
      // scoped to the caller's namespace: a token must not be able to infer
      // how much data other tenants hold
      const group = ctx.defaultGroup;
      const facts = await ctx.zep.store.getFacts(group);
      const active = (await ctx.zep.factsAt(new Date(), group)).length;
      const text = [
        `group    : ${group}`,
        `episodes : ${(await ctx.zep.store.getEpisodes(group)).length}`,
        `entities : ${(await ctx.zep.store.getEntities(group)).length}`,
        `facts    : ${facts.length} (${active} currently true, ${facts.length - active} historical)`,
        `store    : ${ctx.storeLabel}`,
      `jobs     : ${ctx.jobs.stats.running} running, ${ctx.jobs.stats.queued} queued`,
        `llm      : ${ctx.llmLabel}`,
      ].join('\n');
      return ok(text);
    },
  );}
