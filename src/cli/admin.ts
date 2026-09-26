#!/usr/bin/env node
/**
 * minizep-admin: users, grants and tokens (docs/ACCESS.md).
 *
 *   node --env-file=/etc/minizep/minizep.env dist/cli/admin.js user add bob
 *   npm run admin -- user list
 *
 * Reads the server's database settings (MINIZEP_DATABASE_URL, else the local
 * URL file of infra/postgres/setup.sh; MINIZEP_DB_SCHEMA) and refuses to run
 * without Postgres: users kept in memory would be gone when it exits. It acts
 * as an admin through the same code as /v1/admin; a running server sees the
 * changes within 30 s. --json prints what those endpoints answer.
 */
import { parseArgs } from 'node:util';
import { PostgresStore } from '../store/postgres-store.js';
import { AccessControl, accessShapes, type grantRow, type tokenRow, type userRow } from '../server/access.js';
import type { Principal } from '../server/auth.js';
import { parse } from '../server/rest.js';
import { loadLocalDatabaseUrl } from './local-db.js';

const USAGE = `usage: minizep-admin <command> [--json]

  user add <name> [--admin] [--default-group g] [--no-workspace]   prints a first token (all rights)
  user list
  user set <name> [--admin | --no-admin] [--default-group g] [--disable | --enable]
  grant <user> <pattern> <reader|writer|owner>
  revoke <user> <pattern>
  grants [--user u] [--group g]
  token create <user> [--name label] [--groups p1,p2] [--role reader|writer] [--default-group g] [--expires-days n]
  token list [--user u]
  token revoke <token-id>

A pattern is a group name, or a prefix ending in "*" ("bob/*"; "*" = every group).`;

const ADMIN: Principal = { id: 'cli', defaultGroup: 'default', grants: 'any', admin: true };

class UsageError extends Error {}

let args: ReturnType<typeof parseCommandLine>;
try {
  args = parseCommandLine();
} catch (err) {
  console.error(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
const { values: opt, positionals: pos } = args;
if (opt.help || pos.length === 0) {
  console.log(USAGE);
  process.exit(pos.length === 0 && !opt.help ? 2 : 0);
}

const url = process.env.MINIZEP_DATABASE_URL ?? (await loadLocalDatabaseUrl());
if (!url) {
  console.error('minizep-admin needs Postgres: set MINIZEP_DATABASE_URL (users kept in memory would be gone at exit)');
  process.exit(1);
}
const store = new PostgresStore({ connectionString: url });
const access = new AccessControl({ store: store.accessStore() });

try {
  const { result, text } = await run(pos);
  console.log(opt.json ? JSON.stringify(result, null, 2) : text);
} catch (err) {
  console.error(err instanceof UsageError ? `${err.message}\n\n${USAGE}` : `error: ${(err as Error).message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
} finally {
  await store.close();
}

function parseCommandLine() {
  return parseArgs({
    allowPositionals: true,
    options: {
      admin: { type: 'boolean' },
      'no-admin': { type: 'boolean' },
      'default-group': { type: 'string' },
      'no-workspace': { type: 'boolean' },
      disable: { type: 'boolean' },
      enable: { type: 'boolean' },
      user: { type: 'string' },
      group: { type: 'string' },
      name: { type: 'string' },
      groups: { type: 'string' },
      role: { type: 'string' },
      'expires-days': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/** The positional arguments of a command, exactly `n` of them. */
function operands(rest: string[], n: number): string[] {
  if (rest.length !== n) throw new UsageError(`expected ${n} argument(s), got ${rest.length}`);
  return rest;
}

function either(a: boolean | undefined, b: boolean | undefined, flags: string): boolean | undefined {
  if (a && b) throw new UsageError(`${flags}: pick one`);
  return a ? true : b ? false : undefined;
}

async function run([cmd, sub, ...rest]: string[]): Promise<{ result: unknown; text: string }> {
  const key = ['user', 'token'].includes(cmd) ? `${cmd} ${sub}` : cmd;
  const tail = ['user', 'token'].includes(cmd) ? rest : [sub, ...rest].filter((x) => x !== undefined);
  switch (key) {
    case 'user add': {
      const [name] = operands(tail, 1);
      const input = parse(accessShapes.createUser, {
        name,
        admin: opt.admin ?? false,
        default_group: opt['default-group'],
        workspace: !opt['no-workspace'],
      });
      const r = await access.createUser(ADMIN, input);
      const owns = r.grants.length ? `; owner of ${r.grants.map((g) => g.pattern).join(', ')}` : '';
      return {
        result: r,
        text:
          `user ${r.user.name} added${r.user.admin ? ' (admin)' : ''}, default group ${r.user.default_group}${owns}\n` +
          `token ${r.record.id} (shown once, keep it secret):\n${r.token}`,
      };
    }
    case 'user list': {
      operands(tail, 0);
      const r = await access.listUsers(ADMIN);
      const lines = r.users.map((u) => {
        const flags = [u.admin && 'admin', u.disabled && 'disabled'].filter(Boolean).join(', ');
        const grants = u.grants.map((g) => `${g.pattern}:${g.role}`).join(' ') || '(no grants)';
        const live = u.tokens.filter((t) => !t.revoked_at).length;
        return `${u.name}${flags ? ` [${flags}]` : ''}  default ${u.default_group}  ${grants}  ${live} token(s)`;
      });
      return { result: r, text: lines.join('\n') || 'no users' };
    }
    case 'user set': {
      const [name] = operands(tail, 1);
      const input = parse(accessShapes.updateUser, {
        admin: either(opt.admin, opt['no-admin'], '--admin / --no-admin'),
        disabled: either(opt.disable, opt.enable, '--disable / --enable'),
        default_group: opt['default-group'],
      });
      const r = await access.updateUser(ADMIN, name, input);
      return { result: r, text: describeUser(r.user) };
    }
    case 'grant': {
      const [user, pattern, role] = operands(tail, 3);
      const r = await access.setGrant(ADMIN, parse(accessShapes.grant, { user, pattern, role }));
      return { result: r, text: describeGrant(r.grant) };
    }
    case 'revoke': {
      const [user, pattern] = operands(tail, 2);
      const r = await access.removeGrant(ADMIN, parse(accessShapes.revokeGrant, { user, pattern }));
      return { result: r, text: `removed the grant of ${user} on ${pattern}` };
    }
    case 'grants': {
      operands(tail, 0);
      const r = await access.listGrants(ADMIN, { user: opt.user, group: opt.group });
      return { result: r, text: r.grants.map(describeGrant).join('\n') || 'no grants' };
    }
    case 'token create': {
      const [user] = operands(tail, 1);
      const days = opt['expires-days'];
      const input = parse(accessShapes.token, {
        name: opt.name,
        groups: opt.groups?.split(',').map((g) => g.trim()).filter(Boolean),
        role: opt.role,
        default_group: opt['default-group'],
        expires_days: days === undefined ? undefined : Number(days),
      });
      const r = await access.createToken(ADMIN, user, input);
      return { result: r, text: `${describeToken(r.record)}\nsecret (shown once, keep it secret):\n${r.token}` };
    }
    case 'token list': {
      operands(tail, 0);
      const r = await access.listTokens(ADMIN, { user: opt.user });
      return { result: r, text: r.tokens.map(describeToken).join('\n') || 'no tokens' };
    }
    case 'token revoke': {
      const [id] = operands(tail, 1);
      const r = await access.revokeToken(ADMIN, id);
      return { result: r, text: describeToken(r.record) };
    }
    default:
      throw new UsageError(`unknown command: ${[cmd, sub].filter(Boolean).join(' ')}`);
  }
}

function describeUser(u: ReturnType<typeof userRow>): string {
  return `${u.name}: admin=${u.admin ? 'yes' : 'no'} disabled=${u.disabled ? 'yes' : 'no'} default_group=${u.default_group}`;
}

function describeGrant(g: ReturnType<typeof grantRow>): string {
  return `${g.user}  ${g.pattern}  ${g.role}`;
}

function describeToken(t: ReturnType<typeof tokenRow>): string {
  const limits = [
    t.groups && `groups ${t.groups.join(',')}`,
    t.role && `role ${t.role}`,
    t.default_group && `default ${t.default_group}`,
    t.expires_at && `expires ${t.expires_at.slice(0, 10)}`,
  ].filter(Boolean);
  const state = t.revoked_at ? `revoked ${t.revoked_at.slice(0, 10)}` : t.last_used_at ? `used ${t.last_used_at.slice(0, 16)}` : 'never used';
  return `${t.id}  ${t.user}  ${t.prefix}…  ${t.name || '(no name)'}  ${limits.join(', ') || 'all rights'}  ${state}`;
}
