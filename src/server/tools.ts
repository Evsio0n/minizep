import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Principal } from './auth.js';
import { calendarDay, displayTimeZone } from '../util/time.js';
import { shapes, type AddMemoryOutcome, type FactRow, type JobRow, type MemoryService } from './service.js';

/** How the server introduces itself to MCP clients (stdio and HTTP). */
export const SERVER_INFO = { name: 'minizep', version: '0.2.0' };

/**
 * Everything the tool handlers need, injected so transports can differ: the
 * shared service and who is calling (a token's principal over HTTP, the local
 * user over stdio).
 */
export interface ToolContext {
  service: MemoryService;
  principal: Principal;
}

// calendar days in the zone the extraction LLM resolved them in
const day = (iso: string | null) => (iso ? calendarDay(new Date(iso), displayTimeZone()) : null);

/** Human-readable validity window, always showing the start when known. */
export function validity(r: FactRow, now = Date.now()): string {
  const start = day(r.valid_at) ?? '?';
  if (r.invalid_at) {
    if (r.valid_at && Date.parse(r.invalid_at) <= Date.parse(r.valid_at)) return 'retracted';
    if (Date.parse(r.invalid_at) > now) return `since ${start}, until ${day(r.invalid_at)}`;
    return `true ${start} → ${day(r.invalid_at)}`;
  }
  if (r.expired_at) return 'retracted';
  if (r.valid_at && Date.parse(r.valid_at) > now) return `from ${start}`;
  return r.valid_at ? `since ${start}` : 'still true';
}

export function formatFact(r: FactRow): string {
  return `[${r.uuid.slice(0, 8)}] ${r.source} --${r.relation}--> ${r.target} | "${r.fact}" | ${validity(r)}`;
}

function ok(text: string, structured?: object) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured as Record<string, unknown> } : {}),
  };
}

function fail(text: string, structured?: object) {
  return { ...ok(text, structured), isError: true };
}

/** Runs a handler; a thrown error (group not permitted, bad input, not found) is a tool error. */
async function guard<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (err) {
    return fail((err as Error).message);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeAdd(o: AddMemoryOutcome, ms: number) {
  const ep = o.episode_uuid.slice(0, 8);
  switch (o.status) {
    case 'queued':
      return ok(
        `queued job ${o.job_id} for episode ${ep} (stored as pending in group "${o.group_id}")\n` +
          'status: queued\npoll memory_job_status with this id',
        o,
      );
    case 'duplicate':
      return ok(`duplicate: episode ${ep} was already processed in group "${o.group_id}"; nothing changed`, o);
    case 'failed':
      return fail(
        `extraction failed: ${o.error}\n` +
          `episode ${ep} is stored for retry in group "${o.group_id}" (status: failed); ` +
          'call retry_failed once the cause is fixed',
        o,
      );
  }
  const lines = [
    `episode ${ep} processed in group "${o.group_id}" (${ms}ms)`,
    `entities: ${o.entities.length ? o.entities.join(', ') : '(none)'}`,
    `new facts: ${o.facts.length ? o.facts.map((f) => f.fact).join(' ; ') : '(none)'}`,
    `reinforced: ${o.reinforced.length}`,
    `invalidated: ${o.invalidated.length ? o.invalidated.map((f) => f.fact).join(' ; ') : '(none)'}`,
  ];
  if (o.dropped.facts || o.dropped.invalidations) {
    lines.push(
      `dropped: ${plural(o.dropped.facts, 'fact')}, ${plural(o.dropped.invalidations, 'invalidation')} ` +
        '(an entity they name could not be resolved)',
    );
  }
  if (o.dropped.entities) {
    lines.push(
      `dropped: ${plural(o.dropped.entities, 'literal value')} ` +
        '(an address, a number, a URL or a version extracted as an entity, used by no fact)',
    );
  }
  return ok(lines.join('\n'), o);
}

function describeJob(job: JobRow): string {
  const lines = [
    `job      : ${job.id}`,
    `status   : ${job.status}`,
    `label    : ${job.label}`,
    job.episode_uuid ? `episode  : ${job.episode_uuid.slice(0, 8)}` : '',
    `created  : ${job.created_at}`,
    job.finished_at ? `finished : ${job.finished_at}` : '',
  ].filter(Boolean);
  if (job.error) lines.push(`error    : ${job.error}`);
  const r = job.result as AddMemoryOutcome | null;
  if (r?.status) {
    lines.push(
      `result   : ${r.status}`,
      `entities : ${r.entities.length}`,
      `facts    : ${r.facts.length}`,
      `reinforced: ${r.reinforced.length}`,
      `invalidated: ${r.invalidated.length}`,
    );
    if (r.dropped.entities || r.dropped.facts || r.dropped.invalidations) {
      lines.push(
        `dropped  : ${r.dropped.entities} entities, ${r.dropped.facts} facts, ${r.dropped.invalidations} invalidations`,
      );
    }
  }
  return lines.join('\n');
}

/** Registers every minizep tool on a server instance. Shared by stdio and HTTP. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { service, principal: p } = ctx;

  server.registerTool(
    'add_memory',
    {
      title: 'Add memory',
      description:
        'Ingest text into the temporal knowledge graph. Extracts entities and facts, and marks ' +
        'relationships that the text says have ended as invalid (historical facts are kept, not deleted). ' +
        'Reports processed, duplicate or failed; a failed episode is kept and can be retried.',
      inputSchema: shapes.addMemory,
    },
    (args) =>
      guard(async () => {
        const started = Date.now();
        return describeAdd(await service.addMemory(p, args), Date.now() - started);
      }),
  );

  server.registerTool(
    'search_facts',
    {
      title: 'Search facts',
      description:
        'Hybrid search (BM25 + embeddings + rank fusion) over facts. By default only currently-true ' +
        'facts are returned; pass at= to time-travel, as_of= for what was known then, or ' +
        'include_historical=true for the full history.',
      inputSchema: shapes.search,
    },
    (args) =>
      guard(async () => {
        const r = await service.search(p, args);
        const note = r.degraded ? '\n(keyword ranking only: the embedding service is unavailable)' : '';
        if (!r.facts.length) return ok(`no matching facts${note}`, r);
        return ok(r.facts.map(formatFact).join('\n') + note, r);
      }),
  );

  server.registerTool(
    'facts_about',
    {
      title: 'Facts about an entity',
      description:
        'Every fact touching one entity, with its temporal validity window. A partial name resolves ' +
        'to the best match; other plausible matches are listed.',
      inputSchema: shapes.factsAbout,
    },
    (args) =>
      guard(async () => {
        const r = await service.factsAbout(p, args);
        if (!r.entity) return ok(`no entity matches "${args.entity}"`, r);
        const lines = [`facts about ${r.entity.name}:`];
        lines.push(...(r.facts.length ? r.facts.map(formatFact) : ['(none)']));
        if (r.candidates.length) lines.push(`other matches: ${r.candidates.map((c) => c.name).join(', ')}`);
        return ok(lines.join('\n'), r);
      }),
  );

  server.registerTool(
    'facts_at',
    {
      title: 'Time travel',
      description: 'What the graph believed was true at a given instant (bi-temporal query).',
      inputSchema: {
        timestamp: z.string().optional().describe('ISO-8601 instant, e.g. 2024-06-01T00:00:00Z (default now)'),
        as_of: shapes.factsAt.as_of,
        group_id: shapes.factsAt.group_id,
        limit: shapes.factsAt.limit,
      },
    },
    ({ timestamp, ...rest }) =>
      guard(async () => {
        const r = await service.factsAt(p, { ...rest, at: timestamp });
        if (!r.facts.length) return ok(`nothing was true at ${r.at}`, r);
        return ok(r.facts.map(formatFact).join('\n'), r);
      }),
  );

  server.registerTool(
    'list_entities',
    {
      title: 'List entities',
      description: 'Entities in the graph, optionally filtered by a name/summary substring.',
      inputSchema: shapes.entities,
    },
    (args) =>
      guard(async () => {
        const r = await service.entities(p, args);
        if (!r.entities.length) return ok('no entities', r);
        return ok(r.entities.map((e) => `${e.name} [${e.labels.join(',')}] — ${e.summary}`).join('\n'), r);
      }),
  );

  server.registerTool(
    'list_episodes',
    {
      title: 'List episodes',
      description:
        'Raw ingested data (provenance), newest first, with its processing status. ' +
        'Everything in the graph traces back to these.',
      inputSchema: shapes.episodes,
    },
    (args) =>
      guard(async () => {
        const r = await service.episodes(p, args);
        // the full text is one get_episode away; the listing only previews it
        const episodes = r.episodes.map(({ content, ...e }) => ({ ...e, preview: content.slice(0, 200) }));
        if (!episodes.length) return ok('no episodes', { ...r, episodes });
        return ok(
          episodes
            .map((e) => `${e.uuid.slice(0, 8)} ${day(e.valid_at)} [${e.status}] — ${e.preview.slice(0, 120)}`)
            .join('\n'),
          { ...r, episodes },
        );
      }),
  );

  server.registerTool(
    'get_episode',
    {
      title: 'Get episode',
      description:
        'One episode (by uuid or a prefix of at least 8 characters) with its status, full text and ' +
        'the facts it produced or reinforced.',
      inputSchema: shapes.episode,
    },
    (args) =>
      guard(async () => {
        const r = await service.episode(p, args);
        const e = r.episode;
        const lines = [
          `episode  : ${e.uuid}`,
          `group    : ${e.group_id}`,
          `status   : ${e.status}${e.error ? ` (${e.error})` : ''}`,
          `valid_at : ${e.valid_at}`,
          `created  : ${e.created_at}`,
          `name     : ${e.name}`,
          '',
          e.content,
          '',
          `facts first stated here (${r.facts.length}):`,
          ...r.facts.map(formatFact),
        ];
        if (r.reinforced.length) lines.push(`reinforced (${r.reinforced.length}):`, ...r.reinforced.map(formatFact));
        return ok(lines.join('\n'), r);
      }),
  );

  server.registerTool(
    'invalidate_fact',
    {
      title: 'Invalidate fact',
      description:
        'Close a fact by hand: it stopped being true at `at` (default now). With retract=true the fact ' +
        'is treated as never having been true. History is kept either way (as_of still shows what was ' +
        'believed before). Fact ids are shown in brackets by the search tools.',
      inputSchema: shapes.invalidateFact,
    },
    (args) =>
      guard(async () => {
        const r = await service.invalidateFact(p, args);
        const what = args.retract ? 'retracted' : `ended at ${r.fact.invalid_at}`;
        return ok(`${what}: ${formatFact(r.fact)}`, r);
      }),
  );

  server.registerTool(
    'retry_failed',
    {
      title: 'Retry failed episodes',
      description:
        'Re-process the episodes whose extraction failed (e.g. during an LLM or embedding outage), in place.',
      inputSchema: shapes.group,
    },
    (args) =>
      guard(async () => {
        const r = await service.retryFailed(p, args);
        const text =
          `retried ${plural(r.retried, 'failed episode')} in group "${r.group_id}": ` +
          `${r.succeeded} succeeded, ${r.still_failing} still failing`;
        return r.still_failing ? fail(text, r) : ok(text, r);
      }),
  );

  server.registerTool(
    'memory_job_status',
    {
      title: 'Ingestion job status',
      description: 'Check an asynchronous add_memory job. Omit job_id to list recent jobs.',
      inputSchema: {
        job_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ job_id, limit }) =>
      guard(async () => {
        if (job_id) {
          const job = service.job(p, job_id);
          return ok(describeJob(job), job);
        }
        const jobs = service.listJobs(p, limit ?? 20);
        if (jobs.length === 0) return ok('no jobs', { jobs });
        return ok(jobs.map((j) => `${j.id.slice(0, 8)} ${j.status.padEnd(9)} ${j.label}`).join('\n'), { jobs });
      }),
  );

  server.registerTool(
    'graph_stats',
    {
      title: 'Graph statistics',
      description: 'Counts of episodes (by status), entities, active and historical facts in one group.',
      inputSchema: shapes.group,
    },
    (args) =>
      guard(async () => {
        const s = await service.stats(p, args);
        const text = [
          `group    : ${s.group_id}`,
          `episodes : ${s.episodes.total} (${s.episodes.processed} processed, ${s.episodes.pending} pending, ` +
            `${s.episodes.failed} failed)`,
          `entities : ${s.entities}`,
          `facts    : ${s.facts.total} (${s.facts.active} currently true, ${s.facts.historical} historical)`,
          `store    : ${service.storeLabel}`,
          `jobs     : ${s.jobs.running} running, ${s.jobs.queued} queued`,
          `llm      : ${service.llmLabel}`,
        ].join('\n');
        return ok(text, s);
      }),
  );
}
