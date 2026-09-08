import { afterEach, describe, expect, test } from 'bun:test';

import fixture from './fixtures/learn-v0.2.0-memory.json' with { type: 'json' };
import { MemoryTool } from '../hello_agents/index.js';
import {
  BaseMemory,
  Entity,
  Episode,
  EpisodicMemory,
  MemoryConfig,
  MemoryItem,
  MemoryManager,
  Perception,
  PerceptualMemory,
  Relation,
  SemanticMemory,
  WorkingMemory
} from '../hello_agents/memory/index.js';
import type {
  DocumentStorePort,
  GraphStorePort,
  StoredMemoryDoc,
  TextEmbedder,
  VectorStorePort
} from '../hello_agents/memory/index.js';

function item(
  id: string,
  content: string,
  init: {
    memoryType?: string;
    userId?: string;
    importance?: number;
    ageMin?: number;
    metadata?: Record<string, unknown>;
  } = {}
): MemoryItem {
  return new MemoryItem({
    id,
    content,
    memoryType: init.memoryType ?? 'working',
    userId: init.userId ?? 'user-a',
    timestamp: new Date(Date.now() - (init.ageMin ?? 0) * 60_000),
    importance: init.importance ?? 0.5,
    metadata: init.metadata ?? {}
  });
}

describe('learn v0.2.0 memory fixture parity', () => {
  test('MemoryConfig defaults match the pinned Python MemoryConfig', () => {
    expect(new MemoryConfig().toDict()).toEqual(fixture.config);
  });

  test('MemoryTool name, parameters and expansion match the fixture', () => {
    const tool = new MemoryTool({ expandable: true });
    expect(tool.name).toBe(fixture.tool.name);
    const parameters = tool.getParameters();
    expect(parameters.map((p) => p.name)).toEqual(fixture.tool.parameters.map((p) => p.name));
    expect(parameters.map((p) => [p.type, p.required, p.default])).toEqual(
      fixture.tool.parameters.map((p) => [p.type, p.required, p.default])
    );
    expect(tool.getExpandedTools()!.map((t) => t.name)).toEqual(fixture.tool.expanded_tools);
  });

  test('importance scoring matches the pinned rules', () => {
    class Probe extends BaseMemory {
      add() {
        return '';
      }
      retrieve(): MemoryItem[] {
        return [];
      }
      update() {
        return false;
      }
      remove() {
        return false;
      }
      hasMemory() {
        return false;
      }
      clear() {}
      getStats() {
        return {};
      }
      public probe(content: string, base = 0.5) {
        return this.calculateImportance(content, base);
      }
    }
    const probe = new Probe(new MemoryConfig(), 'working');
    expect(probe.probe('普通内容')).toBe(fixture.importance.plain);
    expect(probe.probe('这是重要内容')).toBe(fixture.importance.keyword);
    expect(probe.probe('a'.repeat(101))).toBe(fixture.importance.long_only);
    expect(probe.probe(`重要${'a'.repeat(101)}`)).toBe(fixture.importance.keyword_and_long);
  });
});

describe('WorkingMemory', () => {
  test('add/retrieve ranks by keyword, decay and importance; isolates users', () => {
    const wm = new WorkingMemory();
    wm.add(item('w1', 'react hooks manage component state', { importance: 0.9 }));
    wm.add(item('w2', 'react context avoids prop drilling', { importance: 0.6 }));
    wm.add(item('w3', 'lunch order', { importance: 0.9 }));
    const hits = wm.retrieve('react', 5, { userId: 'user-a' });
    expect(hits.map((h) => h.id)).toEqual(['w1', 'w2']);
    expect(wm.retrieve('react', 5, { userId: 'other' })).toHaveLength(0);
  });

  test('TTL expires stale entries lazily', () => {
    const config = new MemoryConfig({ working_memory_ttl_minutes: 60 });
    const wm = new WorkingMemory(config);
    wm.add(item('old', 'stale content', { ageMin: 61 }));
    expect(wm.getAll()).toHaveLength(1);
    wm.add(item('fresh', 'fresh content'));
    expect(wm.getAll().map((m) => m.id)).toEqual(['fresh']);
  });

  test('capacity eviction drops the lowest priority', () => {
    const config = new MemoryConfig({ working_memory_capacity: 3 });
    const wm = new WorkingMemory(config);
    wm.add(item('c1', 'c1', { importance: 0.9 }));
    wm.add(item('c2', 'c2', { importance: 0.8 }));
    wm.add(item('c3', 'c3', { importance: 0.7 }));
    wm.add(item('c4', 'c4', { importance: 0.6 }));
    const ids = wm.getAll().map((m) => m.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('c4');
  });

  test('token budget eviction keeps currentTokens at or below the cap', () => {
    const config = new MemoryConfig({ working_memory_tokens: 5 });
    const wm = new WorkingMemory(config);
    wm.add(item('t1', 'aaa bbb ccc'));
    wm.add(item('t2', 'ddd eee fff'));
    expect(wm.getAll()).toHaveLength(1);
    expect((wm.getStats().current_tokens as number) <= 5).toBe(true);
  });

  test('update/remove/hasMemory/getRecent/getImportant/context summary', () => {
    const wm = new WorkingMemory();
    wm.add(item('u1', 'before', { importance: 0.2 }));
    expect(wm.hasMemory('u1')).toBe(true);
    expect(wm.update('u1', 'after', 0.8, { tag: 'x' })).toBe(true);
    const got = wm.getAll()[0]!;
    expect(got.content).toBe('after');
    expect(got.metadata.tag).toBe('x');
    expect(wm.getImportant(1)[0]!.id).toBe('u1');
    expect(wm.getRecent(1)[0]!.id).toBe('u1');
    expect(wm.getContextSummary()).toContain('Working Memory Context');
    expect(wm.remove('u1')).toBe(true);
    expect(wm.hasMemory('u1')).toBe(false);
    expect(new WorkingMemory().getContextSummary()).toBe(fixture.tool.messages.empty_context);
  });

  test('forget strategies', () => {
    const wm = new WorkingMemory(new MemoryConfig({ working_memory_capacity: 100 }));
    wm.add(item('f1', 'low importance', { importance: 0.05 }));
    wm.add(item('f2', 'high importance', { importance: 0.9 }));
    expect(wm.forget('importance_based', 0.1)).toBe(1);
    expect(wm.getAll().map((m) => m.id)).toEqual(['f2']);

    // TTL 放宽到 30 天，使 time_based 策略（max_age_days=1）成为唯一淘汰来源。
    const wm2 = new WorkingMemory(new MemoryConfig({ working_memory_ttl_minutes: 60 * 24 * 30 }));
    wm2.add(item('old', 'old text', { ageMin: 60 * 24 * 2 }));
    wm2.add(item('new', 'new text'));
    expect(wm2.forget('time_based', 0.1, 1)).toBe(1);

    const wm3 = new WorkingMemory(new MemoryConfig({ working_memory_capacity: 2 }));
    wm3.add(item('a', 'a', { importance: 0.9 }));
    wm3.add(item('b', 'b', { importance: 0.8 }));
    wm3.add(item('c', 'c', { importance: 0.7 }));
    expect(wm3.getAll()).toHaveLength(2);
  });

  test('stats expose the pinned key set', () => {
    const wm = new WorkingMemory();
    wm.add(item('s1', 'stats content'));
    expect(Object.keys(wm.getStats())).toEqual(fixture.stats_keys.working);
  });

  test('clear resets memories and tokens', () => {
    const wm = new WorkingMemory();
    wm.add(item('z', 'z'));
    wm.clear();
    expect(wm.getAll()).toHaveLength(0);
    expect(wm.getStats().current_tokens).toBe(0);
  });
});

describe('EpisodicMemory', () => {
  test('add groups episodes by session and keyword fallback retrieves them', () => {
    const em = new EpisodicMemory();
    em.add(
      item('e1', 'discussed react hooks design', {
        memoryType: 'episodic',
        metadata: { session_id: 's1', context: { channel: 'slack' }, outcome: 'ok' }
      })
    );
    em.add(
      item('e2', 'discussed react router', {
        memoryType: 'episodic',
        metadata: { session_id: 's1' }
      })
    );
    em.add(
      item('e3', 'lunch', {
        memoryType: 'episodic',
        metadata: { session_id: 's2' }
      })
    );
    expect(em.getSessionEpisodes('s1')).toHaveLength(2);
    const hits = em.retrieve('react', 5, { userId: 'user-a' });
    expect(hits.map((h) => h.id).sort()).toEqual(['e1', 'e2']);
    expect(hits[0]!.metadata.session_id).toBeDefined();
    expect(hits[0]!.metadata.relevance_score).toBeGreaterThan(0);
  });

  test('getAll metadata compatibility fix carries session/context/outcome', () => {
    const em = new EpisodicMemory();
    em.add(
      item('e', 'content', {
        memoryType: 'episodic',
        metadata: { session_id: 's9', context: { k: 'v' }, outcome: 'done' }
      })
    );
    const all = em.getAll();
    expect(all[0]!.metadata.session_id).toBe('s9');
    expect(all[0]!.metadata.outcome).toBe('done');
    expect((all[0]!.metadata.context as Record<string, unknown>).k).toBe('v');
  });

  test('timeline truncates long content and stays newest-first', () => {
    const em = new EpisodicMemory();
    em.add(item('old', 'x'.repeat(120), { memoryType: 'episodic', ageMin: 10 }));
    em.add(item('new', 'short', { memoryType: 'episodic' }));
    const timeline = em.getTimeline();
    expect(timeline[0]!.episode_id).toBe('new');
    expect((timeline[1]!.content as string).endsWith('...')).toBe(true);
  });

  test('pattern analysis caches repeated keywords/context', () => {
    const em = new EpisodicMemory();
    for (let i = 0; i < 3; i += 1)
      em.add(
        item(`p${i}`, 'deploy deploy deploy', {
          memoryType: 'episodic',
          metadata: { context: { env: 'prod' } }
        })
      );
    const patterns = em.findPatterns(undefined, 2);
    const contextPattern = patterns.find((p) => p.pattern === 'env:prod');
    expect(contextPattern?.frequency).toBe(3);
  });

  test('update/remove/forget/clear', () => {
    const em = new EpisodicMemory(new MemoryConfig({ max_capacity: 100 }));
    em.add(item('e', 'old content', { memoryType: 'episodic', importance: 0.05 }));
    expect(em.update('e', 'new content', 0.9, { context: { a: 1 } })).toBe(true);
    expect(em.getAll()[0]!.content).toBe('new content');
    em.add(item('low', 'low', { memoryType: 'episodic', importance: 0.05 }));
    expect(em.forget('importance_based', 0.1)).toBe(1);
    expect(em.remove('e')).toBe(true);
    expect(em.hasMemory('e')).toBe(false);
    em.add(item('x', 'x', { memoryType: 'episodic' }));
    em.clear();
    expect(em.getAll()).toHaveLength(0);
    expect(em.sessions.size).toBe(0);
  });

  test('stats keys and memory_type', () => {
    const em = new EpisodicMemory();
    em.add(item('e', 'c', { memoryType: 'episodic' }));
    const stats = em.getStats();
    expect(Object.keys(stats)).toEqual(fixture.stats_keys.episodic);
    expect(stats.memory_type).toBe(fixture.memory_type_labels.episodic);
    expect(stats.sessions_count).toBe(1);
  });

  test('Episode value object roundtrip shape', () => {
    const ep = new Episode({
      episodeId: 'ep',
      userId: 'u',
      sessionId: 's',
      timestamp: new Date(),
      content: 'c',
      context: { a: 1 },
      outcome: 'done',
      importance: 0.8
    });
    expect(ep.metadata).toEqual({ session_id: 's', context: { a: 1 }, outcome: 'done' });
  });

  test('injected vector + document backends drive the rerank path', () => {
    const rows = new Map<string, StoredMemoryDoc>();
    const docStore: DocumentStorePort = {
      addMemory: (doc) => rows.set(doc.memory_id, doc),
      getMemory: (id) => rows.get(id) ?? null,
      searchMemories: () => [...rows.values()],
      updateMemory: () => true,
      deleteMemory: (id) => rows.delete(id),
      getDatabaseStats: () => ({ store_type: 'fake', total_count: rows.size })
    };
    const embedder: TextEmbedder = { dimension: 3, encode: () => [1, 0, 0] };
    const vectorStore: VectorStorePort = {
      addVectors: () => true,
      searchSimilar: () => [
        {
          score: 0.9,
          metadata: { memory_id: 'd1', session_id: 's1', memory_type: 'episodic' }
        }
      ],
      deleteMemories: () => true,
      getCollectionStats: () => ({ store_type: 'fake-vec' })
    };
    const em = new EpisodicMemory(new MemoryConfig(), { docStore, embedder, vectorStore });
    em.add(
      item('d1', 'vector backed episode', {
        memoryType: 'episodic',
        metadata: { session_id: 's1' }
      })
    );
    const hits = em.retrieve('query', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('d1');
    expect(hits[0]!.metadata.vector_score).toBe(0.9);
  });
});

describe('SemanticMemory', () => {
  test('Entity/Relation value objects and frequency updates', () => {
    const entity = new Entity('e1', 'React', 'SKILL', 'library');
    expect(entity.toDict()).toMatchObject({ entity_id: 'e1', name: 'React', frequency: 1 });
    const sm = new SemanticMemory();
    sm.addOrUpdateEntity(entity);
    sm.addOrUpdateEntity(new Entity('e1', 'React', 'SKILL'));
    expect(sm.getEntity('e1')?.frequency).toBe(2);
    sm.addOrUpdateRelation(new Relation('e1', 'e2', 'USES', 0.9, 'evidence'));
    sm.addOrUpdateRelation(new Relation('e1', 'e2', 'USES', 0.9, 'evidence'));
    const kg = sm.exportKnowledgeGraph();
    expect((kg.graph_stats as Record<string, unknown>).cached_entities).toBe(1);
    expect((kg.graph_stats as Record<string, unknown>).cached_relations).toBe(1);
  });

  test('entity search scores name/type/description with frequency log', () => {
    const sm = new SemanticMemory();
    sm.addOrUpdateEntity(new Entity('a', 'react', 'SKILL'));
    sm.addOrUpdateEntity(new Entity('a', 'react', 'SKILL'));
    sm.addOrUpdateEntity(new Entity('b', 'vue', 'SKILL'));
    expect(sm.searchEntities('react').map((e) => e.entityId)).toEqual(['a']);
  });

  test('add caches memory and offline retrieve is empty without vector/graph backends', () => {
    const sm = new SemanticMemory();
    sm.add(item('s1', 'declarative ui concept', { memoryType: 'semantic' }));
    expect(sm.getAll()).toHaveLength(1);
    expect(sm.getAll()[0]!.metadata.entities).toEqual([]);
    expect(sm.retrieve('ui')).toEqual([]);
    expect(sm.getStats().memory_type).toBe(fixture.memory_type_labels.semantic);
  });

  test('update/remove return true for cached memories (upstream return-value fix)', () => {
    const sm = new SemanticMemory();
    sm.add(item('s1', 'before', { memoryType: 'semantic' }));
    expect(sm.update('s1', 'after')).toBe(true);
    expect(sm.getAll()[0]!.content).toBe('after');
    expect(sm.remove('s1')).toBe(true);
    expect(sm.hasMemory('s1')).toBe(false);
    expect(sm.update('missing')).toBe(false);
  });

  test('forget and clear', () => {
    const sm = new SemanticMemory(new MemoryConfig({ max_capacity: 100 }));
    sm.add(item('low', 'low', { memoryType: 'semantic', importance: 0.05 }));
    sm.add(item('high', 'high', { memoryType: 'semantic', importance: 0.9 }));
    expect(sm.forget('importance_based', 0.1)).toBe(1);
    sm.clear();
    expect(sm.getAll()).toHaveLength(0);
    expect(sm.entities.size).toBe(0);
  });

  test('injected graph store is used by addEntityToGraph and then cached', () => {
    const calls: string[] = [];
    const graphStore: GraphStorePort = {
      addEntity: () => {
        calls.push('entity');
        return true;
      },
      addRelationship: () => true,
      findRelatedEntities: () => [],
      searchEntitiesByName: () => [],
      getEntityRelationships: () => [],
      getStats: () => ({ total_nodes: 1, total_relationships: 0 }),
      clearAll: () => true
    };
    const sm = new SemanticMemory(new MemoryConfig(), { graphStore });
    sm.addEntityToGraph(
      new Entity('g1', 'GraphQL', 'SKILL'),
      item('m', 'c', { memoryType: 'semantic' })
    );
    expect(calls).toEqual(['entity']);
    expect(sm.getEntity('g1')?.name).toBe('GraphQL');
    expect(Object.keys(sm.getStats())).toEqual(fixture.stats_keys.semantic);
  });

  test('Relation toDict exposes pinned fields', () => {
    const rel = new Relation('a', 'b', 'USES', 1, 'why');
    expect(rel.toDict()).toMatchObject({
      from_entity: 'a',
      to_entity: 'b',
      relation_type: 'USES',
      strength: 1,
      evidence: 'why'
    });
  });
});

describe('PerceptualMemory', () => {
  test('all four modalities are accepted and indexed', () => {
    const pm = new PerceptualMemory();
    for (const [id, modality] of [
      ['t', 'text'],
      ['i', 'image'],
      ['a', 'audio'],
      ['v', 'video']
    ] as const) {
      pm.add(
        item(id, `${modality} content`, {
          memoryType: 'perceptual',
          metadata: { modality, raw_data: `${modality}-raw` }
        })
      );
    }
    expect(pm.getByModality('image').map((m) => m.id)).toEqual(['i']);
    const counts = pm.getStats().modality_counts as Record<string, number>;
    expect(counts).toEqual({ text: 1, image: 1, audio: 1, video: 1 });
  });

  test('unsupported modality throws', () => {
    const pm = new PerceptualMemory();
    expect(() =>
      pm.add(item('x', 'x', { memoryType: 'perceptual', metadata: { modality: 'hologram' } }))
    ).toThrow('不支持的模态类型');
  });

  test('hash encoders are deterministic and same-input vectors coincide', () => {
    const pm = new PerceptualMemory();
    const v1 = pm.encodeData(new Uint8Array([1, 2, 3]), 'image');
    const v2 = pm.encodeData(new Uint8Array([1, 2, 3]), 'image');
    const v3 = pm.encodeData(new Uint8Array([4, 5, 6]), 'image');
    expect(v1).toEqual(v2);
    expect(v1).not.toEqual(v3);
    expect(v1).toHaveLength(384);
    expect(pm.calculateSimilarity(v1, v1)).toBeCloseTo(1, 6);
  });

  test('keyword fallback, cross-modal search and content generation', () => {
    const pm = new PerceptualMemory();
    pm.add(
      item('m1', 'kitten photo', {
        memoryType: 'perceptual',
        metadata: { modality: 'image', raw_data: 'bytes' }
      })
    );
    expect(pm.crossModalSearch('kitten', 'text', 'image').map((m) => m.id)).toEqual(['m1']);
    expect(pm.generateContent('kitten', 'text')).toContain('kitten photo');
    expect(pm.generateContent('kitten', 'hologram')).toBeNull();
  });

  test('update/remove/clear', () => {
    const pm = new PerceptualMemory();
    pm.add(
      item('m1', 'before', {
        memoryType: 'perceptual',
        metadata: { modality: 'text', raw_data: 'raw' }
      })
    );
    expect(pm.update('m1', 'after', 0.9)).toBe(true);
    expect(pm.getAll()[0]!.content).toBe('after');
    expect(pm.remove('m1')).toBe(true);
    expect(pm.getByModality('text')).toHaveLength(0);
    pm.add(
      item('m2', 'again', {
        memoryType: 'perceptual',
        metadata: { modality: 'text', raw_data: 'raw2' }
      })
    );
    pm.clear();
    expect(pm.getAll()).toHaveLength(0);
    expect(pm.perceptions.size).toBe(0);
  });

  test('remove/clear also delete vectors written to the fallback vectorStore', () => {
    // add()/update() write via getVectorStoreForModality(), which falls back to
    // the shared backends.vectorStore when no per-modality stores are injected.
    // remove()/clear() must clean that fallback too, or vectors leak (upstream
    // never has this gap because it always holds fixed text/image/audio stores).
    const deleted: string[][] = [];
    const vectorStore: VectorStorePort = {
      addVectors: () => true,
      searchSimilar: () => [],
      deleteMemories: (ids) => {
        deleted.push([...ids]);
        return true;
      },
      getCollectionStats: () => ({ store_type: 'fake-vec' })
    };
    const rows = new Map<string, StoredMemoryDoc>();
    const docStore: DocumentStorePort = {
      addMemory: (doc) => rows.set(doc.memory_id, doc),
      getMemory: (id) => rows.get(id) ?? null,
      searchMemories: () => [...rows.values()],
      updateMemory: () => true,
      deleteMemory: (id) => rows.delete(id),
      getDatabaseStats: () => ({ store_type: 'fake', total_count: rows.size })
    };
    const pm = new PerceptualMemory(new MemoryConfig(), { vectorStore, docStore });

    pm.add(
      item('m1', 'v', {
        memoryType: 'perceptual',
        metadata: { modality: 'image', raw_data: 'bytes' }
      })
    );
    expect(pm.remove('m1')).toBe(true);
    expect(deleted.flat()).toContain('m1');

    deleted.length = 0;
    pm.add(
      item('m2', 'v2', {
        memoryType: 'perceptual',
        metadata: { modality: 'audio', raw_data: 'bytes2' }
      })
    );
    pm.clear();
    expect(deleted.flat()).toContain('m2');
  });

  test('stats expose modality counts and supported modalities', () => {
    const pm = new PerceptualMemory();
    pm.add(
      item('m', 'c', {
        memoryType: 'perceptual',
        metadata: { modality: 'audio', raw_data: 'raw' }
      })
    );
    const stats = pm.getStats();
    expect(Object.keys(stats)).toEqual(fixture.stats_keys.perceptual);
    expect(stats.supported_modalities).toEqual(['text', 'image', 'audio', 'video']);
  });

  test('Perception hashes string and bytes data', () => {
    const fromString = new Perception('p1', 'abc', 'text', [0], {});
    const fromBytes = new Perception('p2', new Uint8Array([97, 98, 99]), 'text', [0], {});
    expect(fromString.dataHash).toBe(fromBytes.dataHash);
  });
});

describe('MemoryManager', () => {
  test('auto classification follows the pinned Chinese keyword rules', () => {
    const manager = new MemoryManager({ enablePerceptual: false });
    const working = manager.addMemory('一条普通的临时记录');
    const episodic = manager.addMemory('我昨天参加了需求评审会议');
    const semantic = manager.addMemory('这是闭包概念的定义');
    const stats = manager.getMemoryStats().memories_by_type as Record<
      string,
      Record<string, unknown>
    >;
    expect(stats.working!.count).toBe(1);
    expect(stats.episodic!.count).toBe(1);
    expect(stats.semantic!.count).toBe(1);
    expect(manager.removeMemory(working)).toBe(true);
    expect(manager.removeMemory(episodic)).toBe(true);
    expect(manager.removeMemory(semantic)).toBe(true);
  });

  test('metadata.type overrides auto classification', () => {
    const manager = new MemoryManager();
    const id = manager.addMemory('普通文本', undefined, undefined, { type: 'episodic' });
    expect(manager.memoryTypes.episodic!.hasMemory(id)).toBe(true);
  });

  test('manager importance applies priority adjustments and clamps', () => {
    const manager = new MemoryManager();
    expect(manager.calculateImportance('短内容', { priority: 'high' })).toBe(
      fixture.importance.manager_priority_high
    );
    expect(manager.calculateImportance('短内容', { priority: 'low' })).toBe(
      fixture.importance.manager_priority_low
    );
  });

  test('cross-type retrieval merges and sorts by importance', () => {
    const manager = new MemoryManager();
    manager.addMemory('alpha working note', 'working', 0.5);
    manager.addMemory('remember alpha episodic event', 'episodic', 0.9);
    const found = manager.retrieveMemories('alpha', ['working', 'episodic'], 10);
    expect(found).toHaveLength(2);
    expect(found[0]!.importance).toBeGreaterThanOrEqual(found[1]!.importance);
  });

  test('consolidation moves high-importance memories and boosts by 10%', () => {
    const manager = new MemoryManager();
    const id = manager.addMemory('important key decision', 'working', 0.8);
    const moved = manager.consolidateMemories('working', 'episodic', 0.7);
    expect(moved).toBe(1);
    expect(manager.memoryTypes.working!.hasMemory(id)).toBe(false);
    expect(manager.memoryTypes.episodic!.hasMemory(id)).toBe(true);
    const movedItem = (manager.memoryTypes.episodic as EpisodicMemory).getAll()[0]!;
    expect(movedItem.importance).toBeCloseTo(0.88, 10);
  });

  test('update/remove scan every enabled type', () => {
    const manager = new MemoryManager();
    const id = manager.addMemory('scan target', 'semantic', 0.6);
    expect(manager.updateMemory(id, 'updated text')).toBe(true);
    expect(manager.removeMemory(id)).toBe(true);
    expect(manager.updateMemory('missing')).toBe(false);
    expect(manager.removeMemory('missing')).toBe(false);
  });

  test('forgetMemories aggregates across types and clearAll resets', () => {
    const manager = new MemoryManager();
    manager.addMemory('low one', 'working', 0.05);
    manager.addMemory('low two', 'episodic', 0.05);
    expect(manager.forgetMemories('importance_based', 0.1)).toBe(2);
    manager.addMemory('x', 'working', 0.5);
    manager.clearAllMemories();
    expect(manager.getMemoryStats().total_memories).toBe(0);
  });

  test('unsupported memory type throws when auto classification is off', () => {
    const manager = new MemoryManager();
    expect(() => manager.addMemory('x', 'quantum', undefined, undefined, false)).toThrow(
      '不支持的记忆类型'
    );
  });

  test('user isolation: two managers keep separate stores', () => {
    const a = new MemoryManager({ userId: 'a' });
    const b = new MemoryManager({ userId: 'b' });
    a.addMemory('shared keyword note', 'working', 0.6);
    b.addMemory('shared keyword note', 'working', 0.6);
    expect(a.retrieveMemories('shared', ['working'])[0]!.userId).toBe('a');
    expect(a.getMemoryStats().user_id as string).toBe('a');
    expect(b.getMemoryStats().total_memories).toBe(1);
  });

  test('manager stats use the pinned shape', () => {
    const manager = new MemoryManager();
    manager.addMemory('x');
    const stats = manager.getMemoryStats();
    expect(Object.keys(stats)).toEqual(fixture.stats_keys.manager);
  });
});

describe('MemoryTool', () => {
  let tool: MemoryTool;
  afterEach(() => tool?.memoryManager.clearAllMemories());

  test('all nine actions execute through the framework', async () => {
    tool = new MemoryTool();
    const added = await tool.execute({
      action: 'add',
      content: '必须记住的关键事项',
      memory_type: 'working',
      importance: 0.9
    });
    expect(added.status).toBe('success');
    expect(added.text.startsWith(fixture.tool.messages.add_prefix)).toBe(true);
    // 展示文案只含 ID 前 8 位，更新/删除按完整 UUID 匹配（与上游一致）。
    const id = (tool.memoryManager.memoryTypes.working as WorkingMemory)
      .getAll()
      .find((m) => m.content === '必须记住的关键事项')!.id;
    // 空查询时工作记忆关键词评分为 0，重要记忆来自情景记忆兜底（与上游一致）。
    await tool.execute({
      action: 'add',
      content: '昨天发生的关键事件记录',
      memory_type: 'episodic',
      importance: 0.9
    });

    const search = await tool.execute({ action: 'search', query: '关键', limit: 5 });
    expect(search.text.startsWith(fixture.tool.messages.search_prefix)).toBe(true);
    expect(search.text).toContain('[工作记忆]');

    const summary = await tool.execute({ action: 'summary' });
    expect(summary.text).toContain('📊 记忆系统摘要');
    expect(summary.text).toContain('⭐ 重要记忆');

    const stats = await tool.execute({ action: 'stats' });
    expect(stats.text).toContain('📈 记忆系统统计');
    expect(stats.text).toContain('总记忆数: 2');

    const update = await tool.execute({ action: 'update', memory_id: id, content: '更新后的内容' });
    expect(update.text).toBe(fixture.tool.messages.updated);
    const remove = await tool.execute({ action: 'remove', memory_id: id });
    expect(remove.text).toBe(fixture.tool.messages.removed);

    tool.addMemory('forgotten candidate', 'working', 0.05);
    const forget = await tool.execute({ action: 'forget', threshold: 0.1 });
    expect(forget.text.startsWith(fixture.tool.messages.forget_prefix)).toBe(true);

    tool.addMemory('consolidate me important', 'working', 0.9);
    const consolidate = await tool.execute({
      action: 'consolidate',
      from_type: 'working',
      to_type: 'episodic',
      importance_threshold: 0.7
    });
    expect(consolidate.text.startsWith(fixture.tool.messages.consolidate_prefix)).toBe(true);
    expect(consolidate.text).toContain('working → episodic');

    const clear = await tool.execute({ action: 'clear_all' });
    expect(clear.text).toBe(fixture.tool.messages.cleared);
  });

  test('validation and unknown actions match the pinned messages', async () => {
    tool = new MemoryTool();
    // 框架层 zod 校验：缺少 action 直接返回 error 响应。
    const invalid = await tool.execute({});
    expect(invalid.status).toBe('error');
    // run 层与上游 validate_parameters 对齐：缺少 action 返回固定文案。
    const internal = (
      tool as unknown as {
        run(input: unknown): Promise<{ text: string }>;
      }
    ).run({});
    expect((await internal).text).toBe(fixture.tool.messages.validation_failed);
    const bad = await tool.execute({ action: 'nope' });
    expect(bad.status).toBe('success');
    expect(bad.text).toContain('不支持的操作');
  });

  test('missing ids and empty searches follow upstream strings', async () => {
    tool = new MemoryTool();
    expect(tool.updateMemory(undefined)).toBe(fixture.tool.messages.update_missing);
    expect(tool.removeMemory(undefined)).toBe(fixture.tool.messages.remove_missing);
    const result = await tool.execute({ action: 'search', query: 'nothing-here' });
    expect(result.text.startsWith(fixture.tool.messages.empty_search_prefix)).toBe(true);
  });

  test('expanded action tools run standalone', async () => {
    tool = new MemoryTool({ expandable: true });
    expect(fixture.tool.expandable_default).toBe(false);
    expect(new MemoryTool().getExpandedTools()).toBeUndefined();
    const expanded = tool.getExpandedTools()!;
    const addTool = expanded.find((t) => t.name === 'memory_add')!;
    const result = await addTool.execute({ content: 'standalone memory content' });
    expect(result.text.startsWith(fixture.tool.messages.add_prefix)).toBe(true);
    const searchTool = expanded.find((t) => t.name === 'memory_search')!;
    expect((await searchTool.execute({ query: 'standalone' })).text).toContain('找到');
    const clearTool = expanded.find((t) => t.name === 'memory_clear')!;
    expect((await clearTool.execute({})).text).toBe(fixture.tool.messages.cleared);
  });

  test('convenience helpers', () => {
    const manager = new MemoryManager();
    tool = new MemoryTool({ memoryManager: manager });
    tool.autoRecordConversation('用户说了一句话', '助手回复');
    tool.addKnowledge('TypeScript 类型系统知识');
    // 两条 working + 一条 semantic。
    expect(manager.getMemoryStats().total_memories).toBe(3);
    expect(tool.conversationCount).toBe(1);
    // 语义知识依赖向量/图后端（#84）；工作记忆关键词兜底可检索。
    expect(tool.getContextForQuery('用户')).toContain('用户说了一句话');
    expect(tool.inferModality('a.png')).toBe('image');
    expect(tool.inferModality('a.m4a')).toBe('audio');
    expect(tool.inferModality('a.txt')).toBe('text');
    expect(typeof tool.consolidateMemories()).toBe('number');
    expect(typeof tool.forgetOldMemories()).toBe('number');
    tool.clearSession();
    expect(tool.currentSessionId).toBeNull();
    expect(tool.conversationCount).toBe(0);
    expect((manager.memoryTypes.working as WorkingMemory).getAll()).toHaveLength(0);
  });

  test('long important conversation is additionally recorded as episodic', () => {
    tool = new MemoryTool();
    const longResponse = '助手'.repeat(60);
    tool.autoRecordConversation('请记住这个要点', longResponse);
    const stats = tool.memoryManager.getMemoryStats().memories_by_type as Record<
      string,
      { count: number }
    >;
    expect(stats.working!.count).toBe(2);
    expect(stats.episodic!.count).toBe(1);
  });

  test('session id is attached to metadata on add', () => {
    tool = new MemoryTool();
    tool.addMemory('session tagged', 'working', 0.5);
    const item = (tool.memoryManager.memoryTypes.working as WorkingMemory).getAll()[0]!;
    expect(item.metadata.session_id).toBe(tool.currentSessionId);
    expect(item.metadata.timestamp).toBeDefined();
  });

  test('perceptual file path injects modality and raw_data metadata', () => {
    tool = new MemoryTool({ memoryTypes: ['working', 'episodic', 'semantic', 'perceptual'] });
    tool.addMemory('截图描述', 'perceptual', 0.6, '/tmp/a.png');
    const pm = tool.memoryManager.memoryTypes.perceptual as PerceptualMemory;
    const stored = pm.getAll()[0]!;
    expect(stored.metadata.modality).toBe('image');
    expect(stored.metadata.raw_data).toBe('/tmp/a.png');
  });
});
