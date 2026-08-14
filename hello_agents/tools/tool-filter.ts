/** Whether a custom filter includes only allowed names or excludes denied names. */
export type ToolFilterMode = 'whitelist' | 'blacklist';

/** Selects tool names when cloning an isolated subagent registry. */
export interface ToolFilter {
  /** Returns the subset of names permitted by this filter. */
  filter(allTools: readonly string[]): string[];
  /** Tests one tool name against the filter. */
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

/** Allows read-oriented tools plus explicitly added safe tools. */
export class ReadOnlyFilter implements ToolFilter {
  private readonly allowed: Set<string>;
  public constructor(additionalAllowed: readonly string[] = []) {
    this.allowed = new Set([...readonlyTools, ...additionalAllowed]);
  }
  /** Filters a registry name list to read-only tools. */
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  /** Reports whether one name is considered read-only. */
  public isAllowed(toolName: string): boolean {
    return this.allowed.has(toolName);
  }
}

/** Allows all tools except dangerous command-execution names. */
export class FullAccessFilter implements ToolFilter {
  private readonly denied: Set<string>;
  public constructor(additionalDenied: readonly string[] = []) {
    this.denied = new Set([...dangerousTools, ...additionalDenied]);
  }
  /** Filters a registry name list to non-dangerous tools. */
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  /** Reports whether one name is not denied. */
  public isAllowed(toolName: string): boolean {
    return !this.denied.has(toolName);
  }
}

export interface CustomFilterOptions {
  /** Names allowed in whitelist mode. */
  readonly allowed?: readonly string[];
  /** Names denied in blacklist mode. */
  readonly denied?: readonly string[];
  /** Selection strategy; defaults to whitelist. */
  readonly mode?: ToolFilterMode;
}

/** Configurable allow/deny filter for isolated tool registries. */
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
  /** Filters a registry name list according to the configured mode. */
  public filter(allTools: readonly string[]): string[] {
    return allTools.filter((name) => this.isAllowed(name));
  }
  /** Tests a name against the configured allow/deny sets. */
  public isAllowed(toolName: string): boolean {
    return this.mode === 'blacklist' ? !this.denied.has(toolName) : this.allowed.has(toolName);
  }
}
