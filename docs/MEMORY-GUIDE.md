# Using the minizep memory

minizep is a long-term memory shared across conversations. You give it notes (episodes); it
extracts **facts** between named things, each with the time it was true, and keeps the history.
A fact looks like this in tool results:

```
[7f3e9a10] Dana Wu --MEMBER_OF--> Orion | "Dana Wu joined the Orion project as tech lead" | since 2026-03-02 | ep 3c9d0b21
```

The bracketed prefix is the fact's id. Then comes when it held: `since <start>`,
`true <start> → <end>`, `since <start>, until <end>`, `from <future start>`, `still true` (start
unknown) or `retracted` (never true). The line ends with `ep` and the ids of the notes (episodes)
it came from, oldest first, `+N` when there are more: the ids `get_episode` and `forget_episode`
take.

## The rule: a memory, not ground truth

A fact is what someone wrote down, and when. It can be out of date, incomplete or wrong.

- What the user says now outranks what the memory says. When they disagree, repair the memory in
  the same turn (see [Self-check](#self-check)).
- Say when an answer rests on the memory alone ("a note from 2026-03-02 says …").
- Before acting on a remembered value (a host, a port, a version, someone's role), check it where
  you can.
- No result does not mean "false": the memory may simply not know.

## The loop

1. **Before answering** about a person, project, system, plan or decision: `search_facts`, or
   `facts_about` for one named entity.
2. **When you learn something durable**: `add_memory`, one event per call.
3. **When the user contradicts the memory**: repair it (table below), then answer.

## What to store

Store what will still matter next week: who does what, where things run, what was decided and
why, plans with their dates, preferences, and every **change** to these.

Do not store:

- secrets: passwords, tokens, keys, private data nobody asked you to keep;
- small talk, and what is only true for this conversation;
- your own guesses: store what was said or observed, when it was;
- raw logs or whole documents: write the durable part as sentences;
- what the memory already holds unchanged.

## How to write an episode

- **One event per call.** Two unrelated things are two `add_memory` calls.
- **Full sentences, every subject named**: "Dana Wu", not "she"; "the Orion project", not "the
  project". Facts connect named things: a sentence without names adds nothing.
- **`valid_at` is when it happened** in the world (ISO-8601), not when you write it down. Relative
  dates in the text ("yesterday", "next Friday") are read against it; writing the absolute date
  into the sentence is safer still. Leave it out only for something happening now. A note with no
  date of its own (no `valid_at`, or the current time, and none in the text) only says it held
  when you wrote it: a change stored later that dates the end of that value earlier ("moved out
  in July") replaces it entirely, while a different value that only conflicts with it does not.
- **State a change as a change**: "moved from X to Y", "no longer", "left", "was cancelled", "now
  listens on". The fact it replaces closes by itself; do not invalidate it first.
- **Keep the details** in the sentence: versions, ports, amounts, dates, reasons.
- **`async: true`**: extraction takes seconds, the call answers at once with a job id. A failed
  extraction is kept and retried; `graph_stats` shows how many failed.
- Optional: `idempotency_key` makes a resend a no-op, `name` labels the note, `group_id` picks a
  namespace (default: yours).

Good (synthetic examples):

```json
{"content": "Dana Wu became tech lead of the Orion project on 2026-03-02, taking over from Sam Lee, who moved to the Atlas project.",
 "valid_at": "2026-03-02T09:00:00Z", "async": true}
{"content": "The Billing service moved from host web-1 to host web-2 on 2026-04-10 and now listens on port 8443.",
 "valid_at": "2026-04-10T00:00:00Z", "async": true}
{"content": "On 2026-05-06 Priya Nair decided to postpone the Orion launch from June to September 2026 because the security review is not finished.",
 "valid_at": "2026-05-06T00:00:00Z", "async": true}
```

Not like this:

- "he said they'll move it next week": who, what, which week?
- "Standup: Dana lead, billing moved, launch later": three events in one call, no sentences, no
  dates.
- "Sam Lee might leave soon": a guess. Store it when it happens.

## How to search

- **Name the entities** in the query: "Dana Wu Orion role" finds more than "who leads it".
- `search_facts` returns the facts true now. `at=<instant>`: what was true then.
  `as_of=<instant>`: what the memory believed then, before later corrections.
  `include_historical=true`: ended facts too.
- `facts_about` lists everything on one entity (a partial name works); `facts_at` everything true
  at one instant.
- An event with only one named thing ("the Atlas project was cancelled") is kept in that entity's
  summary, not as a fact: `list_entities` with its name shows it.
- `get_episode` with the `ep` id of a fact shows the note behind it; `list_episodes` lists the
  newest notes.

## Groups

Memory is split into groups (namespaces), usually one per person, assistant or project. Without `group_id`
every tool uses your default group; the connection instructions list the groups you may use.

- Working on a project or topic that has its own group: pass that `group_id` on every call, reads and writes.
- The default group has nothing about what you are working on: call `list_groups` and search the group that
  matches before concluding the memory is empty.
- A result that ends with "(no group_id: …)" came from the default group; the note lists your other groups.
  If you just stored something that belongs to one of them, `forget_episode` it and add it there.
- Never copy facts from one group into another to "share" them; ask the user which group a new topic belongs to.

## Repairs: situation → tool

| Situation | Tool |
|---|---|
| New information, or something changed | `add_memory`: the old fact closes itself |
| Something has ended | `invalidate_fact` with `at` = when it ended |
| A stored fact was never true | `invalidate_fact` with `retract: true` |
| A fact was closed by mistake | `reopen_fact` |
| A whole note was wrong or not wanted | `forget_episode` with the `ep` id (read it with `get_episode` first) |
| Writes failed | `memory_job_status` / `graph_stats` (failed count), then `retry_failed` once the cause is fixed |

- News (a new value, a new event): `add_memory`. Something simply ended and you have the fact's
  id: `invalidate_fact`. The memory itself is wrong: retract, reopen or forget.
- Every repair takes a `reason`, which is kept. Nothing is deleted: `as_of` before a repair still
  shows what was believed.
- `forget_episode` retracts the facts only that note supported, removes it from the evidence of
  the others, reopens the facts it closed and puts back the entity summaries it wrote last. For
  something that has one value at a time (employer, role, home, manager), a reopened fact ends
  where a later value that other notes support begins, and stays closed when another note states
  the same change. A summary another note rewrote since, and labels, stay as they are: check the
  entities it names with `list_entities`. Its text is kept as `forgotten`; the same text sent again
  later is processed afresh.
- The server retries failed episodes in the background a few times; `graph_stats` counts the ones
  it gave up on, which only `retry_failed` takes.

## Self-check

When a result contradicts the user, or looks wrong:

1. Find the fact and its id (`search_facts`, `facts_about`) and, if needed, the note behind it
   (`get_episode` with the `ep` id at the end of the fact's line).
2. Decide: did the world change (`add_memory` with the change and its date, or `invalidate_fact`
   with `at` when something simply ended), or was the memory wrong (retract, reopen, forget)?
3. Repair it in the same turn, then answer.

Examples, with the memory holding `[7f3e9a10] Dana Wu --MEMBER_OF--> Orion | … | since 2026-03-02 | ep 3c9d0b21`:

- "Dana left Orion at the end of April." Something ended:
  `invalidate_fact {"uuid": "7f3e9a10", "at": "2026-05-01T00:00:00Z", "reason": "user: Dana left Orion end of April"}`.
- "That was never Dana, it was Dan Wu." The memory was wrong:
  `invalidate_fact {"uuid": "7f3e9a10", "retract": true, "reason": "user: it was Dan Wu"}`, then
  `add_memory` "Dan Wu became tech lead of the Orion project on 2026-03-02." with that `valid_at`.
- "That note was a draft plan, none of it happened." The whole note was wrong: read it with
  `get_episode {"id": "3c9d0b21"}`, then
  `forget_episode {"id": "3c9d0b21", "reason": "user: a draft plan, none of it happened"}`.

After a batch of async writes, glance at `graph_stats`: failed episodes mean the memory is missing
what they said.
