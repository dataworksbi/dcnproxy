export interface IDatabaseConnectionPool {
  execute<T = any>(sql: string, parameters: Record<string, any>, fieldMetaMap?: Map<string, any>, option?: any): Promise<T>;
}