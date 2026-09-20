import { DatabaseConnectionPool } from './provider.abstract.js';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

export class PostgresConnectionPool extends DatabaseConnectionPool {
  private poolCache = new Map<string, Pool>();

  /**
   * Retrieves or instantiates a cached connection pool mapped to a tenant's database connection string
   */
  private async getPoolForTenant(connectionString: string): Promise<Pool> {
    if (this.poolCache.has(connectionString)) {
      return this.poolCache.get(connectionString)!;
    }

    const config: PoolConfig = {
      connectionString,
    };

    const pool = new Pool(config);
    // Test the pool connection
    const client = await pool.connect();
    client.release();

    this.poolCache.set(connectionString, pool);
    return pool;
  }

  public async execute<T = any>(
    sql: string,
    parameters: Record<string, any>,
    fieldMetaMap?: Map<string, any>,
    option?: any
  ): Promise<T> {
    // Pull the local client's connection string from the proxy's environment variables
    const connectionString = process.env.ACCOUNT_DB_URL;
    if (!connectionString) {
      throw new Error('ACCOUNT_DB_URL environment variable is missing in proxy runtime.');
    }

    const pool = await this.getPoolForTenant(connectionString);

    // Handle pagination tokens for PostgreSQL
    if (option && option.limit) {
      sql = sql.replace('__top_dcn_token__', '');
      const offsetClause = option.offset ? ` OFFSET ${option.offset}` : '';
      sql = sql.replace('__tail_dcn_token__', ` LIMIT ${option.limit}${offsetClause}`);
    } else {
      sql = sql.replace('__top_dcn_token__', '');
      sql = sql.replace('__tail_dcn_token__', '');
    }

    const values: any[] = [];
    let paramIndex = 1;

    // Convert SQL Server named parameters (@param_name) to PostgreSQL positional parameters ($1, $2, ...)
    if (parameters) {
      Object.entries(parameters).forEach(([key, value]) => {
        const cleanFieldName = key
          .replace(/^p_/, '')
          .replace(/_\d+_\d+$/, '')
          .replace(/_\d+$/, '')
          .replace(/_\d+_(start|end)$/, '')
          .replace(/_(start|end)$/, '');

        const meta = fieldMetaMap?.get(cleanFieldName);
        let processedValue = value;

        if (meta && meta.db_data_type) {
          const dbTypeUpper = meta.db_data_type.toUpperCase();

          if (meta.data_type === 'DATE' && (dbTypeUpper.startsWith('DECIMAL') || dbTypeUpper.startsWith('NUMERIC'))) {
            if (value instanceof Date) {
              processedValue = parseInt(value.toISOString().slice(0, 10).replace(/-/g, ''), 10);
            } else if (typeof value === 'string' && value.includes('-')) {
              processedValue = parseInt(value.replace(/-/g, ''), 10);
            } else if (value !== null) {
              processedValue = parseFloat(value);
            }
          } else if (dbTypeUpper.startsWith('DECIMAL') || dbTypeUpper.startsWith('NUMERIC') || dbTypeUpper.startsWith('BIGINT') || dbTypeUpper.startsWith('INT')) {
            processedValue = value === null ? null : Number(value);
          }
        }

        values.push(processedValue);

        // Replace all instances of @key with $paramIndex in the SQL string
        // (Ensures safe parameter mapping)
        const placeholderRegex = new RegExp(`@${key}\\b`, 'g');
        sql = sql.replace(placeholderRegex, `$${paramIndex}`);
        paramIndex++;
      });
    }

    const result = await pool.query(sql, values);
    const recordset = result.rows;

    if (fieldMetaMap && recordset.length > 0) {
      recordset.forEach((row: any) => {
        Object.keys(row).forEach((key) => {
          const meta = fieldMetaMap.get(key);
          if (meta && meta.data_type === 'DATE' && typeof row[key] === 'number') {
            row[key] = this.formatDecimalToDateString(row[key]);
          }
        });
      });
    }

    return recordset as unknown as T;
  }

  private formatDecimalToDateString(val: number): string {
    const s = val.toString();
    if (s.length !== 8) return s;
    return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
  }

  public async closeAllPools() {
    for (const pool of this.poolCache.values()) {
      await pool.end();
    }
  }
}