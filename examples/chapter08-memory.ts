/**
 * Chapter 08：分层记忆系统（对应上游 examples/chapter08_memory_rag.py 的记忆部分）。
 *
 * 运行：bun run examples/chapter08-memory.ts
 * 无需 API Key、Qdrant、Neo4j：工作/情景/感知记忆的内存路径与上游后端不可用时的
 * 兜底路径一致；语义记忆的向量/图检索由 #84 后端注入后等价。末尾 RAG 段仅在
 * `QDRANT_URL` 已配置时运行，且仍需要配置一个 embedding 后端。
 */
import { MemoryTool, RAGTool } from '../hello_agents/tools/index.js';
import {
  Entity,
  EpisodicMemory,
  MemoryConfig,
  MemoryItem,
  MemoryManager,
  PerceptualMemory,
  Relation,
  SemanticMemory,
  WorkingMemory
} from '../hello_agents/memory/index.js';
import { heading } from './_shared.js';

const config = new MemoryConfig();

// ---------------------------------------------------------------------------
// 1. 四种记忆类型
// ---------------------------------------------------------------------------
heading('1. 工作记忆 WorkingMemory：短期上下文、容量与时间衰减');
{
  const working = new WorkingMemory(config);
  working.add(
    new MemoryItem({
      id: 'w1',
      content: 'React Hooks 让函数组件拥有状态管理能力',
      memoryType: 'working',
      userId: 'demo',
      timestamp: new Date(),
      importance: 0.9
    })
  );
  working.add(
    new MemoryItem({
      id: 'w2',
      content: 'useEffect 处理副作用，依赖数组控制执行时机',
      memoryType: 'working',
      userId: 'demo',
      timestamp: new Date(),
      importance: 0.7
    })
  );
  for (const hit of working.retrieve('React Hooks', 3, { userId: 'demo' }))
    console.log(`- [${hit.importance}] ${hit.content}`);
  console.log(working.getContextSummary(200));
}

heading('2. 情景记忆 EpisodicMemory：按会话组织的交互事件');
{
  const episodic = new EpisodicMemory(config);
  episodic.add(
    new MemoryItem({
      id: 'e1',
      content: '昨天和团队讨论了 React 项目架构，决定采用 Hooks 方案',
      memoryType: 'episodic',
      userId: 'demo',
      timestamp: new Date(),
      importance: 0.8,
      metadata: {
        session_id: 'session-001',
        context: { participants: ['Alice', 'Bob'], channel: 'meeting' },
        outcome: '达成一致',
        tags: ['architecture', 'react']
      }
    })
  );
  for (const hit of episodic.retrieve('React 项目', 3))
    console.log(
      `- ${hit.content}（相关性 ${(hit.metadata.relevance_score as number).toFixed(3)}）`
    );
  console.log('行为模式:', episodic.findPatterns(undefined, 1).slice(0, 3));
  console.log(
    '时间线:',
    episodic.getTimeline().map((t) => t.content)
  );
}

heading('3. 语义记忆 SemanticMemory：实体与关系（离线缓存，向量/图检索见 #84）');
{
  const semantic = new SemanticMemory(config);
  semantic.addOrUpdateEntity(new Entity('react', 'React', 'SKILL', '前端 UI 库'));
  semantic.addOrUpdateEntity(new Entity('hooks', 'Hooks', 'CONCEPT', '状态复用机制'));
  semantic.addOrUpdateRelation(new Relation('react', 'hooks', 'PROVIDES', 1, 'React 提供 Hooks'));
  console.log(
    '实体:',
    semantic.searchEntities('react').map((e) => `${e.name}(${e.entityType})`)
  );
  console.log('知识图谱:', JSON.stringify(semantic.exportKnowledgeGraph().graph_stats));
}

heading('4. 感知记忆 PerceptualMemory：多模态内容与确定性哈希编码');
{
  const perceptual = new PerceptualMemory(config);
  perceptual.add(
    new MemoryItem({
      id: 'p1',
      content: '产品架构图',
      memoryType: 'perceptual',
      userId: 'demo',
      timestamp: new Date(),
      importance: 0.7,
      metadata: { modality: 'image', raw_data: new Uint8Array([1, 2, 3, 4]) }
    })
  );
  perceptual.add(
    new MemoryItem({
      id: 'p2',
      content: '需求评审录音',
      memoryType: 'perceptual',
      userId: 'demo',
      timestamp: new Date(),
      importance: 0.6,
      metadata: { modality: 'audio', raw_data: new Uint8Array([5, 6, 7, 8]) }
    })
  );
  console.log(
    '图像记忆:',
    perceptual.getByModality('image').map((m) => m.content)
  );
  console.log(
    '跨模态检索:',
    perceptual.crossModalSearch('架构', 'text', 'image').map((m) => m.id)
  );
  console.log('统计:', perceptual.getStats().modality_counts);
}

// ---------------------------------------------------------------------------
// 5. MemoryManager：自动分类、跨类型检索、整合与遗忘
// ---------------------------------------------------------------------------
heading('5. MemoryManager 统一调度');
{
  const manager = new MemoryManager({ userId: 'demo', enablePerceptual: true });
  manager.addMemory('我昨天参加了 React 技术方案评审'); // 自动判定为 episodic
  manager.addMemory('React Hooks 是函数组件状态复用的核心概念'); // 自动判定为 semantic
  manager.addMemory('临时记录：下午三点开会'); // working
  const stats = manager.getMemoryStats();
  console.log(
    '各类型计数:',
    Object.fromEntries(
      Object.entries(stats.memories_by_type as Record<string, { count: number }>).map(
        ([type, s]) => [type, s.count]
      )
    )
  );
  console.log('跨类型检索 React:', manager.retrieveMemories('React').length, '条');
  const moved = manager.consolidateMemories('working', 'episodic', 0.0);
  console.log(`整合 ${moved} 条工作记忆到情景记忆`);
  console.log(`按重要性遗忘 ${manager.forgetMemories('importance_based', 0.95)} 条`);
}

// ---------------------------------------------------------------------------
// 6. MemoryTool：Agent 可调用的九种 action
// ---------------------------------------------------------------------------
heading('6. MemoryTool 工具化使用');
{
  const tool = new MemoryTool({ userId: 'demo', expandable: true });
  console.log(
    (
      await tool.execute({
        action: 'add',
        content: '必须注意：生产环境部署前要跑完整测试，这是关键流程',
        memory_type: 'working'
      })
    ).text
  );
  console.log(
    (
      await tool.execute({
        action: 'add',
        content: 'TypeScript 严格模式的概念定义',
        memory_type: 'semantic'
      })
    ).text
  );
  console.log((await tool.execute({ action: 'search', query: '测试', limit: 3 })).text);
  console.log((await tool.execute({ action: 'summary' })).text);
  console.log('独立展开工具:', (tool.getExpandedTools() ?? []).map((t) => t.name).join(', '));
  console.log(
    (await tool.execute({ action: 'consolidate', from_type: 'working', to_type: 'episodic' })).text
  );
  console.log((await tool.execute({ action: 'clear_all' })).text);
}

// ---------------------------------------------------------------------------
// 7. RAGTool：加载、检索与带引用问答（需要显式配置 Qdrant/embedding）
// ---------------------------------------------------------------------------
heading('7. RAGTool：本地文档加载与带引用检索');
if (!process.env.QDRANT_URL) {
  console.log('跳过：设置 QDRANT_URL 和 embedding 配置后可运行本节。');
} else {
  const rag = new RAGTool({
    qdrantUrl: process.env.QDRANT_URL,
    ragNamespace: 'chapter08'
  });
  console.log(
    (
      await rag.execute({
        action: 'add_text',
        text: 'HelloAgents 的 RAG 流程将文档切分、向量索引并按引用返回检索结果。',
        document_id: 'chapter08-rag'
      })
    ).text
  );
  console.log(
    (
      await rag.execute({
        action: 'search',
        query: 'RAG 流程如何返回结果？',
        include_citations: true
      })
    ).text
  );
}
