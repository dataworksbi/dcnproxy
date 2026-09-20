import { DatabaseConnectionPool } from './provider.abstract.js';
import * as mssql from 'mssql';

export class SqlServerConnectionPool extends DatabaseConnectionPool {
  private poolCache = new Map<string, mssql.ConnectionPool>();

  /**
   * Retrieves or instantiates a cached connection pool mapped to a tenant's database connection string
   */
  private async getPoolForTenant(connectionString: string): Promise<mssql.ConnectionPool> {
    if (this.poolCache.has(connectionString)) {
      return this.poolCache.get(connectionString)!;
    }

    const config = mssql.ConnectionPool.parseConnectionString(connectionString);
    const pool = new mssql.ConnectionPool(config);
    await pool.connect();
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
    const request = pool.request();

    if (option && option.limit) {
      sql = sql.replace('__top_dcn_token__', 'TOP ' + option.limit);
      sql = sql.replace('__tail_dcn_token__', '');
    }

    // Bind safe query inputs
    if (parameters) {
      Object.entries(parameters).forEach(([key, value]) => {
        const cleanFieldName = key
          .replace(/^p_/, '')
          .replace(/_\d+_\d+$/, '')
          .replace(/_\d+$/, '')
          .replace(/_\d+_(start|end)$/, '')
          .replace(/_(start|end)$/, '');

        const meta = fieldMetaMap?.get(cleanFieldName);
        if (meta && meta.db_data_type) {
          const dbTypeUpper = meta.db_data_type.toUpperCase();
          
          if (meta.data_type === 'DATE' && dbTypeUpper.startsWith('DECIMAL')) {
            if (value instanceof Date) {
              const yyyymmdd = parseInt(value.toISOString().slice(0, 10).replace(/-/g, ''), 10);
              request.input(key, mssql.Decimal(8, 0), yyyymmdd);
            } else if (typeof value === 'string' && value.includes('-')) {
              const yyyymmdd = parseInt(value.replace(/-/g, ''), 10);
              request.input(key, mssql.Decimal(8, 0), yyyymmdd);
            } else {
              request.input(key, mssql.Decimal(8, 0), parseFloat(value));
            }
          } else if (dbTypeUpper.startsWith('DECIMAL')) {
            const match = dbTypeUpper.match(/\(([^)]+)\)/);
            let precision = 18;
            let scale = 0;
            if (match) {
              const parts = match[1].split(',');
              precision = parseInt(parts[0], 10);
              scale = parts[1] ? parseInt(parts[1], 10) : 0;
            }
            const parsedValue = value === null ? null : parseFloat(value);
            request.input(key, mssql.Decimal(precision, scale), parsedValue);
          } else if (dbTypeUpper.startsWith('BIGINT')) {
            request.input(key, mssql.BigInt, value === null ? null : parseInt(value, 10));
          } else if (dbTypeUpper.startsWith('INT')) {
            request.input(key, mssql.Int, value === null ? null : parseInt(value, 10));
          } else {
            request.input(key, mssql.VarChar, value);
          }
        } else {
          request.input(key, value);
        }
      });
    }

    const result = await request.query(sql);
    const recordset = result.recordset;

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
      await pool.close();
    }
  }
}