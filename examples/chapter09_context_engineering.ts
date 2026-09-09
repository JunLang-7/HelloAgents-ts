/**
 * Chapter 09：上下文工程（对应上游 examples/chapter09_context_engineering.py）。
 *
 * 上游示例为占位（TODO："此示例将在第8章中详细实现..."），TS 教学版给出
 * 真实可运行的 GSSC（Gather-Select-Structure-Compress）演示：
 *   1. 无工具注入的基础构建
 *   2. 注入真实 MemoryTool（SQLite 持久化）检索任务状态与相关记忆
 *   3. 注入 RAGTool（仅当配置了 QDRANT_URL 时执行真实检索）
 *   4. 四阶段单独调用演示
 *
 * 运行：bun run examples/chapter09_context_engineering.ts
 * 也可在 Node.js 下运行（npx tsx examples/chapter09_context_engineering.ts）。
 * 无需 API Key；RAG 检索段仅在 `QDRANT_URL` 已配置时运行。
 */
import { heading } from './_shared.js';
import {
  ContextBuilder,
  ContextConfig,
  ContextPacket,
  countTokens
} from '../hello_agents/index.js';
import { Message } from '../hello_agents/core/message.js';
import { MemoryTool, RAGTool } from '../hello_agents/tools/index.js';

async function main(): Promise<void> {
  heading('1. 基础构建：无工具注入（Gather 只含指令/历史/额外包）');
  {
    const builder = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ max_tokens: 2000 })
    );
    const context = await builder.build(
      '如何配置上下文预算？',
      [new Message('你好', 'user'), new Message('你好！有什么可以帮你？', 'assistant')],
      '你是 HelloAgents 教学助手，回答请保持简洁。',
      [new ContextPacket('教材：第 8 章讲述上下文工程', undefined, { type: 'tool_result' })]
    );
    console.log(context);
    console.log(`\n（上下文 token 数：${countTokens(context)}）`);
  }

  heading('2. 注入 MemoryTool：任务状态 + 相关记忆（Gather 的 P1 来源）');
  {
    const memoryTool = new MemoryTool();
    // 检索命中依赖子串/词元匹配：整句查询「上下文工程进展如何？」命中第一条记忆，
    // 中文 OR 关键词查询（任务状态…）未命中 → 按上游语义跳过 task_state 来源。
    memoryTool.addMemory('上下文工程进展如何？——来自用户的上一个问题', 'working', 0.5);
    memoryTool.addMemory('任务状态：第 9 章上下文工程已开始，待完成 GSSC 演示', 'working', 0.9);

    // min_relevance=0：展示工具结果纳入；上游默认 0.3 会过滤无关键词重叠的包
    //（中文无空格分词，关键词重叠相关性为 0，英文场景默认 0.3 即可命中）。
    const builder = new ContextBuilder(
      memoryTool,
      undefined,
      new ContextConfig({ min_relevance: 0 })
    );
    const context = await builder.build('上下文工程进展如何？', []);
    console.log(context);
  }

  heading('3. 注入 RAGTool：知识库事实检索（Gather 的 P2 来源，可选）');
  {
    const memoryTool = new MemoryTool();
    const ragTool = new RAGTool();
    const builder = new ContextBuilder(memoryTool, ragTool);
    if (process.env.QDRANT_URL) {
      const context = await builder.build('GraphRAG 是什么？', []);
      console.log(context);
    } else {
      console.log('跳过：未配置 QDRANT_URL（配置后注入真实 RAGTool 检索知识库）');
    }
  }

  heading('4. 四阶段单独调用演示（Gather / Select / Structure / Compress）');
  {
    const builder = new ContextBuilder();
    const packets = await builder._gather('预算', [], '系统指令', [
      new ContextPacket('预算 预留 15%', undefined, { type: 'tool_result' })
    ]);
    const selected = builder._select(packets, '预算');
    const structured = builder._structure(selected, '预算', '系统指令');
    const finalContext = builder._compress(structured);
    console.log(
      `Gather=${packets.length} 包 → Select=${selected.length} 包 → ` +
        `tokens=${countTokens(finalContext)}`
    );
    console.log(finalContext);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
