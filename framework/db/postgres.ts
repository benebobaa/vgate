import pg from 'pg';

/**
 * Read access to the service's database, for asserting what a call wrote (or did not write). Tests state their
 * SQL explicitly so a reviewer sees exactly which rows are expected; this class only removes the boilerplate.
 */
export class Db {
  private readonly pool: pg.Pool;

  /** `readOnly`: every transaction is read-only (a shared environment's database: the fixture of a smoke run). */
  constructor(cfg: { url: string; schema?: string }, { readOnly = false }: { readOnly?: boolean } = {}) {
    const settings = [
      ...(cfg.schema ? [`-c search_path=${cfg.schema}`] : []),
      ...(readOnly ? ['-c default_transaction_read_only=on'] : []),
    ];
    this.pool = new pg.Pool({
      connectionString: cfg.url,
      max: 4,
      options: settings.length > 0 ? settings.join(' ') : undefined,
    });
  }

  async query<T extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  /** Exactly one row, else the assertion fails with the row count. */
  async one<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(sql, params);
    if (rows.length !== 1)
      throw new Error(`Expected exactly 1 row, got ${rows.length}: ${sql} ${JSON.stringify(params)}`);
    return rows[0];
  }

  async maybeOne<T extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    if (rows.length > 1)
      throw new Error(`Expected at most 1 row, got ${rows.length}: ${sql} ${JSON.stringify(params)}`);
    return rows[0];
  }

  /** `select count(*) ...` as a number. */
  async count(sql: string, params: unknown[] = []): Promise<number> {
    const row = await this.one<{ count: string | number }>(sql, params);
    return Number(row.count);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
