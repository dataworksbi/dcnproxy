import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IDatabaseConnectionPool } from './db/provider.interface.js';
import { createDatabasePool } from './db/factory.js';

export const server = Fastify({ logger: true });

// Whitelisted API keys (loaded securely from environment variables)
const VALID_API_KEYS = new Set([
  process.env.TENANT_API_KEY || 'dcn_sec_live_default_key'
]);

interface ConnectionConfig {
  provider: string;
  url: string;
}

const dbConfigs = new Map<string, ConnectionConfig>();
const activePools = new Map<string, IDatabaseConnectionPool>();

/**
 * Parses indexed environment variables (DB_NAME1, DB_PROVIDER1, DB_URL1, etc.) on startup
 */
function initializeDatabaseConfigs() {
  let i = 1;
  while (process.env[`DB_NAME${i}`]) {
    const name = process.env[`DB_NAME${i}`]!.toLowerCase();
    const provider = process.env[`DB_PROVIDER${i}`] || 'sqlserver';
    const url = process.env[`DB_URL${i}`];

    if (url) {
      dbConfigs.set(name, { provider, url });
      server.log.info(`Registered database target [${name}] using provider [${provider}]`);
    }
    i++;
  }

  // Fallback support if using legacy single-connection env vars
  if (dbConfigs.size === 0 && process.env.ACCOUNT_DB_URL) {
    dbConfigs.set('default', {
      provider: process.env.DB_PROVIDER || 'sqlserver',
      url: process.env.ACCOUNT_DB_URL
    });
    server.log.info(`Registered fallback 'default' database target.`);
  }
}

// Run config parser on boot
initializeDatabaseConfigs();

async function getPoolForTarget(targetName: string): Promise<IDatabaseConnectionPool> {
  const normalizedName = targetName.toLowerCase();

  if (activePools.has(normalizedName)) {
    return activePools.get(normalizedName)!;
  }

  const config = dbConfigs.get(normalizedName);
  if (!config) {
    const availableTargets = Array.from(dbConfigs.keys()).join(', ');
    throw new Error(`Database target "${targetName}" is not configured. Available targets: [${availableTargets}]`);
  }

  server.log.info(`Initializing active connection pool for target: [${normalizedName}]`);

  // Create the pool via your existing factory
  const pool = await createDatabasePool(config.provider);

  // Temporarily set ACCOUNT_DB_URL so the provider's .execute() method picks it up cleanly
  process.env.ACCOUNT_DB_URL = config.url;

  activePools.set(normalizedName, pool);
  return pool;
}

// Global Authentication Hook
server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
  if (request.url === '/health') return;

  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey || !VALID_API_KEYS.has(apiKey)) {
    return reply.code(401).send({ 
      success: false, 
      error: 'Unauthorized: Missing or invalid Tenant API Key.' 
    });
  }
});

// Secure endpoint supporting multi-database routing via connectionName
server.post('/api/debtdata/query', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as { 
      connection: string; // Matches the DB_NAME# defined in .env (e.g., "masterdata" or "archives")
      sql: string; 
      parameters?: Record<string, any>; 
      fieldMetaMap?: Array<[string, any]> | Record<string, any>; 
      option?: any;
    };

    if (!body || !body.connection) {
      return reply.code(400).send({
        success: false,
        error: 'Missing required field: "connection" in request body.'
      });
    }
    if (!body || !body.sql) {
      return reply.code(400).send({
        success: false,
        error: 'Missing required field: "sql" in request body.'
      });
    }

    let fieldMetaMap: Map<string, any> | undefined;
    if (body.fieldMetaMap) {
      fieldMetaMap = Array.isArray(body.fieldMetaMap)
        ? new Map(body.fieldMetaMap)
        : new Map(Object.entries(body.fieldMetaMap));
    }

    // Default to the first configured database if none specified, or look up the named connection
    const targetConnection = body.connection || Array.from(dbConfigs.keys())[0] || 'default';
    const dbPool = await getPoolForTarget(targetConnection);

    const results = await dbPool.execute(
      body.sql, 
      body.parameters || {}, 
      fieldMetaMap, 
      body.option
    );

    return {
      success: true,
      connectionTarget: targetConnection,
      timestamp: new Date().toISOString(),
      data: results
    };
  } catch (err: any) {
    server.log.error(err);
    return reply.code(500).send({ 
      success: false, 
      error: err?.message || 'Internal proxy execution error.' 
    });
  }
});

// Health check endpoint displaying active configured targets
server.get('/health', async () => {
  return { 
    status: 'online', 
    mode: 'multi-db-indexed-proxy',
    configuredTargets: Array.from(dbConfigs.keys())
  };
});