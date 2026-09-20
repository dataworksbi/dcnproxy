import type { IDatabaseConnectionPool } from './provider.interface.js';

export async function createDatabasePool(dbType: string): Promise<IDatabaseConnectionPool> {
  switch (dbType.toLowerCase()) {
    case 'sqlserver': {
      const { SqlServerConnectionPool } = await import('./mssql.provider.js');
      return new SqlServerConnectionPool();
    }
    case 'postgres': {
      const { PostgresConnectionPool } = await import('./postgres.provider.js');
      return new PostgresConnectionPool();
    }
    /*case 'oracle': {
      const { OracleConnectionPool } = await import('./oracle.provider.js');
      return new OracleConnectionPool();
    }*/
    case 'odbc': {
      const { ODBCConnectionPool } = await import('./odbc.provider.js');
      return new ODBCConnectionPool();
    }
    default:
      throw new Error(`Unsupported DB_PROVIDER: ${dbType}`);
  }
}