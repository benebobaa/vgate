/** Read access to a MySQL database, for asserting what a call wrote (or did not write). Parameterised queries only. */
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { isReadOnlySql, type DependencyGuard } from '../http/write-guard.ts';

export type Row = Record<string, unknown>;

export interface MySqlOptions {
  /** Every session READ ONLY, so the server itself refuses a write (a shared environment's database). */
  readOnly?: boolean;
  /** Runs before a statement that is not a plain read (`<dependency>:write`). */
  guard?: DependencyGuard;
}

/**
 * The URL without what lets one query carry several statements (`multipleStatements`, `flags`): in a read-only
 * session a second statement could switch the session back to READ WRITE. Exported for the tests.
 */
export function singleStatements(url: string): string {
  const parsed = new URL(url);
  const keys = [...parsed.searchParams.keys()].filter((key) => /^(multipleStatements|flags)$/i.test(key));
  if (keys.length === 0) return url;
  for (const key of keys) parsed.searchParams.delete(key);
  return parsed.toString();
}

export class MySqlDb {
  private constructor(
    private readonly pool: Pool,
    private readonly guard: DependencyGuard,
  ) {}

  /** `mysql://user:password@host:port/database` */
  static connect(url: string, options: MySqlOptions = {}): MySqlDb {
    // dateStrings: rows compare as the stored text, not as Dates shifted into the runner's time zone.
    const pool = createPool({
      uri: options.readOnly ? singleStatements(url) : url,
      connectionLimit: 2,
      dateStrings: true,
    });
    if (options.readOnly) {
      // Before the pool hands a connection out: the server refuses writes in this session, whatever the SQL says.
      pool.pool.on('connection', (connection) => {
        connection.query('SET SESSION TRANSACTION READ ONLY');
      });
    }
    return new MySqlDb(pool, options.guard ?? (() => undefined));
  }

  async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    if (!isReadOnlySql(sql)) this.guard('write');
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows.map((row) => ({ ...row }));
  }

  /** The single row a query returns; throws on zero or several, naming the count. */
  async one(sql: string, params: unknown[] = []): Promise<Row> {
    const rows = await this.rows(sql, params);
    if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}: ${sql}`);
    return rows[0];
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.rows(sql, params)).length;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
