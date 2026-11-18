/** Read access to a MySQL database, for asserting what a call wrote (or did not write). Parameterised queries only. */
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';

export type Row = Record<string, unknown>;

export class MySqlDb {
  private constructor(private readonly pool: Pool) {}

  /** `mysql://user:password@host:port/database` */
  static connect(url: string): MySqlDb {
    // dateStrings: rows compare as the stored text, not as Dates shifted into the runner's time zone.
    return new MySqlDb(createPool({ uri: url, connectionLimit: 2, dateStrings: true }));
  }

  async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
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
