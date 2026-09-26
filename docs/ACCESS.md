# Users, roles and group access

One minizep server can serve many people. Each user works in their own groups (a *workspace*),
plus the groups others shared with them, with a role that decides whether they may read, write
or manage who else has access. `MINIZEP_TOKENS` keeps working unchanged next to this.

Users, grants and tokens are stored in the server's Postgres database (tables `mz_users`,
`mz_grants`, `mz_tokens`, `mz_ui_sessions`, in the same schema as the graph, created on first
use). A server without a database keeps them in memory only: they are gone when it exits.

## Concepts

- **User**: a name (`a-z`, `0-9`, `.`, `_`, `-`, starting with a letter or digit, at most 64
  characters), an `admin` flag, a `disabled` flag and a default group. Users are never deleted:
  disable them.
- **Grant**: `(user, pattern, role)`, at most one per (user, pattern). A pattern is an exact group
  name, or a prefix ending in `*`: `bob/*` matches `bob/notes` and `bob/x/y` (not `bob`), `*`
  matches every group. A user's role in a group is the **highest** role among their grants that
  match it.
- **Admin**: owner of every group, and manages users, tokens and grants of everyone.
- **Token** (API key): belongs to one user. The secret is `mz_` + 43 characters, shown once when
  the token is made; the server keeps only its sha256, and its first 8 characters (`prefix`) to
  recognise it. A token may be narrowed:
  - `groups`: patterns; the token reaches only groups matching one of them;
  - `role`: `reader` or `writer`, a cap on its user's role;
  - `default_group`: used instead of its user's;
  - `expires_at`.

  The token's role in a group is the lower of its user's role there and its cap, and none outside
  its `groups`. Only a token with neither `groups` nor `role` of an admin user is an admin.

  A new token must reach at least one group: its user's grants (every group for an admin) within
  its `groups`. One that reaches none is refused with 400
  `this token would reach none of the groups of "<user>" (their grants: <patterns>)` (from
  `/v1/me/tokens`, only the grants the calling token has, as `/v1/me` shows them), and so is a
  `default_group` it cannot read (400 `default group "<g>" is outside this token's reach`). A
  token with `groups` but no `default_group`, which cannot read its user's default group, gets
  the first exact group name (no `*`) of its `groups` that it can read as its `default_group`, or
  none when there is no such name. This is checked when the token is made, not after later grant
  changes. The first token of a new user is not narrowed.
- **Default group** (used when a request names none): the token's, else its user's. When the
  caller cannot read it, a request without `group_id` fails with 403
  `no default group: pass group_id`.
- **Env tokens** (`MINIZEP_TOKENS`): writer on exactly the groups they list, the first being the
  default; never admin, no user. They are checked before the database.

A disabled user, a revoked or an expired token all get 403 `invalid token`, like a wrong token.

## Roles

| May…                                                                 | reader | writer | owner | admin |
|----------------------------------------------------------------------|:------:|:------:|:-----:|:-----:|
| read: `search_facts`, `facts_about`, `facts_at`, `list_entities`, `list_episodes`, `get_episode`, `graph_stats`, `memory_job_status`, `list_groups`, `memory_guide`; REST `GET`s and `POST /v1/search` | ✓ | ✓ | ✓ | ✓ |
| write: `add_memory`, `invalidate_fact`, `reopen_fact`, `forget_episode`, `retry_failed` |  | ✓ | ✓ | ✓ |
| manage the members of the group (`/v1/groups/:g/members`)            |        |        | ✓     | ✓     |
| manage users, tokens and any grant (`/v1/admin/*`, `minizep-admin`)  |        |        |       | ✓     |

A write into a group the caller may only read is refused with 403
`read-only access to group "<g>"`; a group it cannot read at all with 403
`group not permitted for this token`. Over MCP these are tool errors. A caller that may write
nowhere is not offered the write tools at all. The MCP instructions and `list_groups` name the
caller's role in each group, so a model knows where it may only search.

## Workspaces

`minizep-admin user add bob` creates user `bob` with default group `bob` and grants him `owner`
on `bob` and on `bob/*`: his own group and any sub-group he opens (`bob/notes`, `bob/asr`). A
group comes into existence with its first memory.

`user add` makes the workspace from the default group given then: `--default-group pff` makes it
`pff` and `pff/*` (grants of `owner` on both, whatever the user's name). A workspace never takes
over a group in use: when another user's grant already reaches the group or one under it (a team
group, someone's workspace), `user add` is refused with 409
`group "<g>" or a sub-group already has members (<users>): create the user without a workspace and grant a role`,
since its owner could read their memories and remove their grants. The default group of a
workspace has at most 254 characters (400 otherwise), so that `<g>/*` stays a pattern.
`--no-workspace` skips both grants: the user can then read its default group only once it is
granted. `user set --default-group` later moves no grant: grant the new group separately, or
its calls without `group_id` fail with 403 `no default group: pass group_id`.

Bob shares `bob/notes` with Alice as a reader:

```bash
curl -X POST -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' \
  -d '{"user":"alice","role":"reader"}' http://127.0.0.1:8787/v1/groups/bob%2Fnotes/members
```

Group names in a path are URL-encoded (`/` is `%2F`).

## CLI: minizep-admin

It reads the server's settings (`MINIZEP_DATABASE_URL`, else the URL file of
`infra/postgres/setup.sh`; `MINIZEP_DB_SCHEMA`) and refuses to run without Postgres. On the
server:

```bash
cd /srv/minizep && sudo node --env-file=/etc/minizep/minizep.env dist/cli/admin.js user list
npm run admin -- user list            # from a checkout, with MINIZEP_DATABASE_URL set
```

```
user add <name> [--admin] [--default-group g] [--no-workspace]   # owner of g (else <name>) and g/*; prints a first token (all rights)
user list
user set <name> [--admin | --no-admin] [--default-group g] [--disable | --enable]
grant <user> <pattern> <reader|writer|owner>
revoke <user> <pattern>
grants [--user u] [--group g]
token create <user> [--name label] [--groups p1,p2] [--role reader|writer] [--default-group g] [--expires-days n]
token list [--user u]
token revoke <token-id>
```

`token create` refuses a token that would reach none of the user's groups, or whose
`--default-group` it cannot read. A narrowed one without `--default-group` that cannot read its
user's default group gets the first exact group (no `*`) of `--groups` it can read as its default,
else none, and calls then pass `group_id` (see [Concepts](#concepts), Token): for a user with
default group `pff`, `--groups 'pff/*'` has no default, so add `--default-group pff/notes` or use
`--groups pff,pff/*`. `--json` prints the JSON of the matching REST endpoint. A running
server sees changes made with the CLI within 30 seconds (it caches each token's rights that
long); changes made through its own REST endpoints apply at once.

## REST

All under the usual bearer authentication (see [API.md](API.md#authentication)); bodies are JSON
objects. Rows:

- **user**: `{name, admin, disabled, default_group, created_at}`
- **grant**: `{user, pattern, role, created_at}`
- **token** (never the secret): `{id, user, name, prefix, groups, role, default_group, created_at,
  expires_at, last_used_at, revoked_at}`; `groups`, `role`, `default_group` and the dates are
  `null` when not set. `last_used_at` is updated at most every 5 minutes.

### Every caller

| Route | Body | Answer |
|---|---|---|
| `GET /v1/me` | | 200 `{user, admin, default_group, token, grants}` |
| `GET /v1/me/tokens` | | 200 `{tokens: [token]}` |
| `POST /v1/me/tokens` | `{name, groups?, role?, default_group?, expires_days?}` | 201 `{token: "<secret>", record: token}` |
| `POST /v1/me/tokens/:id/revoke` | | 200 `{record: token}` |
| `GET /v1/groups` | | rows gain `role`, see [API.md](API.md#get-v1groups) |

`GET /v1/me`:

```json
{ "user": { "name": "bob", "admin": false, "disabled": false, "default_group": "bob",
            "created_at": "2026-09-26T04:38:55.973Z" },
  "admin": false,
  "default_group": "bob",
  "token": { "id": "tk_e4a1747ec935", "name": "laptop", "groups": null, "role": null, "expires_at": null },
  "grants": [ { "pattern": "bob", "role": "owner" }, { "pattern": "bob/*", "role": "owner" },
              { "pattern": "hanja-asr", "role": "reader" } ] }
```

`grants` is what the calling token may do: its user's grants narrowed by the token (an admin's
unrestricted token: `[{"pattern":"*","role":"owner"}]`). For an env token `user` is `null` and
`token` is `{id: "tok_<16 hex>", name: null, groups: [its groups], role: "writer",
expires_at: null}`; anonymous mode and the UI without login have `token: null`.

The `/v1/me/tokens` routes need a user account (403 for env tokens). A token made there can never
do more than the token that made it: its `groups` are intersected with the caller's (403 when
nothing is left), its `role` is the lower of both, and it expires no later than the caller's.
It must then reach one of the account's groups and be able to read its `default_group` (400
otherwise; see [Concepts](#concepts), Token).
`name` is required (1–100 characters), `expires_days` is 1–3650. Revoking someone else's token
is 404 `token not found`, like a missing one.

### Group owners (and admins)

For a group `:g` (a name, not a pattern: `*` is 400) on which the caller is owner:

| Route | Body | Answer |
|---|---|---|
| `GET /v1/groups/:g/members` | | 200 `{group_id, members: [grant]}`: every grant whose pattern matches `:g` |
| `POST /v1/groups/:g/members` | `{user, role}` | 200 `{grant}`: the exact grant (user, `:g`) set to `role` |
| `POST /v1/groups/:g/members/remove` | `{user}` | 200 `{removed: true}`; 404 when that exact grant does not exist |

Not an owner of `:g`: 403 `managing members of "<g>" needs the owner role` (or
`group not permitted for this token`). An owner cannot change their own grants (403
`you cannot change your own access`, so nobody locks themselves out); an unknown user is 404.
Grants by pattern are listed here but made and removed only by admins.

### Admins

Everything else is 403 `admin rights required`.

| Route | Body | Answer |
|---|---|---|
| `GET /v1/admin/users` | | 200 `{users: [user + {grants: [{pattern, role, created_at}], tokens: [token]}]}` |
| `POST /v1/admin/users` | `{name, admin?, default_group?, workspace? = true}` | 201 `{user, grants: [grant], token: "<secret>", record: token}`, `grants` owner of the default group (`default_group`, else `name`) and its `/*`, none without a workspace; 409 when the name is taken or another user's grant reaches the workspace (see [Workspaces](#workspaces)); 400 when a workspace's default group is over 254 characters |
| `POST /v1/admin/users/:name` | `{admin?, disabled?, default_group?}` | 200 `{user}`; 404 |
| `POST /v1/admin/users/:name/tokens` | `{name?, groups?, role?, default_group?, expires_days?}` | 201 `{token: "<secret>", record: token}`; 400 when it would reach none of the user's groups or cannot read `default_group`; 404 |
| `POST /v1/admin/tokens/:id/revoke` | | 200 `{record: token}`; 404 |
| `POST /v1/admin/grants` | `{user, pattern, role}` | 200 `{grant}` (inserted or its role changed); 404 unknown user |
| `POST /v1/admin/grants/revoke` | `{user, pattern}` | 200 `{removed: true}`; 404 |

MCP has no admin tools.

## Web UI login

`MINIZEP_UI=1` serves the web UI on `/ui` with a login. The page itself is served without one;
it shows a login form while `/ui/api/me` answers 401.

| Route | Answer |
|---|---|
| `POST /ui/api/login` `{token}` | 200 `{me, expires_at}` (`me` as `GET /v1/me`) and `Set-Cookie: mz_ui=<session id>; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=<seconds>`; 403 `invalid token`; 429 `too many failed logins: try again later` (with `Retry-After`) |
| `POST /ui/api/logout` | 200 `{ok: true}`, the session deleted and the cookie cleared (`Max-Age=0`) |
| `GET /ui/api/me` | 200 as `GET /v1/me`; 401 `login required` |
| `/ui/api/v1/...` | the REST API above, acting as the logged-in token; 401 `login required` without a valid session |

- A session lasts `MINIZEP_UI_SESSION_DAYS` (default 30). The store keeps the sha256 of the
  session id and the token it stands for, and the token is resolved again on each request: a
  revoked token or a changed grant applies to its sessions too. Sessions of env tokens are kept in
  memory: after a restart, log in again.
- After 10 failed logins from one address within 5 minutes, that address gets 429 until the
  oldest failure is 5 minutes old, even with a right token. Behind a reverse proxy every client
  shares the proxy's address.
- The Host, Origin and Content-Type checks of the UI apply to every UI request, login included
  (see [API.md](API.md#web-ui)).
- The cookie's path is `/ui`: behind a proxy that serves minizep under a prefix, rewrite it
  (nginx: `proxy_cookie_path /ui /prefix/ui;`).

What the page does with this:

- **Login.** The token typed into the form is sent once to `/ui/api/login` and kept nowhere by the
  page (no local or session storage, never in a URL); the field is cleared after each attempt.
  Whenever a call answers 401 (logged out in another tab, session expired, token revoked, user
  disabled), the login form comes back over the page; logging in again returns to the same place.
  The top bar shows who is logged in (the user, or `token tok_…` for an env token), an `admin`
  badge, and a menu with Access and Log out.
- **Roles.** The group list and the group switcher show the caller's role in each group. In a
  group where it is `reader`, the page marks it read-only and offers no change: no Add memory,
  End / Retract fact or Retry failed.
- **Members** (`#/g/<group>/members`, in the sidebar for owners and admins): the grants that reach
  the group. Exact grants can be added by user name, given another role or removed; grants by
  pattern are listed as `via bob/*` and changed only by admins. An owner's own row is not editable.
- **Access** (`#/access`): the account, the grants of this login and the account's tokens (name,
  prefix, groups, role, created, last used, expiry, state). A new token takes a name, optional
  groups (comma-separated patterns), a role cap, a default group and an expiry in days; its secret
  is shown once with a copy button. An env token has no account: the page says so. Admins also see
  every user (admin, disabled, default group, grants, active tokens) and can create one (with or
  without a workspace; its first token is shown once), enable or disable it, make or remove an
  admin, set its default group, add, change or revoke grants, and create or revoke its tokens.
  Revoking, disabling and admin changes ask for confirmation.

`MINIZEP_UI_GROUPS`, the UI without login acting as writer on fixed groups, still works but is
deprecated (the server logs a warning). There `/ui/api/me` answers that fixed caller and
`/ui/api/login`/`logout` are 404; the page then shows no login, logout or Access entry. Setting
both variables stops the server at start.

## Starting the server

The server refuses to start with neither an env token nor a user in the database, unless
`MINIZEP_ALLOW_ANONYMOUS=1`. Anonymous mode (local, non-browser clients only) acts as an admin, so
the first user can also be added over `POST /v1/admin/users`; from then on every request needs a
token (within 30 seconds on other servers of the same database).

## Moving from MINIZEP_TOKENS

Both work side by side, so the move can be gradual:

1. Run the server with Postgres (`MINIZEP_DATABASE_URL`).
2. Add a user per person (`minizep-admin user add alice`) and hand them their token.
3. Recreate what the shared env tokens gave: `tokX:teamA|shared` is writer on `teamA` and
   `shared`, default `teamA`:

   ```bash
   minizep-admin user add teama --no-workspace --default-group teamA
   minizep-admin grant teama teamA writer
   minizep-admin grant teama shared writer
   ```

   or give those groups to the people's own users (`minizep-admin grant alice shared writer`).
4. Switch the clients to the new tokens, then remove the entries from `MINIZEP_TOKENS` and restart.

## Security notes

- Secrets are shown once and stored nowhere, only their sha256. A lost token is revoked and a new
  one made. Tokens are random (32 bytes), so a plain hash is enough to find them.
- Rights are cached for 30 seconds per token: a revocation or a grant change made with the CLI or
  on another server takes up to that long; through this server's REST endpoints it applies at once.
- Least privilege: give agents their own narrowed tokens (`--groups`, `--role reader`,
  `--expires-days`); a token cannot make a token stronger than itself.
- Only an unrestricted token of an admin is an admin: a narrowed admin token cannot lift its own
  limits through `/v1/admin`.
- Admins can do everything, including demoting themselves; `minizep-admin` on the server always
  works to repair that.
- Anonymous mode acts as an admin: keep it to local development.
