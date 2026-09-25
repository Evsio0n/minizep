# minizep HTTP API

One server (`minizep-serve`, `src/server/http.ts`) exposes three surfaces that share one graph,
one ingestion queue and one set of credentials:

| Path      | What                                         | Auth   |
|-----------|----------------------------------------------|--------|
| `/health` | liveness probe, always `{"ok":true}`         | none   |
| `/mcp`    | MCP over Streamable HTTP (tools, see below)  | bearer |
| `/v1/...` | REST API, JSON in / JSON out                 | bearer |

Everything below applies to both `/mcp` and `/v1`: the MCP tools and the REST routes call the
same operations with the same validation.

---

## Authentication

Every `/mcp` and `/v1` request carries a bearer token:

```
Authorization: Bearer <token>
```

Tokens are configured on the server:

```bash
MINIZEP_TOKENS="tokA:teamA,tokB:teamB,tokC:teamC|shared"
```

Each entry is `token:group[|group...]`. The token is everything before the **last** colon (tokens
may contain colons). The groups after it are the memory namespaces the token may read and write;
the **first** one is the token's default.

| Situation                                   | Status | Body                                        |
|---------------------------------------------|--------|---------------------------------------------|
| no `Authorization` header, or not `Bearer`  | 401    | `{"error":"missing bearer token"}` (+ `WWW-Authenticate: Bearer`) |
| unknown token                               | 403    | `{"error":"invalid token"}`                 |
| server started without any token            | 401    | `{"error":"authentication is not configured"}` |

With no tokens configured the server refuses to start, unless `MINIZEP_ALLOW_ANONYMOUS=1` is set
(local development only). In that mode every request is one trusted user who may use any group
(default group `default`).

## Groups

Every operation works inside exactly one memory group, chosen by the optional `group_id`
parameter (in the JSON body for `POST`, in the query string for `GET`):

1. absent or empty: the token's default group (its first group);
2. a group the token holds: that group;
3. anything else: **403** `{"error":"group not permitted for this token"}` (an MCP tool returns
   the same message as a tool error, `isError: true`). Nothing is read or written.

Names match exactly (case and whitespace included). Records are addressed inside the resolved
group: an episode, fact or job id that belongs to another group answers **404**, exactly like an
id that does not exist, so a token cannot probe other tenants.

The stdio server (`minizep-mcp`) serves one local user and accepts any `group_id`
(default: `MINIZEP_GROUP`, else `default`).

## Conventions

- Bodies are JSON objects (`Content-Type: application/json`); fields are `snake_case`.
- Request bodies are limited to **1 MB**; larger ones get **413**.
- Timestamps are ISO-8601. Responses use UTC (`2024-03-01T09:00:00.000Z`); requests may use any
  offset. An unparseable timestamp is a 400.
- Two time axes (bi-temporal):
  - `at`: **valid time**, when something was true in the real world (default: now);
  - `as_of`: **knowledge time**, answer with what the graph knew at that instant (default: now).
    `as_of` shows facts as they were believed before a later correction or retraction.
- `include_historical=true` returns facts regardless of whether they are still true.
- Ids: episodes and facts may be addressed by their full uuid or by a prefix of at least
  8 characters (the MCP tools show 8-character prefixes). A prefix matching several records is a
  400; ask again with more characters.

### Errors

Every error is `{"error": "<message>"}`:

| Status | Meaning |
|--------|---------|
| 400 | invalid JSON, body not an object, a missing/invalid field, bad timestamp, id prefix too short or ambiguous |
| 401 | missing bearer token |
| 403 | invalid token; group not permitted for this token |
| 404 | unknown route, or no such record in the resolved group |
| 405 | route exists with another method (`Allow` header lists it) |
| 409 | the request conflicts with the fact's current state (already ended, already retracted, end before start) |
| 413 | request body larger than 1 MB |
| 500 | unexpected server error (`{"error":"internal error"}`, details in the server log) |
| 502 | ingestion failed upstream (LLM, embedding service or store); the episode is **kept** for retry |
| 503 | server shutting down; or (MCP) session limit reached with every session busy |

### Rows

**Fact**

```json
{
  "uuid": "160f2ea7-4f54-471f-8011-f1ab4da81163",
  "relation": "WORKS_AT",
  "source": "Alice",
  "target": "Acme",
  "fact": "Alice works at Acme",
  "valid_at": "2024-03-01T09:00:00.000Z",
  "invalid_at": null,
  "created_at": "2026-09-25T06:14:54.414Z",
  "expired_at": null,
  "episodes": ["6eeafffa-6fc3-483f-9132-e47ae67eafc2"],
  "score": null
}
```

`valid_at`/`invalid_at` bound when the fact was true (`null`: unknown start / still true).
`created_at` is when the graph learned it, `expired_at` when the graph learned it had ended (or
was retracted). A retracted fact has `invalid_at == valid_at` (or no `invalid_at` but an
`expired_at`). `episodes` lists the evidence, oldest first. `score` is the fused retrieval score on
search results, `null` elsewhere.

**Entity**: `{uuid, name, labels, summary, created_at}`.

**Episode**: `{uuid, group_id, name, source, source_description, content, valid_at, created_at,
status, error}`. `status` is `pending` (saved, not processed yet), `processed` or `failed` (with
`error`). Records written before statuses were stored report `processed`.

---

## REST endpoints

Examples use `$TOKEN` for a token and `http://127.0.0.1:8787` for the server.

### POST /v1/memories

Ingest text: extract entities and facts, and close relationships the text says have ended.

| Field             | Type    | Notes |
|-------------------|---------|-------|
| `content`         | string  | required |
| `group_id`        | string  | see [Groups](#groups) |
| `valid_at`        | string  | when it happened (default now); also the reference for relative dates ("yesterday") |
| `source`          | string  | `text` (default), `json` or `markdown` |
| `name`            | string  | short label (default: start of the content) |
| `idempotency_key` | string  | 1-200 chars; a resend with the same key in the same group is a duplicate, whatever its content. Without it, the key is the normalised content plus the UTC day of `valid_at` |
| `async`           | boolean | store and queue instead of waiting (see below) |

```bash
curl -s -X POST http://127.0.0.1:8787/v1/memories \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"Alice works at Acme.","valid_at":"2024-03-01T09:00:00Z"}'
```

`201 Created`, processed:

```json
{
  "status": "processed",
  "group_id": "teamA",
  "episode_uuid": "6eeafffa-6fc3-483f-9132-e47ae67eafc2",
  "job_id": null,
  "error": null,
  "entities": ["Alice", "Acme"],
  "facts": [ { "uuid": "160f2ea7-…", "relation": "WORKS_AT", "source": "Alice", "target": "Acme", "…": "…" } ],
  "reinforced": [],
  "invalidated": [],
  "dropped": { "facts": 0, "invalidations": 0 }
}
```

- `facts`: new facts; `reinforced`: existing facts this text restated; `invalidated`: existing
  facts this text ended.
- `dropped`: extracted candidates that were discarded because one of their entities could not be
  resolved. Non-zero means the text said more than the graph recorded.

Other outcomes:

| Status | `status`    | Meaning |
|--------|-------------|---------|
| 200    | `duplicate` | this episode was already processed in this group; nothing changed |
| 202    | `queued`    | `async: true`: the episode is **stored as pending before** this answer; poll `job_id` |
| 502    | `failed`    | extraction failed; the episode is kept with status `failed` for retry |

```json
{
  "status": "failed",
  "group_id": "teamA",
  "episode_uuid": "b89af07b-51bd-40dc-b4a3-2a6e5e3f06ce",
  "job_id": null,
  "error": "extraction failed: LLM HTTP 500: upstream error (episode stored for retry)",
  "entities": [], "facts": [], "reinforced": [], "invalidated": [],
  "dropped": { "facts": 0, "invalidations": 0 }
}
```

Retrying a failed request is safe: the same episode (same idempotency key) is re-processed in
place, never duplicated.

### GET /v1/memories/jobs/:id

Status of an async ingestion (`id`: full job id, or a prefix of at least 8 characters).

```json
{
  "id": "504315e4-c667-4fe4-82bf-ca2de4e022c8",
  "status": "succeeded",
  "label": "add_memory:teamA",
  "group_id": "teamA",
  "episode_uuid": "f5c9d7f3-2c4a-453b-ad2b-8d17cf7464b3",
  "created_at": "2026-09-25T06:14:54.427Z",
  "started_at": "2026-09-25T06:14:54.427Z",
  "finished_at": "2026-09-25T06:14:54.433Z",
  "error": null,
  "result": { "status": "processed", "…": "same shape as POST /v1/memories" }
}
```

`status` is `queued`, `running`, `succeeded` or `failed`. A failed extraction fails the job, with
`error` like `extraction failed: … (episode stored for retry)`; the episode can then be retried.
Jobs live in memory (up to 200, unfinished ones are never dropped); the episode itself is durable. A job of
another group is 404.

### POST /v1/search

Hybrid search (keyword BM25 + embeddings, rank fusion) over facts.

| Field                | Type    | Notes |
|----------------------|---------|-------|
| `query`              | string  | required |
| `group_id`           | string  | |
| `limit`              | integer | 1-50, default 10 |
| `at`                 | string  | only facts true at that instant |
| `as_of`              | string  | as known at that instant |
| `include_historical` | boolean | also facts that are no longer true |

```json
{
  "group_id": "teamA",
  "degraded": false,
  "facts": [ { "uuid": "160f2ea7-…", "fact": "Alice works at Acme", "score": 0.0328, "…": "…" } ]
}
```

`degraded: true` means the query could not be embedded (embedding service down) and only keyword
ranking ran.

### GET /v1/entities

`?query=&group_id=&limit=` (limit 1-200, default 50). `query` is a case-insensitive substring of
the name or the summary.

```json
{ "group_id": "teamA",
  "entities": [ { "uuid": "066914c3-…", "name": "Alice", "labels": ["Person"],
                  "summary": "…", "created_at": "2026-09-25T06:14:54.414Z" } ] }
```

### GET /v1/entities/:name/facts

Facts about one entity, newest first. `:name` is URL-encoded and may be partial ("Alice" finds
"Alice Chen"): the best match is used, the other plausible matches are returned as `candidates`.
Query: `group_id`, `at`, `as_of`, `include_historical`, `limit` (1-100, default 50).

```bash
curl -s "http://127.0.0.1:8787/v1/entities/Alice/facts?include_historical=true" -H "Authorization: Bearer $TOKEN"
```

```json
{ "group_id": "teamA",
  "entity": { "uuid": "066914c3-…", "name": "Alice", "…": "…" },
  "facts": [ { "fact": "Alice works at Acme", "valid_at": "2024-03-01T09:00:00.000Z",
               "invalid_at": "2024-06-01T00:00:00.000Z", "…": "…" } ],
  "candidates": [] }
```

404 when no entity matches.

### GET /v1/facts

Time travel: every fact true at `at` (default now), as known at `as_of`.
Query: `at`, `as_of`, `group_id`, `limit` (1-1000, default 100).

```json
{ "group_id": "teamA", "at": "2024-04-01T00:00:00.000Z", "facts": [ { "…": "…" } ] }
```

### GET /v1/episodes

Raw ingested text (provenance), newest first. Query: `group_id`, `limit` (1-100, default 20).

```json
{ "group_id": "teamA",
  "episodes": [ { "uuid": "b89af07b-…", "group_id": "teamA", "name": "Bob works at Borealis.",
                  "source": "text", "source_description": "user input",
                  "content": "Bob works at Borealis.", "valid_at": "…", "created_at": "…",
                  "status": "failed", "error": "LLM HTTP 500: upstream error" } ] }
```

### GET /v1/episodes/:id

One episode (uuid or prefix of at least 8 characters, `?group_id=` optional) with the facts it
introduced (`facts`: it is their first evidence) and the existing facts it restated
(`reinforced`). Facts an episode ended are not linked back to it; see `invalidated` in the
ingestion result instead.

```json
{ "episode": { "uuid": "6eeafffa-…", "status": "processed", "content": "Alice works at Acme.", "…": "…" },
  "facts": [ { "fact": "Alice works at Acme", "…": "…" } ],
  "reinforced": [] }
```

### POST /v1/episodes/retry-failed

Re-process, in place, every `failed` episode of the group (e.g. after an LLM or embedding outage).
Body (optional): `{"group_id": "..."}`. Runs synchronously.

```json
{ "group_id": "teamA", "retried": 1, "succeeded": 1, "still_failing": 0 }
```

### POST /v1/facts/:uuid/invalidate

Correct the graph by hand. `:uuid` is the fact uuid or a prefix of at least 8 characters.

| Field      | Type    | Notes |
|------------|---------|-------|
| `reason`   | string  | required, kept on the fact |
| `at`       | string  | when it stopped being true (default now); must be after the fact's `valid_at` |
| `retract`  | boolean | the fact was **never** true: its window becomes empty (`at` is ignored) |
| `group_id` | string  | |

```bash
curl -s -X POST http://127.0.0.1:8787/v1/facts/160f2ea7/invalidate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"at":"2024-05-15T00:00:00Z","reason":"correction from HR"}'
```

```json
{ "group_id": "teamA",
  "fact": { "uuid": "160f2ea7-…", "valid_at": "2024-03-01T09:00:00.000Z",
            "invalid_at": "2024-05-15T00:00:00.000Z", "expired_at": "2026-09-25T06:14:54.466Z", "…": "…" } }
```

Nothing is deleted: queries with an `as_of` before the correction still return what was believed
then. An earlier end than the recorded one is allowed; 409 when the fact had already ended at or
before `at` (`fact already ended at …`), when `at` is not after its start, or when it is already
retracted.

### GET /v1/stats

`?group_id=`

```json
{ "group_id": "teamA",
  "episodes": { "total": 3, "pending": 0, "processed": 3, "failed": 0 },
  "entities": 4,
  "facts": { "total": 2, "active": 1, "historical": 1 },
  "jobs": { "queued": 0, "running": 0 } }
```

Counts are for that group only (`jobs` too).

### GET /v1/status

Server details for an authenticated caller (what `/health` used to expose):

```json
{ "ok": true,
  "store": "postgres (postgres://user:***@db.example:5432/minizep, dims=1024)",
  "llm": "<model> @ <llm base url>",
  "default_group": "teamA",
  "groups": ["teamA"],
  "jobs": { "queued": 0, "running": 0 },
  "sessions": 0 }
```

`groups` is `null` in anonymous mode (any group). `jobs` and `sessions` count only what this
token can see.

### GET /health

Unauthenticated liveness probe for load balancers and container health checks. Always
`{"ok":true}`, nothing else.

---

## MCP endpoint (`/mcp`)

Streamable HTTP transport, stateful sessions. Clients send `initialize` without a session id and
use the returned `Mcp-Session-Id` afterwards.

- A session is **bound to the token that created it**: a request with another token and that
  session id is refused with 403 (`session belongs to another token`).
- Unknown or expired session id: 404 (`Session not found`); per the MCP specification the client
  starts a new session. `minizep-proxy` does this transparently.
- Sessions expire after `MINIZEP_SESSION_TTL_MS` (default 30 min) without requests. A client's open
  SSE stream (`GET /mcp`) does not keep a session alive; a request in progress does.
- At most `MINIZEP_MAX_SESSIONS` sessions (default 256): a new session evicts the one idle for
  longest; when every session has a request in progress, `initialize` gets 503.
- A request without a session id must be `initialize` (else 400). Bodies are limited to 1 MB.

### Tools

Every tool that takes `group_id` follows the [group rules](#groups). Tool results carry a text
rendering and the same JSON as the REST API in `structuredContent`.

| Tool                | Arguments | REST equivalent |
|---------------------|-----------|-----------------|
| `add_memory`        | `content`, `group_id?`, `valid_at?`, `source?`, `name?`, `idempotency_key?`, `async?` | `POST /v1/memories` |
| `memory_job_status` | `job_id?` (omit to list recent jobs), `limit?` | `GET /v1/memories/jobs/:id` |
| `search_facts`      | `query`, `group_id?`, `limit?`, `at?`, `as_of?`, `include_historical?` | `POST /v1/search` |
| `facts_about`       | `entity`, `group_id?`, `at?`, `as_of?`, `include_historical?`, `limit?` | `GET /v1/entities/:name/facts` |
| `facts_at`          | `timestamp?` (valid time, default now), `as_of?`, `group_id?`, `limit?` (default 100) | `GET /v1/facts` |
| `list_entities`     | `query?`, `group_id?`, `limit?` | `GET /v1/entities` |
| `list_episodes`     | `group_id?`, `limit?` | `GET /v1/episodes` (text preview only) |
| `get_episode`       | `id` (uuid or 8+ char prefix), `group_id?` | `GET /v1/episodes/:id` |
| `invalidate_fact`   | `uuid`, `reason`, `at?`, `retract?`, `group_id?` | `POST /v1/facts/:uuid/invalidate` |
| `retry_failed`      | `group_id?` | `POST /v1/episodes/retry-failed` |
| `graph_stats`       | `group_id?` | `GET /v1/stats` |

`add_memory` reports `processed`, `duplicate`, `queued` or `failed`; a failed extraction is a tool
error (`isError: true`) whose text says the episode is stored for retry. Fact lines look like

```
[160f2ea7] Alice --WORKS_AT--> Acme | "Alice works at Acme" | since 2024-03-01
```

with the validity rendered as `since <start>`, `true <start> → <end>`, `since <start>, until
<future end>`, `from <future start>`, `still true` (start unknown) or `retracted`. The bracketed
prefix is what `invalidate_fact` takes.

### stdio clients

`minizep-proxy` (`src/server/stdio-proxy.ts`) bridges a stdio-only MCP client to this endpoint and
forwards the tool list verbatim, so new tools need no proxy change:

```bash
MINIZEP_HTTP_URL=http://127.0.0.1:8787/mcp MINIZEP_TOKEN=$TOKEN minizep-proxy
```

---

## Durability and shutdown

- `async` ingestion stores the episode as `pending` **before** answering (the JSON snapshot is
  written too when the server runs without a database). A job then processes it.
- At startup the server re-enqueues every `pending` episode left by a previous process. Episodes
  written before statuses existed are treated as processed and are not touched.
- On SIGTERM/SIGINT the server stops accepting requests, waits up to `MINIZEP_DRAIN_TIMEOUT_MS`
  (default 120 s) for queued and in-flight ingestion, writes the snapshot and exits. Work not done
  by then stays `pending` and is picked up at the next start. A second signal exits at once.
- The stdio server (`minizep-mcp`) does the same when its client disconnects (stdin closes).

## Server configuration

| Variable                   | Default      | Meaning |
|----------------------------|--------------|---------|
| `MINIZEP_HOST`             | `127.0.0.1`  | comma-separated listen addresses, e.g. `127.0.0.1,100.64.0.10`. An address that does not exist yet (a VPN interface that comes up later) is retried with backoff (1 s doubling to 30 s) instead of failing; other bind errors are fatal |
| `MINIZEP_PORT`             | `8787`       | |
| `MINIZEP_TOKENS`           |              | `token:group[\|group...],...` |
| `MINIZEP_ALLOW_ANONYMOUS`  |              | `1` = no authentication, any group (development only) |
| `MINIZEP_SESSION_TTL_MS`   | `1800000`    | idle MCP session lifetime |
| `MINIZEP_MAX_SESSIONS`     | `256`        | MCP session cap |
| `MINIZEP_DRAIN_TIMEOUT_MS` | `120000`     | shutdown wait for queued ingestion (HTTP and stdio) |
| `MINIZEP_JOB_CONCURRENCY`  | `2`          | ingestion jobs run at once |

Storage, LLM and embedding settings (`MINIZEP_DATABASE_URL`, `MINIZEP_DB`, `MINIZEP_LLM_*`,
`MINIZEP_EMBED_*`, …) are described in the README.
