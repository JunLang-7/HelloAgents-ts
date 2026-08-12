export type ToolFilterMode = 'whitelist' | 'blacklist';

export interface ToolFilter {
  filter(allTools: readonly string[]): string[];
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

export class ReadOnlyFilter implements ToolFilter {
  private readonly allowed: Set<string>;
  public constructor(additionalAllowed: readonly string[] = []) {
    this.allowed = new Set([...readonlyTools, ...additionalAllowed]);
  }
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  public isAllowed(toolName: string): boolean {
    return this.allowed.has(toolName);
  }
}

export class FullAccessFilter implements ToolFilter {
  private readonly denied: Set<string>;
  public constructor(additionalDenied: readonly string[] = []) {
    this.denied = new Set([...dangerousTools, ...additionalDenied]);
  }
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  public isAllowed(toolName: string): boolean {
    return !this.denied.has(toolName);
  }
}

export interface CustomFilterOptions {
  readonly allowed?: readonly string[];
  readonly denied?: readonly string[];
  readonly mode?: ToolFilterMode;
}

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
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  public isAllowed(toolName: string): boolean {
    return this.mode === 'blacklist' ? !this.denied.has(toolName) : this.allowed.has(toolName);
  }
}
