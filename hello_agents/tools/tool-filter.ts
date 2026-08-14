/** 自定义过滤器的模式：白名单或黑名单。 */
export type ToolFilterMode = 'whitelist' | 'blacklist';

/** 克隆隔离子代理注册表时选择工具名称。 */
export interface ToolFilter {
  /** 返回此过滤器允许的工具名称子集。 */
  filter(allTools: readonly string[]): string[];
  /** 判断一个工具名称是否允许。 */
  isAllowed(toolName: string): boolean;
}

const readonlyTools = new Set([
  'Read',
  'ReadTool',
  'LS',
  'LSTool',
  'Glob',
  'GlobTool',
  'Grep',
  'GrepTool',
  'Skill',
  'SkillTool'
]);
const dangerousTools = new Set([
  'Bash',
  'BashTool',
  'Terminal',
  'TerminalTool',
  'Execute',
  'ExecuteTool'
]);

/** 允许只读工具以及显式添加的安全工具。 */
export class ReadOnlyFilter implements ToolFilter {
  private readonly allowed: Set<string>;
  public constructor(additionalAllowed: readonly string[] = []) {
    this.allowed = new Set([...readonlyTools, ...additionalAllowed]);
  }
  /** 从注册表名称列表中过滤出只读工具。 */
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  /** 判断指定名称是否属于只读工具。 */
  public isAllowed(toolName: string): boolean {
    return this.allowed.has(toolName);
  }
}

/** 允许除危险命令执行工具之外的全部工具。 */
export class FullAccessFilter implements ToolFilter {
  private readonly denied: Set<string>;
  public constructor(additionalDenied: readonly string[] = []) {
    this.denied = new Set([...dangerousTools, ...additionalDenied]);
  }
  /** 从注册表名称列表中过滤掉危险工具。 */
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  /** 判断指定名称是否未被拒绝。 */
  public isAllowed(toolName: string): boolean {
    return !this.denied.has(toolName);
  }
}

export interface CustomFilterOptions {
  /** 白名单模式下允许的名称。 */
  readonly allowed?: readonly string[];
  /** 黑名单模式下拒绝的名称。 */
  readonly denied?: readonly string[];
  /** 选择模式，默认为白名单。 */
  readonly mode?: ToolFilterMode;
}

/** 可配置的隔离工具注册表允许/拒绝过滤器。 */
export class CustomFilter implements ToolFilter {
  private readonly allowed: Set<string>;
  private readonly denied: Set<string>;
  private readonly mode: ToolFilterMode;
  public constructor(options: CustomFilterOptions = {}) {
    this.mode = options.mode ?? 'whitelist';
    if (this.mode !== 'whitelist' && this.mode !== 'blacklist') {
      throw new Error(`Invalid mode: ${this.mode}. Must be 'whitelist' or 'blacklist'`);
    }
    this.allowed = new Set(options.allowed ?? []);
    this.denied = new Set(options.denied ?? []);
  }
  /** 根据配置的模式过滤注册表名称列表。 */
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  /** 根据配置的允许/拒绝集合判断工具名称。 */
  public isAllowed(toolName: string): boolean {
    return this.mode === 'blacklist' ? !this.denied.has(toolName) : this.allowed.has(toolName);
  }
}
