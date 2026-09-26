import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Principal } from './auth.js';
import { calendarDay, displayTimeZone } from '../util/time.js';
import { shapes, type AddMemoryOutcome, type FactRow, type JobRow, type MemoryService } from './service.js';

/** How the server introduces itself to MCP clients (stdio and HTTP). */
export const SERVER_INFO = { name: 'minizep', version: '0.2.0' };

/**
 * The MCP `instructions` of the initialize result: what a model that has never
 * seen minizep needs in order to use it. The first paragraph (under 512
 * characters, which some clients keep) stands alone; docs/MEMORY-GUIDE.md,
 * served by memory_guide, has the full method and must agree with this.
 */
export const INSTRUCTIONS = [
  'minizep is your long-term memory: dated facts about people, projects, systems, plans and decisions. ' +
    'Before answering about any of these, call search_facts (or facts_about for one named entity). ' +
    'When you learn something durable, call add_memory with async=true: one event per call, full sentences, ' +
    'every subject named (no "she", "the project"), valid_at = when it happened. ' +
    'When the user contradicts the memory, fix it in the same turn. ' +
    'The memory is a memory, not ground truth: what the user says now wins.',
  '',
  'Writing: state changes as changes ("Dana Wu moved from Orion to Atlas on 2026-03-02"); the old fact closes ' +
    'itself. Do not store secrets, small talk or guesses.',
  'Searching: name the entities in the query. at= gives what was true then, as_of= what the memory believed ' +
    'then, include_historical=true also ended facts.',
  'Repairs: something ended -> invalidate_fact with at; a fact was never true -> invalidate_fact retract=true; ' +
    'a fact closed by mistake -> reopen_fact; a whole note was wrong or unwanted -> forget_episode; writes ' +
    'failed -> graph_stats or memory_job_status, then retry_failed.',
  'Call memory_guide once for the full method with examples.',
].join('\n');

/** McpServer options: every server (stdio and HTTP) describes itself the same way. */
export const SERVER_OPTIONS = { instructions: INSTRUCTIONS };

/**
 * The instructions for one connection: the shared text plus the groups this
 * caller may use, so a model working on some project finds that project's
 * memory instead of searching only the default group.
 */
export function instructionsFor(p: Principal): string {
  const groups =
    p.groups === 'any'
      ? `Groups: this connection may use any group; the default is "${p.defaultGroup}". Call list_groups to see them.`
      : `Groups this connection may use: ${p.groups.map((g) => (g === p.defaultGroup ? `${g} (default)` : g)).join(', ')}.`;
  return [
    INSTRUCTIONS,
    '',
    `${groups} Without group_id every tool uses the default group. When you work on a project or topic that has ` +
      'its own group, pass that group_id on every call; if the default group has nothing about it, call ' +
      'list_groups and search the matching group before concluding the memory is empty.',
  ].join('\n');
}

/** McpServer options for one caller. */
export function serverOptionsFor(p: Principal) {
  return { instructions: instructionsFor(p) };
}

/*
 * Tool annotations, so that clients can run reads without asking and ask
 * before a correction. Nothing reaches outside the memory (openWorldHint).
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
/** add_memory: sending the same note again is a duplicate, and nothing is lost */
const ADDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** retry_failed: re-processes what is already stored */
const REPAIRS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
/** invalidate_fact, reopen_fact, forget_episode: change what the memory holds true (history is kept) */
const CORRECTS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

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

/** Episodes shown by id on a fact line; the others are counted. */
const SHOWN_EPISODES = 3;

/**
 * One fact as a line: `[id] source --RELATION--> target | "text" | validity`,
 * then `| ep <id>, <id> +N` naming the notes it came from (oldest first), the
 * ids get_episode and forget_episode take: a client that shows the model only
 * this text has no other way to them.
 */
export function formatFact(r: FactRow): string {
  const line = `[${r.uuid.slice(0, 8)}] ${r.source} --${r.relation}--> ${r.target} | "${r.fact}" | ${validity(r)}`;
  if (!r.episodes.length) return line;
  const more = r.episodes.length - SHOWN_EPISODES;
  const ids = r.episodes.slice(0, SHOWN_EPISODES).map((e) => e.slice(0, 8)).join(', ');
  return `${line} | ep ${ids}${more > 0 ? ` +${more}` : ''}`;
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

/**
 * Wraps tool registration so that a call which fell back to the default group
 * says so, and names the caller's other groups. Instructions are not shown to
 * the model by every client; a tool result always is. Without this, a model
 * working on a project searched the default group, saw unrelated facts, and
 * wrote the project's notes there.
 */
function withGroupHints(server: McpServer, p: Principal): McpServer {
  const others = p.groups === 'any' ? [] : p.groups.filter((g) => g !== p.defaultGroup);
  if (others.length === 0) return server;
  const read =
    `(no group_id: this used the default group "${p.defaultGroup}". This connection can also use ` +
    `${others.join(', ')}; pass group_id to look there, or call list_groups.)`;
  const write =
    `(no group_id: stored in the default group "${p.defaultGroup}". This connection also has ` +
    `${others.join(', ')}; if this belongs to one of them, call forget_episode on this episode and add it ` +
    'again with that group_id.)';
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const wrapped = Object.create(server) as McpServer;
  wrapped.registerTool = ((name: string, config: { inputSchema?: object }, handler: (...a: unknown[]) => unknown) => {
    if (!config.inputSchema || !('group_id' in config.inputSchema)) return register(name, config, handler);
    return register(name, config, async (args: { group_id?: string } | undefined, extra: unknown) => {
      const result = (await handler(args, extra)) as { content?: { type: string; text?: string }[] };
      const first = result.content?.[0];
      if (args?.group_id || first?.type !== 'text') return result;
      const hint = name === 'add_memory' ? write : read;
      return { ...result, content: [{ ...first, text: `${first.text ?? ''}\n${hint}` }, ...result.content!.slice(1)] };
    });
  }) as McpServer['registerTool'];
  return wrapped;
}

/** Registers every minizep tool on a server instance. Shared by stdio and HTTP. */
export function registerTools(target: McpServer, ctx: ToolContext): void {
  const { service, principal: p } = ctx;
  const server = withGroupHints(target, p);

  server.registerTool(
    'add_memory',
    {
      title: 'Add memory',
      description:
        'Use when you learn something durable (a fact, a change, a decision): one event per call, in full ' +
        'sentences with every subject named, valid_at = when it happened; a change closes the old fact by ' +
        'itself. async=true answers at once with a job id, and a failed extraction is kept and retried. ' +
        'See memory_guide.',
      inputSchema: shapes.addMemory,
      annotations: ADDS,
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
        'Use before answering about people, projects, systems, plans or decisions: searches the facts true ' +
        'now, by keywords and meaning; name the entities in the query. at= for what was true then, as_of= ' +
        'for what the memory believed then, include_historical=true for ended facts too. See memory_guide.',
      inputSchema: shapes.search,
      annotations: READ_ONLY,
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
        'Use when the question is about one named entity: every fact touching it, with when it was true. ' +
        'A partial name resolves to the best match; other plausible matches are listed. See memory_guide.',
      inputSchema: shapes.factsAbout,
      annotations: READ_ONLY,
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
      description:
        'Use for "what was true on <date>": every fact true at that instant, optionally as the memory ' +
        'knew it at as_of. See memory_guide.',
      annotations: READ_ONLY,
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
      description:
        'Use to find how the memory names something, or what it knows exists: entities with their ' +
        'summaries, filtered by a name or summary substring. See memory_guide.',
      inputSchema: shapes.entities,
      annotations: READ_ONLY,
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
        'Use to see the notes the memory was given (newest first) and whether each was processed; every ' +
        'fact traces back to one. See memory_guide.',
      inputSchema: shapes.episodes,
      annotations: READ_ONLY,
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
        'Use to read one note in full (uuid or 8+ character prefix: the ep ids at the end of a fact line) ' +
        'with its status and the facts it produced or reinforced, e.g. before forget_episode. See memory_guide.',
      inputSchema: shapes.episode,
      annotations: READ_ONLY,
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
        'Use when a fact stopped being true (at = when, default now), or with retract=true when it was ' +
        'never true; history is kept for as_of. Fact ids are the bracketed prefixes in search results. ' +
        'See memory_guide.',
      inputSchema: shapes.invalidateFact,
      annotations: CORRECTS,
    },
    (args) =>
      guard(async () => {
        const r = await service.invalidateFact(p, args);
        const what = args.retract ? 'retracted' : `ended at ${r.fact.invalid_at}`;
        return ok(`${what}: ${formatFact(r.fact)}`, r);
      }),
  );

  server.registerTool(
    'reopen_fact',
    {
      title: 'Reopen fact',
      description:
        'Use when a fact was ended or retracted by mistake (also an end still in the future): it is true ' +
        'again from its original start, until invalid_at if given, as a corrected copy with a new id; the ' +
        'closed record stays in history. See memory_guide.',
      inputSchema: shapes.reopenFact,
      annotations: CORRECTS,
    },
    (args) =>
      guard(async () => {
        const r = await service.reopenFact(p, args);
        return ok(`reopened [${r.previous.uuid.slice(0, 8)}] as: ${formatFact(r.fact)}`, r);
      }),
  );

  server.registerTool(
    'retry_failed',
    {
      title: 'Retry failed episodes',
      description:
        'Use when writes failed (graph_stats shows failed episodes) and the cause, e.g. an LLM or embedding ' +
        'outage, is over: re-processes every failed episode of the group in place, given-up ones included. ' +
        'See memory_guide.',
      inputSchema: shapes.group,
      annotations: REPAIRS,
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
      description:
        'Use to check an add_memory made with async=true: pass its job_id, or omit it to list recent jobs. ' +
        'See memory_guide.',
      annotations: READ_ONLY,
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
    'list_groups',
    {
      title: 'List groups',
      description:
        'Use to see which memory groups (namespaces) you can use and how much each holds, e.g. when the default ' +
        'group has nothing about the project you are working on. See memory_guide.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      guard(async () => {
        const r = await service.groups(p);
        if (!r.groups.length) return ok('no groups hold data yet', r);
        const lines = r.groups.map(
          (g) =>
            `${g.group_id}${g.group_id === r.default_group ? ' (default)' : ''}: ${g.active_facts} current facts, ` +
            `${g.facts} in all, ${g.episodes} episodes${g.last_episode_at ? `, last ${g.last_episode_at.slice(0, 10)}` : ''}`,
        );
        return ok(lines.join('\n'), r);
      }),
  );

  server.registerTool(
    'graph_stats',
    {
      title: 'Graph statistics',
      description:
        'Use to check the memory is healthy: episodes by status (failed and given up included), ' +
        'entities, and current and historical facts in one group. See memory_guide.',
      inputSchema: shapes.group,
      annotations: READ_ONLY,
    },
    (args) =>
      guard(async () => {
        const s = await service.stats(p, args);
        const e = s.episodes;
        const lines = [
          `group    : ${s.group_id}`,
          `episodes : ${e.total} (${e.processed} processed, ${e.pending} pending, ${e.failed} failed, ` +
            `${e.forgotten} forgotten)`,
          `entities : ${s.entities}`,
          `facts    : ${s.facts.total} (${s.facts.active} currently true, ${s.facts.historical} historical)`,
          `store    : ${service.storeLabel}`,
          `jobs     : ${s.jobs.running} running, ${s.jobs.queued} queued`,
          `llm      : ${service.llmLabel}`,
        ];
        if (e.failed) {
          lines.push(
            `failed   : ${e.failed}, ${e.given_up} of them tried ${service.retryMax} times or more and no longer ` +
              'retried automatically; call retry_failed once the cause (LLM, embeddings) is fixed',
          );
        }
        return ok(lines.join('\n'), s);
      }),
  );

  server.registerTool(
    'forget_episode',
    {
      title: 'Forget episode',
      description:
        'Use when a whole note was wrong or not wanted (its id: the ep part of a fact line): the facts only ' +
        'it supported are retracted, the others lose it as evidence, the facts it closed are reopened unless ' +
        'a later value still holds, the entity summaries it wrote last are put back, and it is kept as ' +
        '"forgotten". History is kept (as_of). See memory_guide.',
      inputSchema: shapes.forgetEpisode,
      annotations: CORRECTS,
    },
    (args) =>
      guard(async () => {
        const r = await service.forgetEpisode(p, args);
        const list = (rows: FactRow[]) => rows.map((f) => `  ${formatFact(f)}`);
        const lines = [
          `forgot episode ${r.episode.uuid.slice(0, 8)} in group "${r.group_id}" (its text is kept)`,
          `retracted (it was their only evidence): ${r.retracted.length}`,
          ...list(r.retracted),
          `no longer cite it (other evidence remains): ${r.unlinked.length}`,
          ...list(r.unlinked),
          `reopened (it had closed them): ${r.reopened.length}`,
          ...list(r.reopened.map((x) => x.fact)),
        ];
        if (r.still_closed.length) {
          lines.push(
            `still closed (it had closed them, but a later value other notes support takes over there; ` +
              `reopen_fact if that is wrong): ${r.still_closed.length}`,
            ...list(r.still_closed),
          );
        }
        lines.push(
          `entity summaries put back as they were before it (one another note rewrote since stays): ` +
            `${r.restored_summaries.length}`,
          ...r.restored_summaries.map((e) => `  ${e.name} — ${e.summary || '(no summary)'}`),
        );
        if (r.orphaned_entities.length) {
          lines.push(
            `entities it created, left with no fact and no summary (kept): ${r.orphaned_entities.length}`,
            `  ${r.orphaned_entities.map((e) => e.name).join(', ')}`,
          );
        }
        if (r.unmarked_closures.length) {
          lines.push(
            `closed when this episode was processed, by a build that did not record it (check, then reopen_fact ` +
              `if it was this episode): ${r.unmarked_closures.length}`,
            ...list(r.unmarked_closures),
          );
        }
        return ok(lines.join('\n'), r);
      }),
  );

  server.registerTool(
    'memory_guide',
    {
      title: 'Memory guide',
      description:
        'Read once before relying on this memory: how to write, search and repair it, with a decision ' +
        'table and examples (Markdown).',
      annotations: READ_ONLY,
    },
    () => guard(async () => ok(await service.guide())),
  );
}
