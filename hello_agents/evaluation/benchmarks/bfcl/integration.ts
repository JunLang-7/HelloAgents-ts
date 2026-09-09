/**
 * BFCL 官方评估工具集成模块（对齐上游 `evaluation/benchmarks/bfcl/bfcl_integration.py`）。
 *
 * 封装 BFCL 官方评估 CLI（`bfcl`）的调用：安装检查、安装、结果文件准备、
 * 运行评估与结果解析。CLI 二进制可通过 `HELLOAGENTS_BFCL_BIN` 覆盖（默认
 * `bfcl`），用于测试与真实命令的显式验证。
 *
 * 上游对 `bfcl` 命令没有版本校验；TS 端新增 `parseVersion`/版本范围检查，
 * 使"支持版本"可显式验证（见 DIFF-045）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/** BFCL CLI 支持的最低版本（`bfcl --version` 输出的 semver）。 */
export const BFCL_MIN_VERSION = '0.4.0';

export interface BFCLIntegrationOptions {
  /** BFCL 项目根目录（默认当前工作目录）。 */
  projectRoot?: string;
  /** BFCL CLI 二进制路径（默认 `bfcl`；可用 HELLOAGENTS_BFCL_BIN 覆盖）。 */
  bin?: string;
}

/** 从 `bfcl --version` 输出解析版本号（支持 `bfcl, version 0.5.1` 等格式）。 */
export function parseBfclVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match ? (match[1] ?? null) : null;
}

/** 比较 semver（a >= b）。 */
export function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return true;
}

export class BFCLIntegration {
  public readonly projectRoot: string;
  public readonly resultDir: string;
  public readonly scoreDir: string;
  public readonly bin: string;

  public constructor(options: BFCLIntegrationOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.resultDir = join(this.projectRoot, 'result');
    this.scoreDir = join(this.projectRoot, 'score');
    this.bin = options.bin ?? process.env.HELLOAGENTS_BFCL_BIN ?? 'bfcl';
  }

  /** 检查 BFCL 评估工具是否已安装（`bfcl --version`）。 */
  public isInstalled(): boolean {
    try {
      const result = this.spawn([this.bin, '--version'], 5_000);
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /** 获取已安装的 BFCL 版本；未安装返回 null。 */
  public getVersion(): string | null {
    try {
      const result = this.spawn([this.bin, '--version'], 5_000);
      if (result.status !== 0) return null;
      return parseBfclVersion(result.stdout.toString());
    } catch {
      return null;
    }
  }

  /** 检查已安装版本是否满足最低版本要求；未安装返回 false。 */
  public isVersionSupported(): boolean {
    const version = this.getVersion();
    return version !== null && semverGte(version, BFCL_MIN_VERSION);
  }

  /** 安装 BFCL 评估工具（`pip install bfcl-eval`）。 */
  public install(): boolean {
    console.log('📦 正在安装BFCL评估工具...');
    console.log('   运行: pip install bfcl-eval');
    try {
      const result = this.spawn(['pip', 'install', 'bfcl-eval'], 300_000);
      if (result.status === 0) {
        console.log('✅ BFCL评估工具安装成功');
        return true;
      }
      console.log(`❌ 安装失败: ${result.stderr.toString()}`);
      return false;
    } catch (error) {
      console.log(`❌ 安装出错: ${String(error)}`);
      return false;
    }
  }

  /** 准备 BFCL 评估所需的结果文件（复制到 result/{model}/BFCL_v3_{category}_result.json）。 */
  public prepareResultFile(sourceFile: string, modelName: string, category: string): string {
    const targetDir = join(this.resultDir, modelName);
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, `BFCL_v3_${category}_result.json`);
    if (existsSync(sourceFile)) {
      copyFileSync(sourceFile, targetFile);
      console.log('✅ 结果文件已准备');
      console.log(`   源文件: ${sourceFile}`);
      console.log(`   目标文件: ${targetFile}`);
    } else {
      console.log(`⚠️ 源文件不存在: ${sourceFile}`);
    }
    return targetFile;
  }

  /** 运行 BFCL 官方评估（`bfcl evaluate --model ... --test-category ...`）。 */
  public runEvaluation(modelName: string, category: string, resultFile?: string): boolean {
    if (resultFile) this.prepareResultFile(resultFile, modelName, category);
    const env = { ...process.env, BFCL_PROJECT_ROOT: this.projectRoot };
    console.log(`\n🔧 运行BFCL官方评估...`);
    console.log(`   模型: ${modelName}`);
    console.log(`   类别: ${category}`);
    console.log(`   项目根目录: ${this.projectRoot}`);
    const cmd = ['evaluate', '--model', modelName, '--test-category', category];
    console.log(`   命令: ${this.bin} ${cmd.join(' ')}`);
    try {
      const result = this.spawn([this.bin, ...cmd], 600_000, env);
      if (result.status === 0) {
        console.log('✅ BFCL评估完成');
        console.log(result.stdout.toString());
        return true;
      }
      console.log('❌ 评估失败');
      console.log(`   错误信息: ${result.stderr.toString()}`);
      return false;
    } catch (error) {
      console.log(`❌ 评估出错: ${String(error)}`);
      return false;
    }
  }

  /** 解析 BFCL 评估结果（score/{model}/BFCL_v3_{category}_score.json）。 */
  public parseResults(modelName: string, category: string): unknown {
    const scoreFile = join(this.scoreDir, modelName, `BFCL_v3_${category}_score.json`);
    if (!existsSync(scoreFile)) {
      console.log(`⚠️ 评估结果文件不存在: ${scoreFile}`);
      return null;
    }
    try {
      const results: unknown = JSON.parse(readFileSync(scoreFile, 'utf8'));
      console.log(`\n📊 BFCL评估结果`);
      console.log(`   模型: ${modelName}`);
      console.log(`   类别: ${category}`);
      if (results !== null && typeof results === 'object' && !Array.isArray(results)) {
        for (const [key, value] of Object.entries(results as Record<string, unknown>)) {
          if (typeof value === 'number') console.log(`   ${key}: ${value}`);
        }
      }
      return results;
    } catch (error) {
      console.log(`❌ 解析结果失败: ${String(error)}`);
      return null;
    }
  }

  /** 获取汇总 CSV 文件路径（score/data_overall.csv）。 */
  public getSummaryCsv(): string | null {
    const csvFile = join(this.scoreDir, 'data_overall.csv');
    if (existsSync(csvFile)) {
      console.log(`\n📄 汇总CSV文件: ${csvFile}`);
      return csvFile;
    }
    console.log(`⚠️ 汇总CSV文件不存在: ${csvFile}`);
    return null;
  }

  /** 打印使用指南。 */
  public printUsageGuide(): void {
    console.log('\n' + '='.repeat(60));
    console.log('BFCL官方评估工具使用指南');
    console.log('='.repeat(60));
    console.log('\n1. 安装BFCL评估工具：');
    console.log('   pip install bfcl-eval');
    console.log('\n2. 设置环境变量：');
    console.log(`   export BFCL_PROJECT_ROOT=${this.projectRoot}`);
    console.log('\n3. 准备结果文件：');
    console.log('   将评估结果放在: result/{model_name}/BFCL_v3_{category}_result.json');
    console.log('\n4. 运行评估：');
    console.log('   bfcl evaluate --model {model_name} --test-category {category}');
    console.log('\n5. 查看结果：');
    console.log('   评估结果在: score/{model_name}/BFCL_v3_{category}_score.json');
    console.log('   汇总结果在: score/data_overall.csv');
    console.log('\n' + '='.repeat(60));
  }

  private spawn(
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = process.env
  ): SpawnSyncReturns<Buffer> {
    const result = spawnSync(args[0]!, args.slice(1), {
      encoding: 'buffer',
      timeout: timeoutMs,
      env
    });
    if (result.error) throw result.error;
    return result;
  }
}
