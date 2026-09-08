/**
 * Neo4jGraphStore 真实服务集成测试
 * （对应源文件 hello_agents/memory/storage/neo4j-store.ts；
 * issue #84 验收："可重现的真实服务集成，记录后端版本与结果"）。
 *
 * 运行条件：
 * - 本机需要 docker（自动探测）；无 docker 或 `HELLOAGENTS_DB_INTEGRATION=0`
 *   时整组 skip，CI 默认不执行。
 * - 端口 7474/7687：若已被同版本服务占用则复用，否则自动拉起容器并在结束后删除。
 * - 使用默认数据库 neo4j（社区版不支持自定义数据库名）；用例开头清库保证可重现。
 *
 * 后端版本记录：测试输出（stdout）打印 Neo4j 镜像；PR 描述同步记录。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Neo4jGraphStore } from '../hello_agents/memory/storage/index.js';
import { cleanupTrackedContainers, dockerAvailable, ensureNeo4j } from './helpers/db-test-utils.js';

let image = 'unknown';

beforeAll(
  async () => {
    if (!dockerAvailable()) return;
    const info = await ensureNeo4j();
    image = info.image;
    process.stdout.write(`[db-integration] Neo4j image=${image}\n`);
  },
  // docker 拉镜像 + 起服务可能耗时较长（首次可达数分钟）
  600_000
);

afterAll(() => {
  cleanupTrackedContainers();
});

describe.skipIf(!dockerAvailable())('Neo4jGraphStore real service integration', () => {
  beforeAll(async () => {
    await new Neo4jGraphStore().clearAll();
  }, 30_000);

  test('health check reports true against a live server', async () => {
    const store = new Neo4jGraphStore();
    expect(await store.healthCheck()).toBe(true);
  });

  test('addEntity/addRelationship persist entities and relationships', async () => {
    const store = new Neo4jGraphStore();
    expect(await store.addEntity({ entity_id: 'e1', name: 'Alice', entity_type: 'PERSON' })).toBe(
      true
    );
    expect(
      await store.addEntity({ entity_id: 'e2', name: 'HelloAgents', entity_type: 'PRODUCT' })
    ).toBe(true);
    expect(
      await store.addRelationship({
        from_entity_id: 'e1',
        to_entity_id: 'e2',
        relationship_type: 'WORKS_ON'
      })
    ).toBe(true);
    // incoming 关系（e2 -> e1），用于验证 direction 双向语义
    expect(
      await store.addRelationship({
        from_entity_id: 'e2',
        to_entity_id: 'e1',
        relationship_type: 'MANAGES'
      })
    ).toBe(true);
  });

  test('findRelatedEntities returns neighbors with distance and relationship path', async () => {
    const store = new Neo4jGraphStore();
    const related = await store.findRelatedEntities({ entity_id: 'e1', max_depth: 2 });
    expect(related.length).toBeGreaterThan(0);
    const hit = related.find((r) => r.id === 'e2');
    expect(hit).toBeDefined();
    expect(hit?.distance).toBe(1);
    expect(Array.isArray(hit?.relationship_path)).toBe(true);
  });

  test('findRelatedEntities honors relationship type filtering', async () => {
    const store = new Neo4jGraphStore();
    await store.addEntity({ entity_id: 'e3', name: 'Bob', entity_type: 'PERSON' });
    await store.addRelationship({
      from_entity_id: 'e1',
      to_entity_id: 'e3',
      relationship_type: 'KNOWS'
    });
    const onlyKnows = await store.findRelatedEntities({
      entity_id: 'e1',
      relationship_types: ['KNOWS'],
      max_depth: 1
    });
    expect(onlyKnows.map((r) => r.id).sort()).toEqual(['e3']);
  });

  test('searchEntitiesByName supports partial name matching and type filter', async () => {
    const store = new Neo4jGraphStore();
    const byName = await store.searchEntitiesByName({ name_pattern: 'lice' });
    expect(byName.map((e) => e.id)).toContain('e1');
    const byType = await store.searchEntitiesByName({
      name_pattern: '.*',
      entity_types: ['PRODUCT'],
      limit: 10
    });
    expect(byType.map((e) => e.id)).toContain('e2');
  });

  test('getEntityRelationships reports direction', async () => {
    const store = new Neo4jGraphStore();
    const rels = await store.getEntityRelationships('e1');
    expect(rels.length).toBeGreaterThan(0);
    // WORKS_ON(e1->e2) 为 outgoing，MANAGES(e2->e1) 为 incoming
    expect(rels.some((r) => r.direction === 'outgoing')).toBe(true);
    expect(rels.some((r) => r.direction === 'incoming')).toBe(true);
  });

  test('getStats counts nodes and relationships', async () => {
    const store = new Neo4jGraphStore();
    const stats = await store.getStats();
    expect(Number(stats.total_nodes)).toBeGreaterThan(0);
    expect(Number(stats.entity_nodes)).toBeGreaterThan(0);
    expect(Number(stats.total_relationships)).toBeGreaterThan(0);
  });

  test('deleteEntity removes a node and its relationships', async () => {
    const store = new Neo4jGraphStore();
    expect(await store.deleteEntity('e3')).toBe(true);
    expect(await store.deleteEntity('e3')).toBe(false);
  });

  test('clearAll empties the database', async () => {
    const store = new Neo4jGraphStore();
    expect(await store.clearAll()).toBe(true);
    const stats = await store.getStats();
    expect(Number(stats.total_nodes)).toBe(0);
  });
});

describe('Neo4jGraphStore offline behavior', () => {
  test('healthCheck returns false for an unreachable server', async () => {
    const store = new Neo4jGraphStore({ uri: 'bolt://localhost:7690' });
    expect(await store.healthCheck()).toBe(false);
  });
});
