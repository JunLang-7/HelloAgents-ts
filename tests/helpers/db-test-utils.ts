/**
 * 真实服务（Qdrant / Neo4j）集成测试的共享工具（issue #84 验收）。
 * 不包含 .test.ts 后缀，不参与 release-gate 的测试证据扫描。
 */
import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';

const DISABLED = process.env.HELLOAGENTS_DB_INTEGRATION === '0';

/** docker 可用且未被 HELLOAGENTS_DB_INTEGRATION=0 禁用。 */
export function dockerAvailable(): boolean {
  if (DISABLED) return false;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: 'localhost', port });
    socket.setTimeout(1500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function runDocker(args: string[]): void {
  execSync(`docker ${args.join(' ')}`, { stdio: 'ignore', timeout: 180_000 });
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 ${what} 超时`);
}

/** 记录本次测试启动的容器，结束后统一清理。 */
export function trackContainer(name: string): void {
  started.push(name);
}
export function cleanupTrackedContainers(): void {
  for (const name of started) {
    try {
      execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // 容器可能已被外部清理
    }
  }
}
const started: string[] = [];

/** 探测 Qdrant 服务是否健康（/healthz）。 */
export async function qdrantHealthy(): Promise<boolean> {
  try {
    const resp = await fetch('http://localhost:6333/healthz');
    return resp.ok;
  } catch {
    return false;
  }
}

/** 读取 Qdrant 服务版本（http://localhost:6333/）。 */
export async function qdrantVersion(): Promise<string> {
  try {
    const resp = await fetch('http://localhost:6333/');
    const info = (await resp.json()) as { version?: string };
    return info.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 启动 Qdrant 容器（若端口 6333 已被占用则复用现有服务）。 */
export async function ensureQdrant(): Promise<{ version: string }> {
  if (!(await portOpen(6333))) {
    const name = `ha-qdrant-${Date.now().toString(36)}`;
    runDocker(['run', '-d', '--rm', '--name', name, '-p', '6333:6333', 'qdrant/qdrant:latest']);
    trackContainer(name);
    await waitFor(
      async () => (await portOpen(6333)) && (await qdrantHealthy()),
      120_000,
      'Qdrant 服务'
    );
  }
  return { version: await qdrantVersion() };
}

/** 启动 Neo4j 容器（若端口 7687 已被占用则复用现有服务）。 */
export async function ensureNeo4j(): Promise<{ image: string }> {
  if (!(await portOpen(7687))) {
    const name = `ha-neo4j-${Date.now().toString(36)}`;
    runDocker([
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      '7474:7474',
      '-p',
      '7687:7687',
      '-e',
      'NEO4J_AUTH=neo4j/hello-agents-password',
      'neo4j:5.14'
    ]);
    trackContainer(name);
    await waitFor(
      async () => (await portOpen(7687)) && (await neo4jHealthy()),
      180_000,
      'Neo4j 服务'
    );
    return { image: 'neo4j:5.14 (image tag)' };
  }
  try {
    const image = execSync(`docker inspect --format '{{.Config.Image}}' ha-neo4j`, {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    return { image };
  } catch {
    return { image: 'unknown (reused service)' };
  }
}

/** Neo4j 健康探测（healthCheck 需要默认密码，与 ensureNeo4j 保持一致）。 */
export async function neo4jHealthy(): Promise<boolean> {
  try {
    // 延迟导入避免在 docker 不可用时加载驱动
    const { Neo4jGraphStore } = await import('../../hello_agents/memory/storage/index.js');
    return await new Neo4jGraphStore().healthCheck();
  } catch {
    return false;
  }
}
