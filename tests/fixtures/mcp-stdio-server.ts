/**
 * MCP stdio 服务器 fixture（#75 验收②：stdio/transport 边界本地进程验证）。
 *
 * 独立进程运行：由测试 spawn（`process.execPath <本文件>`），通过
 * JSON-RPC 2.0 行协议与客户端互通。仅用于测试，不进构建产物。
 */
import { createExampleServer } from '../../hello_agents/protocols/mcp/server.js';

await createExampleServer().run('stdio');
