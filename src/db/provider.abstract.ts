import type { IDatabaseConnectionPool } from './provider.interface.js';

export abstract class DatabaseConnectionPool implements IDatabaseConnectionPool {
  abstract execute<T = any>(sql: string, parameters: Record<string, any>, fieldMetaMap?: Map<string, any>, option?: any): Promise<T>;
}