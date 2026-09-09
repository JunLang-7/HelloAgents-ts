/**
 * Chapter 10 — MCP 协议示例（#75）。
 *
 * 运行：bun run examples/chapter10-mcp.ts
 *
 * 演示：
 * 1. MCP 工具函数（create_context / parse_context）
 * 2. 内存传输：MCPServer 注册工具 → MCPClient 直接调用
 * 3. stdio 传输：子进程 JSON-RPC 2.0 互通
 * 4. MCPTool 协议→工具封装（内置演示服务器）
 */
import { createExampleServer } from '../hello_agents/protocols/mcp/server.js';
import { MCPClient } from '../hello_agents/protocols/mcp/client.js';
import { createContext, parseContext } from '../hello_agents/protocols/mcp/utils.js';
import { MCPTool } from '../hello_agents/tools/builtin/protocol-tools.js';

async function main(): Promise<void> {
  console.log('== MCP 上下文工具 ==');
  const context = createContext([{ role: 'user', content: 'hi' }]);
  console.log(JSON.stringify(parseContext(JSON.stringify(context)), null, 2));

  console.log('\n== 内存传输：MCPServer + MCPClient ==');
  const server = createExampleServer();
  const memoryClient = new MCPClient(server);
  const tools = await memoryClient.listTools();
  console.log(`工具列表: ${tools.map((tool) => tool.name).join(', ')}`);
  console.log('add(2, 3) =', await memoryClient.callTool('add', { a: 2, b: 3 }));
  await memoryClient.close();

  console.log('\n== stdio 传输：子进程 JSON-RPC ==');
  const stdioClient = new MCPClient([process.execPath, 'tests/fixtures/mcp-stdio-server.ts']);
  console.log('greet(name=TS) =', await stdioClient.callTool('greet', { name: 'TS' }));
  await stdioClient.close();

  console.log('\n== MCPTool：协议→工具封装 ==');
  const mcpTool = new MCPTool();
  console.log(await mcpTool.execute({ action: 'list_tools' }));
  console.log(
    await mcpTool.execute({ action: 'call_tool', tool_name: 'multiply', arguments: { a: 6, b: 7 } })
  );
}

void main();
