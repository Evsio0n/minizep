# minizep HTTP API

One server (`minizep-serve`, `src/server/http.ts`) exposes these surfaces, which share one graph
and one ingestion queue:

| Path              | What                                                   | Auth   |
|-------------------|--------------------------------------------------------|--------|
| `/health`         | liveness probe, always `{"ok":true}`                   | none   |
| `/mcp`            | MCP over Streamable HTTP (tools, see below)            | bearer |
| `/v1/...`         | REST API, JSON in / JSON out                           | bearer |
| `/ui`             | web UI page, only when `MINIZEP_UI` (or the deprecated `MINIZEP_UI_GROUPS`) is set | none, see [Web UI](#web-ui) |
| `/ui/api/login`, `/ui/api/logout`, `/ui/api/me` | the UI's login | see [Web UI](#web-ui) |
| `/ui/api/v1/...`  | the same REST API for the UI                           | session cookie, see [Web UI](#web-ui) |

Everything below applies to both `/mcp` and `/v1`: the MCP tools and the REST routes call the
same operations with the same validation.

---

## Authentication

Every `/mcp` and `/v1` request carries a bearer token:

```
Authorization: Bearer <token>
```

Tokens come from two places:

- **Users' tokens** (`mz_...`), kept in the database: each belongs to a user, whose role in each
  group (reader, writer or owner) the token may narrow. They are made with `minizep-admin`, by an
  admin over `/v1/admin`, or by their user over `/v1/me/tokens`. See [ACCESS.md](ACCESS.md).
- **Env tokens**, configured on the server:

  ```bash
  MINIZEP_TOKENS="tokA:teamA,tokB:teamB,tokC:teamC|shared"
  ```

  Each entry is `token:group[|group...]`. The token is everything before the **last** colon
  (tokens may contain colons). The groups after it are the memory namespaces the token may read
  and write (a group name cannot contain `*`); the **first** one is the token's default. They are
  checked first.

| Situation                                   | Status | Body                                        |
|---------------------------------------------|--------|---------------------------------------------|
| no `Authorization` header, or not `Bearer`  | 401    | `{"error":"missing bearer token"}` (+ `WWW-Authenticate: Bearer`) |
| unknown token; revoked or expired token; disabled user | 403 | `{"error":"invalid token"}`   |
| server started without any token            | 401    | `{"error":"authentication is not configured"}` |

With neither an env token nor a user in the database the server refuses to start, unless
`MINIZEP_ALLOW_ANONYMOUS=1` is set (local development only). In that mode every request is one
trusted user who may use any group (default group `default`) and add users; once a user exists,
every request needs a token.

## Groups

Every operation works inside exactly one memory group, chosen by the optional `group_id`
parameter (in the JSON body for `POST`, in the query string for `GET`):

1. absent or empty: the token's default group (an env token's first group; a user's token: its
   own default group, else its user's); when the caller cannot read it, **403**
   `{"error":"no default group: pass group_id"}`;
2. a group the caller may read: that group;
3. anything else: **403** `{"error":"group not permitted for this token"}` (an MCP tool returns
   the same message as a tool error, `isError: true`). Nothing is read or written.

Writes (`POST /v1/memories`, the `invalidate`, `reopen`, `forget` and `retry-failed` routes and
their tools) need the writer role: in a group the caller may only read they answer **403**
`{"error":"read-only access to group \"<g>\""}`. Env tokens are writers on their groups; see
[ACCESS.md](ACCESS.md#roles) for the roles of users.

Names match exactly (case and whitespace included); a user's grant may also cover every group
starting with a prefix (`bob/*`). Records are addressed inside the resolved
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
| 401 | missing bearer token; (UI) `login required` |
| 403 | invalid token; group not permitted for this token; no default group; read-only access to the group; not an owner of the group or not an admin ([ACCESS.md](ACCESS.md)) |
| 404 | unknown route, or no such record in the resolved group |
| 405 | route exists with another method (`Allow` header lists it) |
| 409 | the request conflicts with the record's current state (fact already ended, already retracted, end before start, nothing to reopen; episode already forgotten; user name taken) |
| 413 | request body larger than 1 MB |
| 429 | (UI) too many failed logins from this address |
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
  "source_uuid": "066914c3-5b1e-4a52-9d7e-2f0c1a9b8e11",
  "target_uuid": "8d2b7f40-93c1-4e1a-b6f2-5a0e7c3d9f24",
  "fact": "Alice works at Acme",
  "valid_at": "2024-03-01T09:00:00.000Z",
  "invalid_at": null,
  "created_at": "2026-09-25T06:14:54.414Z",
  "expired_at": null,
  "episodes": ["6eeafffa-6fc3-483f-9132-e47ae67eafc2"],
  "score": null,
  "reason": null
}
```

`valid_at`/`invalid_at` bound when the fact was true (`null`: unknown start / still true).
`created_at` is when the graph learned it, `expired_at` when the graph learned it had ended (or
was retracted). A retracted fact has `invalid_at == valid_at` (or no `invalid_at` but an
`expired_at`). `episodes` lists the evidence, oldest first. `score` is the fused retrieval score on
search results, `null` elsewhere. `source_uuid`/`target_uuid` are the endpoint entities (see
[GET /v1/entities/:id](#get-v1entitiesid)); `reason` is why the fact was ended or retracted, when
that is known (the invalidation reason, or the extractor's), else `null`.

**Entity**: `{uuid, name, labels, summary, created_at}`.

**Fact states.** The graph endpoints below also give each fact its state at one (`at`,
`as_of`) instant; a fact the graph did not know at `as_of` is left out altogether:

| `state`     | Meaning |
|-------------|---------|
| `active`    | true at `at`, as known at `as_of` (exactly the facts `GET /v1/facts` returns) |
| `future`    | starts after `at` (`valid_at > at`) |
| `ended`     | its end, known at `as_of`, is at or before `at` |
| `retracted` | it was never true (empty window, or expired without any end), and that was known at `as_of` |

plus `ends_at` (`invalid_at` as it was known at `as_of`: `null` when that end was learned
later) and `revised_later` (`expired_at > as_of`: a later correction exists).

**Episode**: `{uuid, group_id, name, source, source_description, content, valid_at, created_at,
status, error, attempts}`. `status` is `pending` (saved, not processed yet), `processed`, `failed`
(with `error`) or `forgotten` (see [forget](#post-v1episodesidforget); `error` holds the reason).
Records written before statuses were stored report `processed`. `attempts` counts the times
processing was started, automatic and manual retries included.

---

## REST endpoints

Examples use `$TOKEN` for a token and `http://127.0.0.1:8787` for the server.

### POST /v1/memories

Ingest text: extract entities and facts, and close relationships the text says have ended.

| Field             | Type    | Notes |
|-------------------|---------|-------|
| `content`         | string  | required |
| `group_id`        | string  | see [Groups](#groups) |
| `valid_at`        | string  | when it happened (default now); also the reference for relative dates ("yesterday"). Left out or within a day of the call, it only dates when the note was written: see below |
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
  "dropped": { "entities": 0, "facts": 0, "invalidations": 0 }
}
```

- `facts`: new facts; `reinforced`: existing facts this text restated; `invalidated`: existing
  facts this text ended. One that was still true can be put back with
  [reopen](#post-v1factsuuidreopen).
- A fact's `valid_at` is the date the text gives, else the episode's. When the text gives none and
  the episode's `valid_at` was left out or is within a day of when it was saved, the fact only held
  when the note was written and its start is unknown. When a text stored later says, with a date
  of its own, that this relation ended before the note was written (an invalidation that names the
  relation and gives its end: a move "in July" stored after a note written in September), the note
  was out of date already: the fact is retracted (`invalid_at == valid_at`, `reason` "outdated when
  written; …") and the new fact does not stop at the note's date. A value that only conflicts with
  the note does not do that, since a document added late looks the same as a correction learned
  late; nor does an end with no date of its own, one that names no relation, or one that closes a
  stint the same text records ("from 2015 to 2017"). Like any older statement, such a value ends
  where the note begins, and a fact with a dated start is never ended by an older statement at
  all. An old document that only says the relation ended ("left in 2017") still outdates a note
  about a later stint of it: give the note's start in its text to prevent that.
- `dropped`: extracted candidates that were discarded. `facts` and `invalidations` name an entity
  that could not be resolved: non-zero means the text said more than the graph recorded. `entities`
  are names that are only a literal value (an IP address, a number, a URL, a version) with no fact
  on them: the extraction noise that is kept out of the graph.

Other outcomes:

| Status | `status`    | Meaning |
|--------|-------------|---------|
| 200    | `duplicate` | this episode was already processed in this group; nothing changed |
| 202    | `queued`    | `async: true`: the episode is **stored as pending before** this answer; poll `job_id` |
| 502    | `failed`    | extraction failed; the episode is kept with status `failed` and [retried](#durability-and-shutdown) |

```json
{
  "status": "failed",
  "group_id": "teamA",
  "episode_uuid": "b89af07b-51bd-40dc-b4a3-2a6e5e3f06ce",
  "job_id": null,
  "error": "extraction failed: LLM HTTP 500: upstream error (episode stored for retry)",
  "entities": [], "facts": [], "reinforced": [], "invalidated": [],
  "dropped": { "entities": 0, "facts": 0, "invalidations": 0 }
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

Hybrid search (keyword BM25 + embeddings, rank fusion) over facts. Facts on an entity the query
names, or one hop from it, get a small boost. A fact that shares no keyword with the query, is not
near an entity it names and whose embedding is not similar enough (`MINIZEP_SEARCH_MIN_COSINE`,
default 0.4) is left out, so `facts` can be empty.

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

### GET /v1/entities/:id

One entity by uuid (or a prefix of at least 8 characters, no names), with every fact touching it
that was known at `as_of`. Query: `group_id`, `at`, `as_of`.

```json
{ "group_id": "teamA", "at": "2026-09-25T08:00:00.000Z", "as_of": "2026-09-25T08:00:00.000Z",
  "entity": { "uuid": "066914c3-…", "name": "Alice", "labels": ["Person"], "label": "Person",
              "summary": "…", "created_at": "…", "attributes": {} },
  "facts": [ { "relation": "WORKS_AT", "state": "ended", "ends_at": "2024-06-01T00:00:00.000Z",
               "revised_later": false, "reason": "text states \"left\"", "…": "fact row" } ],
  "episodes": [ { "uuid": "6eeafffa-…", "name": "…", "source": "text", "valid_at": "…",
                  "created_at": "…", "status": "processed" } ],
  "episodes_truncated": false }
```

- `label`: the first label that is not `Entity`, else `Entity`.
- `facts`: fact rows (without `score`) plus [state fields](#rows), ordered `active`, `future`,
  `ended`, `retracted`, then newest `valid_at` first (unknown starts last).
- `episodes`: the evidence of those facts known at `as_of`, newest `valid_at` first, at most 50
  (`episodes_truncated` says whether there were more).
- 404 when no entity of the group has that id.

### GET /v1/graph

The nodes and edges of one group at one (`at`, `as_of`) instant, for drawing the graph.

| Query      | Notes |
|------------|-------|
| `group_id` | |
| `at`       | valid time, default now |
| `as_of`    | knowledge time, default now |
| `history`  | `true`: every fact known at `as_of`, each with its state; default: `active` facts only |
| `isolated` | `true`: also entities known at `as_of` that no returned fact touches, most recently learned first, only while the node count stays within `limit` |
| `limit`    | maximum edges, 1-2000, default 500; beyond it `active` facts are kept first, then the most recently learned |

```json
{ "group_id": "teamA", "at": "2024-04-01T00:00:00.000Z", "as_of": "2026-09-25T08:00:00.000Z",
  "history": false,
  "nodes": [ { "uuid": "066914c3-…", "name": "Alice", "labels": ["Person"], "label": "Person",
               "summary": "…", "created_at": "…", "degree": 1 } ],
  "edges": [ { "uuid": "160f2ea7-…", "source_uuid": "066914c3-…", "target_uuid": "8d2b7f40-…",
               "source": "Alice", "target": "Acme", "relation": "WORKS_AT", "fact": "Alice works at Acme",
               "valid_at": "…", "invalid_at": null, "created_at": "…", "expired_at": null,
               "episodes": ["…"], "reason": null,
               "state": "active", "ends_at": null, "revised_later": false } ],
  "labels": [ { "label": "Entity", "count": 1 }, { "label": "Person", "count": 2 } ],
  "timeline": { "valid": ["2024-03-01T09:00:00.000Z", "…"], "known": ["2026-09-25T06:14:54.414Z", "…"] },
  "counts": { "entities": 3, "facts": 2, "nodes": 2, "edges": 1, "hidden_edges": 1 },
  "truncated": false }
```

- `nodes`: the endpoints of the returned edges (plus isolated entities on request); `degree`
  counts the returned edges.
- `labels`: every entity of the group by primary label (`Entity` first, then alphabetical), not
  just this time slice, so colours stay stable while `at`/`as_of` move.
- `timeline.valid`: the distinct `valid_at`/`invalid_at` of all facts of the group;
  `timeline.known`: their distinct `created_at`/`expired_at`. Sorted, at most 1000 each (evenly
  sampled beyond that).
- `counts`: `entities`/`facts` for the whole group, `nodes`/`edges` returned,
  `hidden_edges = facts - edges`.
- `truncated`: `limit` left out edges, or isolated entities (with `isolated=true`).

### GET /v1/groups

The groups the caller may open, most recent episode first, with its role in each (`reader`,
`writer` or `owner`):

```json
{ "default_group": "teamA",
  "groups": [ { "group_id": "teamA", "role": "writer", "entities": 4, "facts": 2, "active_facts": 1,
                "episodes": 3, "failed_episodes": 0, "last_episode_at": "2026-09-25T06:14:54.414Z" } ] }
```

A token lists the groups it holds by name (empty ones included), every group holding data that a
pattern it holds matches (`bob/*`), and its default group when it may read it. A caller allowed
any group (anonymous mode, an admin's unrestricted token, or the UI with `MINIZEP_UI_GROUPS=*`)
lists every group that holds an episode or an entity.

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

Re-process, in place, every `failed` episode of the group (e.g. after an LLM or embedding outage),
oldest first, including the ones the [background retry](#durability-and-shutdown) gave up on. Each
counts as an attempt. Body (optional): `{"group_id": "..."}`. Runs synchronously.

```json
{ "group_id": "teamA", "retried": 1, "succeeded": 1, "still_failing": 0 }
```

### POST /v1/episodes/:id/forget

Take back what one episode contributed, when the whole note was wrong or not wanted. `:id` is the
episode uuid or a prefix of at least 8 characters.

| Field      | Type   | Notes |
|------------|--------|-------|
| `reason`   | string | required, kept on the episode and on every fact it changes |
| `group_id` | string | |

Nothing is deleted, and `as_of` before the call still shows what was believed:

- a fact the episode was the **only evidence** for is **retracted** (as with
  [invalidate](#post-v1factsuuidinvalidate) `retract: true`), also one that another episode found
  out of date when written (see below): forgetting that episode later does not bring it back;
- a fact with other evidence only drops the episode from its `episodes`;
- a fact the episode **closed** is **reopened** (as with [reopen](#post-v1factsuuidreopen)), with
  the end it had before, if any. Ingestion records which episode closed a fact
  (`attributes.closedByEpisode`); closures written by an older build carry no such marker and are
  only reported in `unmarked_closures` (facts closed when this episode's facts were written), for
  the caller to check and reopen;
- for a relation that holds one value at a time (`WORKS_AT`, `HAS_ROLE`, `HAS_TITLE`, `LIVES_IN`,
  `REPORTS_TO`, or a fact flagged `replacesPrevious`), a later value of the same source and
  relation that still holds (starting after the fact, not retracted by this call) ends the
  reopened copy where it begins. When that value begins at or before the end the episode gave the
  fact (another episode states the same change), the fact **stays closed** and is listed in
  `still_closed`; reopen it by hand if that is wrong;
- a fact the episode found **out of date when written** (`attributes.outdatedWhenWritten`, see
  [add](#post-v1memories)) is reopened the same way, and stays closed while such a value that
  still holds covers the date it was written;
- an entity **summary** the episode wrote last is **put back** to the one it replaced (listed in
  `restored_summaries`; an entity the episode created gets an empty summary). Ingestion records
  on an entity which episode created it (`attributes.createdByEpisode`) and which one last stated
  its summary, with the summary it replaced (`summaryByEpisode`, `previousSummary`); an episode
  that restates the summary word for word takes it over. Entities the episode created that are
  left with no fact and no summary are listed in `orphaned_entities` and kept;
- the episode gets status `forgotten` and keeps its text; the same text sent again is a new
  episode, processed afresh. A `pending` or `failed` episode can be forgotten too: it is then never
  processed.

Labels, a summary another episode rewrote since, entities written before these markers existed,
and a start the episode moved earlier are left as they are. Only the last change to a summary is
kept, so after one episode's summary is put back, an earlier episode's cannot be.

```json
{ "group_id": "teamA",
  "episode": { "uuid": "b89af07b-…", "status": "forgotten", "error": "not about this Alice", "…": "…" },
  "retracted": [ { "uuid": "160f2ea7-…", "invalid_at": "2024-03-01T09:00:00.000Z",
                   "reason": "forgotten episode b89af07b: not about this Alice", "…": "fact row" } ],
  "unlinked": [],
  "reopened": [ { "fact": { "uuid": "5c0de1f2-…", "…": "the reopened copy" },
                  "previous": { "uuid": "0a4e2b17-…", "…": "the closed record, now retracted" } } ],
  "still_closed": [],
  "unmarked_closures": [],
  "restored_summaries": [ { "name": "Alice", "summary": "the summary before this episode", "…": "entity row" } ],
  "orphaned_entities": [] }
```

404 when the group has no such episode, 409 when it is already forgotten.

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
retracted. To undo a wrong end or retraction, [reopen](#post-v1factsuuidreopen) the fact.

### POST /v1/facts/:uuid/reopen

Undo a wrong end or retraction, e.g. an ingestion that closed a fact which is still true. The end
may still be in the future (a change "effective next Monday" that should not have ended the fact).
`:uuid` is the fact uuid or a prefix of at least 8 characters.

| Field        | Type   | Notes |
|--------------|--------|-------|
| `reason`     | string | required, kept on both records |
| `invalid_at` | string | when it really stopped being true, if it did (default: still true); must be after its `valid_at` |
| `group_id`   | string | |

A row keeps one version of what was believed, so the closed row is not edited back. It is
**retracted** (its window is emptied and `expired_at` set to now; a row that was already retracted
keeps its retraction) and a corrected **copy** is inserted: same endpoints, relation, text,
`valid_at` and evidence, `invalid_at` as given, `created_at` now, and a new uuid. The response has
both:

```json
{ "group_id": "teamA",
  "fact":     { "uuid": "5c0de1f2-…", "valid_at": "2024-03-01T09:00:00.000Z", "invalid_at": null,
                "created_at": "2026-09-25T08:02:11.130Z", "expired_at": null, "reason": null, "…": "…" },
  "previous": { "uuid": "160f2ea7-…", "valid_at": "2024-03-01T09:00:00.000Z",
                "invalid_at": "2024-03-01T09:00:00.000Z", "expired_at": "2026-09-25T08:02:11.130Z",
                "reason": "reopened as 5c0de1f2: the later note confirms it, ends nothing", "…": "…" } }
```

An `as_of` before the reopen finds the old row and not the copy; from the reopen on, only the
copy, and the old row is `retracted` at every `at`. As with any retraction of an ended fact, an
`as_of` between the wrong end and the reopen sees the old row without that end. 409 when the fact
has no end and is not retracted (`nothing to reopen`), was already reopened, or `invalid_at` is not
after its start.

### GET /v1/stats

`?group_id=`

```json
{ "group_id": "teamA",
  "episodes": { "total": 3, "pending": 0, "processed": 2, "failed": 1, "given_up": 1, "forgotten": 0 },
  "entities": 4,
  "facts": { "total": 2, "active": 1, "historical": 1 },
  "jobs": { "queued": 0, "running": 0 } }
```

Counts are for that group only (`jobs` too). `given_up` counts the `failed` episodes tried
`MINIZEP_RETRY_MAX` times or more, which only [retry-failed](#post-v1episodesretry-failed) takes.

### GET /v1/status

Server details for an authenticated caller (what `/health` used to expose):

```json
{ "ok": true,
  "store": "postgres (postgres://user:***@db.example:5432/minizep, dims=1024)",
  "llm": "<model> @ <llm base url>",
  "default_group": "teamA",
  "groups": ["teamA"],
  "jobs": { "queued": 0, "running": 0 },
  "episodes": { "failed": 1, "given_up": 0 },
  "sessions": 0,
  "timezone": "Asia/Shanghai" }
```

`groups` lists the names and patterns the caller may read; it is `null` for a caller allowed any
group (anonymous mode, an admin's unrestricted token). `jobs`, `episodes` (over the token's groups) and
`sessions` count only what this token can see; `episodes.given_up` as in [stats](#get-v1stats).
The store counts the episodes (no episode is loaded, the web UI polls this every 10 s);
`episodes` is `null` when the store cannot answer, and the rest of the status is still returned.
`timezone` is the zone relative dates in ingested text are resolved in (`MINIZEP_TIMEZONE`, else
the server's zone).

### GET /v1/guide

The usage guide for agents, as Markdown (`text/markdown`): what to store, how to write and
search, which tool repairs what, with examples. It is `docs/MEMORY-GUIDE.md`, read on each request,
and the same text as the `memory_guide` tool.

### GET /health

Unauthenticated liveness probe for load balancers and container health checks. Always
`{"ok":true}`, nothing else.

### Users, tokens and members

`GET /v1/me` (who the caller is and what it may do), `/v1/me/tokens` (a user's own tokens),
`/v1/groups/:g/members` (the members of a group the caller owns) and `/v1/admin/*` (users,
tokens and grants, for admins) are described in [ACCESS.md](ACCESS.md#rest).

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

### How the server explains itself

A model that connects needs no client-side instructions:

- The `initialize` result carries `instructions` (about 1,100 characters; the first paragraph,
  under 512, stands alone): search before answering about people, projects, plans and decisions;
  add durable facts, one event per call, subjects named, `valid_at` = when it happened; repair the
  memory when the user contradicts it; which tool repairs what.
- The instructions end with the groups the connection may use and its role in each (its token's
  groups, or "any group" for stdio and anonymous mode), name the read-only ones, and tell the model to
  pass `group_id` for a project's own group and to call `list_groups` before concluding the default
  group has nothing.
- A connection that may write nowhere (every group read-only) is not offered the write tools
  (`add_memory`, `invalidate_fact`, `reopen_fact`, `forget_episode`, `retry_failed`). A session
  follows grant and token changes at its next request: a revoked token gets 403, a group that became
  read-only a tool error.
- The `memory_guide` tool returns the full method, [docs/MEMORY-GUIDE.md](MEMORY-GUIDE.md), also
  served as [GET /v1/guide](#get-v1guide). Keep the instructions (`src/server/tools.ts`) consistent
  with it.
- Every tool description says when to use the tool and ends with "See memory_guide."
- Tool annotations let a client run reads without asking and ask before corrections:
  `readOnlyHint` on the read tools; `add_memory` is not destructive and idempotent; `retry_failed`
  is not destructive; `invalidate_fact`, `reopen_fact` and `forget_episode` are destructive
  (history is kept, but what the memory holds true changes). `openWorldHint` is false everywhere.

### Tools

Every tool that takes `group_id` follows the [group rules](#groups). Tool results carry a text
rendering and the same JSON as the REST API in `structuredContent`.

| Tool                | Arguments | REST equivalent | Kind |
|---------------------|-----------|-----------------|------|
| `add_memory`        | `content`, `group_id?`, `valid_at?`, `source?`, `name?`, `idempotency_key?`, `async?` | `POST /v1/memories` | write |
| `memory_job_status` | `job_id?` (omit to list recent jobs), `limit?` | `GET /v1/memories/jobs/:id` | read |
| `search_facts`      | `query`, `group_id?`, `limit?`, `at?`, `as_of?`, `include_historical?` | `POST /v1/search` | read |
| `facts_about`       | `entity`, `group_id?`, `at?`, `as_of?`, `include_historical?`, `limit?` | `GET /v1/entities/:name/facts` | read |
| `facts_at`          | `timestamp?` (valid time, default now), `as_of?`, `group_id?`, `limit?` (default 100) | `GET /v1/facts` | read |
| `list_entities`     | `query?`, `group_id?`, `limit?` | `GET /v1/entities` | read |
| `list_episodes`     | `group_id?`, `limit?` | `GET /v1/episodes` (text preview only) | read |
| `get_episode`       | `id` (uuid or 8+ char prefix), `group_id?` | `GET /v1/episodes/:id` | read |
| `invalidate_fact`   | `uuid`, `reason`, `at?`, `retract?`, `group_id?` | `POST /v1/facts/:uuid/invalidate` | destructive |
| `reopen_fact`       | `uuid`, `reason`, `invalid_at?`, `group_id?` | `POST /v1/facts/:uuid/reopen` | destructive |
| `forget_episode`    | `id` (uuid or 8+ char prefix), `reason`, `group_id?` | `POST /v1/episodes/:id/forget` | destructive |
| `retry_failed`      | `group_id?` | `POST /v1/episodes/retry-failed` | write |
| `graph_stats`       | `group_id?` | `GET /v1/stats` | read |
| `list_groups`       | none | `GET /v1/groups` | read |
| `memory_guide`      | none | `GET /v1/guide` | read |

`add_memory` reports `processed`, `duplicate`, `queued` or `failed`; a failed extraction is a tool
error (`isError: true`) whose text says the episode is stored for retry. Fact lines look like

```
[160f2ea7] Alice --WORKS_AT--> Acme | "Alice works at Acme" | since 2024-03-01 | ep 6eeafffa
```

with the validity rendered as `since <start>`, `true <start> → <end>`, `since <start>, until
<future end>`, `from <future start>`, `still true` (start unknown) or `retracted`. The bracketed
prefix is what `invalidate_fact` and `reopen_fact` take. `ep` lists the first three `episodes`
(8-character prefixes, oldest first, `+N` for the rest): what `get_episode` and `forget_episode`
take, and the only way to them for a client that shows the model the text alone.

`minizep-proxy` forwards the instructions, the tool list and its annotations as they are.

### stdio clients

`minizep-proxy` (`src/server/stdio-proxy.ts`) bridges a stdio-only MCP client to this endpoint and
forwards the tool list verbatim, so new tools need no proxy change:

```bash
MINIZEP_HTTP_URL=http://127.0.0.1:8787/mcp MINIZEP_TOKEN=$TOKEN minizep-proxy
```

---

## Web UI

A single page for browsing and editing the graph: groups, the graph at any (`at`, `as_of`)
instant, facts, entities, episodes, adding memories and ending or retracting facts. It is off
unless `MINIZEP_UI=1` (with a login) or the deprecated `MINIZEP_UI_GROUPS` (without) is set; both
at once stop the server at start.

```bash
MINIZEP_UI=1
# open http://127.0.0.1:8787/ui  (or http://<VPN address>:8787/ui)
```

- **Login** (`MINIZEP_UI=1`). The page (`GET /ui`) is served without one and shows a login form
  while `GET /ui/api/me` answers 401. `POST /ui/api/login` with `{"token": "..."}` (a user's token
  or an env token) sets an `HttpOnly`, `SameSite=Strict` session cookie for `/ui`, valid for
  `MINIZEP_UI_SESSION_DAYS` (default 30); `POST /ui/api/logout` ends it. The API
  (`/ui/api/v1/...`, the REST routes above) then acts as that token, resolved again on each
  request, so a revocation or a grant change applies at once; without a valid session it answers
  401 `login required`. After 10 failed logins within 5 minutes an address gets 429. Details and
  the exact answers: [ACCESS.md](ACCESS.md#web-ui-login).
- **No login** (`MINIZEP_UI_GROUPS='teamA|shared'`, or `*` for every group; deprecated, the server
  logs a warning). The API acts as one fixed caller, writer on those groups (the first is its
  default; `*` = any group, default `default`); `/ui/api/me` answers that caller and there is no
  login. Anyone who can reach the listen address can read and write those groups, so enable it
  only on a private network (loopback or a VPN), and list only the groups meant to be browsed.
- Token auth on `/v1` and `/mcp` is unchanged either way.
- `GET /` and `GET /ui/` redirect to `/ui` (the page calls the relative `ui/api/v1`, so it also
  works behind a path prefix, where the cookie path needs rewriting). The page is `ui/index.html`,
  read on each request and served with a restrictive `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff` and `Cache-Control: no-cache`.
- Every `/`, `/ui` and `/ui/api` request, login included, is refused with **403** unless:
  - the `Host` header (without port) is an IP address, `localhost`, or a name listed in
    `MINIZEP_UI_HOSTS` (a DNS-rebinding page arrives under the attacker's own domain name); and
  - when the browser sends an `Origin`, it is exactly `http://<Host header>` and
    `Sec-Fetch-Site` is absent or `same-origin` (a page on another site can neither write nor
    read). Request bodies must be `application/json`, as everywhere.
- Anonymous mode (`MINIZEP_ALLOW_ANONYMOUS=1`) keeps its rules for `/v1` and `/mcp` (loopback
  `Host`, no browser `Origin`); the UI without login works there too, through `/ui/api`.
- Working on the page: `npm run ui:dev` serves it on http://127.0.0.1:8788/ui from an in-memory
  graph seeded with every fact state (active, ended, future, retracted), a failed episode and a
  Chinese group, using a scripted LLM and the hash embedder, so nothing leaves the machine. Edits
  to `ui/index.html` show on reload. `MINIZEP_UI=1 npm run ui:dev` serves it with the login and
  prints the tokens of two users, an admin and a user with an owner and a reader group. See
  `demo/ui-dev.ts` for its settings.

---

## Durability and shutdown

- `async` ingestion stores the episode as `pending` **before** answering (the JSON snapshot is
  written too when the server runs without a database). A job then processes it.
- At startup the server re-enqueues every `pending` episode left by a previous process. Episodes
  written before statuses existed are treated as processed and are not touched.
- A `failed` episode is retried in the background: every `MINIZEP_RETRY_INTERVAL_MS` (default
  10 min) the server re-processes the oldest failed episodes tried fewer than `MINIZEP_RETRY_MAX`
  times (default 3), up to 5 per pass, each under its group's lock like any ingestion. After that
  it is left alone (`given_up` in [stats](#get-v1stats)) until
  [retry-failed](#post-v1episodesretry-failed) or a resend of the same text. The stdio server does
  the same.
- On SIGTERM/SIGINT the server stops accepting requests, waits up to `MINIZEP_DRAIN_TIMEOUT_MS`
  (default 120 s) for queued and in-flight ingestion, writes the snapshot and exits. Work not done
  by then stays `pending` and is picked up at the next start. A second signal exits at once.
- The stdio server (`minizep-mcp`) does the same when its client disconnects (stdin closes).

## Server configuration

| Variable                   | Default      | Meaning |
|----------------------------|--------------|---------|
| `MINIZEP_HOST`             | `127.0.0.1`  | comma-separated listen addresses, e.g. `127.0.0.1,100.64.0.10`. An address that does not exist yet (a VPN interface that comes up later) is retried with backoff (1 s doubling to 30 s) instead of failing; other bind errors are fatal |
| `MINIZEP_PORT`             | `8787`       | |
| `MINIZEP_TOKENS`           |              | `token:group[\|group...],...`: writer on exactly those groups; users' tokens are in the database ([ACCESS.md](ACCESS.md)) |
| `MINIZEP_ALLOW_ANONYMOUS`  |              | `1` = no authentication, any group, while there is no env token and no user (development only) |
| `MINIZEP_SESSION_TTL_MS`   | `1800000`    | idle MCP session lifetime |
| `MINIZEP_MAX_SESSIONS`     | `256`        | MCP session cap |
| `MINIZEP_DRAIN_TIMEOUT_MS` | `120000`     | shutdown wait for queued ingestion (HTTP and stdio) |
| `MINIZEP_JOB_CONCURRENCY`  | `2`          | ingestion jobs run at once |
| `MINIZEP_RETRY_INTERVAL_MS` | `600000`    | how often failed episodes are retried in the background; `0` = never (HTTP and stdio) |
| `MINIZEP_RETRY_MAX`        | `3`          | the background retry leaves an episode alone once it has been tried this many times |
| `MINIZEP_UI`               |              | `1` = serve the [web UI](#web-ui) on `/ui`, with a login by token |
| `MINIZEP_UI_SESSION_DAYS`  | `30`         | how long a UI login lasts |
| `MINIZEP_UI_GROUPS`        |              | deprecated: `group[\|group...]` or `*`: serve the web UI on `/ui` without a login for these groups; not together with `MINIZEP_UI` |
| `MINIZEP_UI_HOSTS`         |              | comma-separated host names the UI may be opened under, besides IP addresses and `localhost` (e.g. a MagicDNS name) |

Storage, LLM and embedding settings (`MINIZEP_DATABASE_URL`, `MINIZEP_DB`, `MINIZEP_LLM_*`,
`MINIZEP_EMBED_*`, …) are described in the README.
