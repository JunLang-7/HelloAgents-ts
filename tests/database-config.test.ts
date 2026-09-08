import { afterEach, describe, expect, test } from 'bun:test';

import {
  DatabaseConfig,
  Neo4jConfig,
  QdrantConfig,
  dbConfig,
  getDatabaseConfig,
  updateDatabaseConfig
} from '../hello_agents/core/database-config.js';

const ENV_KEYS = [
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'QDRANT_COLLECTION',
  'QDRANT_VECTOR_SIZE',
  'QDRANT_DISTANCE',
  'QDRANT_TIMEOUT',
  'NEO4J_URI',
  'NEO4J_USERNAME',
  'NEO4J_PASSWORD',
  'NEO4J_DATABASE',
  'NEO4J_MAX_CONNECTION_LIFETIME',
  'NEO4J_MAX_CONNECTION_POOL_SIZE',
  'NEO4J_CONNECTION_TIMEOUT'
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('QdrantConfig', () => {
  test('defaults match the upstream pydantic defaults', () => {
    const config = new QdrantConfig();
    expect(config.url).toBeUndefined();
    expect(config.api_key).toBeUndefined();
    expect(config.collection_name).toBe('hello_agents_vectors');
    expect(config.vector_size).toBe(384);
    expect(config.distance).toBe('cosine');
    expect(config.timeout).toBe(30);
  });

  test('toDict omits undefined url/api_key (exclude_none semantics)', () => {
    expect(new QdrantConfig().toDict()).toEqual({
      collection_name: 'hello_agents_vectors',
      vector_size: 384,
      distance: 'cosine',
      timeout: 30
    });
    expect(new QdrantConfig({ url: 'http://localhost:6333', api_key: 'k' }).toDict()).toMatchObject(
      { url: 'http://localhost:6333', api_key: 'k' }
    );
  });

  test('fromEnv reads QDRANT_* environment variables', () => {
    process.env.QDRANT_URL = 'http://qdrant.example:6333';
    process.env.QDRANT_API_KEY = 'secret';
    process.env.QDRANT_COLLECTION = 'my_collection';
    process.env.QDRANT_VECTOR_SIZE = '768';
    process.env.QDRANT_DISTANCE = 'dot';
    process.env.QDRANT_TIMEOUT = '15';
    const config = QdrantConfig.fromEnv();
    expect(config.url).toBe('http://qdrant.example:6333');
    expect(config.api_key).toBe('secret');
    expect(config.collection_name).toBe('my_collection');
    expect(config.vector_size).toBe(768);
    expect(config.distance).toBe('dot');
    expect(config.timeout).toBe(15);
  });

  test('fromEnv falls back to defaults for invalid numbers', () => {
    process.env.QDRANT_VECTOR_SIZE = 'not-a-number';
    expect(QdrantConfig.fromEnv().vector_size).toBe(384);
  });
});

describe('Neo4jConfig', () => {
  test('defaults match the upstream pydantic defaults', () => {
    const config = new Neo4jConfig();
    expect(config.uri).toBe('bolt://localhost:7687');
    expect(config.username).toBe('neo4j');
    expect(config.password).toBe('hello-agents-password');
    expect(config.database).toBe('neo4j');
    expect(config.max_connection_lifetime).toBe(3600);
    expect(config.max_connection_pool_size).toBe(50);
    expect(config.connection_acquisition_timeout).toBe(60);
  });

  test('toDict returns all fields', () => {
    const config = new Neo4jConfig();
    expect(config.toDict()).toEqual({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'hello-agents-password',
      database: 'neo4j',
      max_connection_lifetime: 3600,
      max_connection_pool_size: 50,
      connection_acquisition_timeout: 60
    });
  });

  test('fromEnv reads NEO4J_* environment variables', () => {
    process.env.NEO4J_URI = 'neo4j+s://abc.databases.neo4j.io';
    process.env.NEO4J_USERNAME = 'alice';
    process.env.NEO4J_PASSWORD = 'pw';
    process.env.NEO4J_DATABASE = 'appdb';
    const config = Neo4jConfig.fromEnv();
    expect(config.uri).toBe('neo4j+s://abc.databases.neo4j.io');
    expect(config.username).toBe('alice');
    expect(config.password).toBe('pw');
    expect(config.database).toBe('appdb');
  });
});

describe('DatabaseConfig', () => {
  test('fromEnv builds both backends', () => {
    process.env.QDRANT_COLLECTION = 'env_collection';
    process.env.NEO4J_DATABASE = 'env_db';
    const config = DatabaseConfig.fromEnv();
    expect(config.qdrant.collection_name).toBe('env_collection');
    expect(config.neo4j.database).toBe('env_db');
  });

  test('getQdrantConfig/getNeo4jConfig return plain dicts', () => {
    const config = new DatabaseConfig();
    expect(config.getQdrantConfig()).toEqual(new QdrantConfig().toDict());
    expect(config.getNeo4jConfig()).toEqual(new Neo4jConfig().toDict());
  });

  test('updateDatabaseConfig rebuilds only the provided backend', () => {
    const before = getDatabaseConfig();
    updateDatabaseConfig({ qdrant: { collection_name: 'updated_collection' } });
    expect(dbConfig.qdrant.collection_name).toBe('updated_collection');
    // neo4j 未被触碰
    expect(dbConfig.neo4j).toBe(before.neo4j);
    expect(dbConfig.neo4j.database).toBe(before.neo4j.database);
  });

  test('validateConnections reports both backends without throwing when services are absent', async () => {
    const results = await new DatabaseConfig().validateConnections();
    expect(typeof results.qdrant).toBe('boolean');
    expect(typeof results.neo4j).toBe('boolean');
  });
});
