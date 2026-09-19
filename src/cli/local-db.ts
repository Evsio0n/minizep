import { readFile } from 'node:fs/promises';

/**
 * Local development convenience: read the connection URL that
 * infra/postgres/setup.sh wrote, so tools work without exporting env vars.
 * Explicit MINIZEP_DATABASE_URL always wins (handled by callers).
 */
export async function loadLocalDatabaseUrl(
  path = process.env.MINIZEP_PGURL_FILE ?? '/var/tmp/minizep-pg/url',
): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}
