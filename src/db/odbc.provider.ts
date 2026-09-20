import { DatabaseConnectionPool } from './provider.abstract.js';
import odbc from 'odbc';
import type { Pool as ODBCPool, Connection } from 'odbc';

export class ODBCConnectionPool extends DatabaseConnectionPool {
  private poolCache = new Map<string, ODBCPool>();

  /**
   * Retrieves or instantiates a cached connection pool mapped to a tenant's database connection string
   */
  private async getPoolForTenant(connectionString: string): Promise<ODBCPool> {
    if (this.poolCache.has(connectionString)) {
      return this.poolCache.get(connectionString)!;
    }

    // Initialize an ODBC connection pool
    const pool = await odbc.pool(connectionString);
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

    if (option && option.limit) {
      sql = sql.replace('__top_dcn_token__', 'TOP ' + option.limit);
      sql = sql.replace('__tail_dcn_token__', '');
    } else {
      sql = sql.replace('__top_dcn_token__', '');
      sql = sql.replace('__tail_dcn_token__', '');
    }

    const parametersArray: any[] = [];

    // Convert SQL Server named parameters (@param_name) to ODBC positional parameters (?)
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
          
          if (meta.data_type === 'DATE' && dbTypeUpper.startsWith('DECIMAL')) {
            if (value instanceof Date) {
              processedValue = parseInt(value.toISOString().slice(0, 10).replace(/-/g, ''), 10);
            } else if (typeof value === 'string' && value.includes('-')) {
              processedValue = parseInt(value.replace(/-/g, ''), 10);
            } else if (value !== null) {
              processedValue = parseFloat(value);
            }
          } else if (dbTypeUpper.startsWith('DECIMAL') || dbTypeUpper.startsWith('BIGINT') || dbTypeUpper.startsWith('INT')) {
            processedValue = value === null ? null : Number(value);
          }
        }

        parametersArray.push(processedValue);

        // Replace all instances of @key with ? for ODBC execution
        const placeholderRegex = new RegExp(`@${key}\\b`, 'g');
        sql = sql.replace(placeholderRegex, '?');
      });
    }

    // Execute query using an acquired connection from the ODBC pool
    const connection: Connection = await pool.connect();
    try {
      const result = await connection.query(sql, parametersArray);
      const recordset = Array.isArray(result) ? result : (result as any).values || [];

      if (fieldMetaMap && recordset.length > 0) {
        recordset.forEach((row: any) => {
          Object.keys(row).forEach((k) => {
            const meta = fieldMetaMap.get(k);
            if (meta && meta.data_type === 'DATE' && typeof row[k] === 'number') {
              row[k] = this.formatDecimalToDateString(row[k]);
            }
          });
        });
      }

      return recordset as unknown as T;
    } finally {
      await connection.close();
    }
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