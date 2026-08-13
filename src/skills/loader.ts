import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { SkillError, parseOrThrow } from '../core/errors.js';

const metadataSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    license: z.string().optional(),
    version: z.string().optional()
  })
  .strict();
export type SkillMetadata = z.output<typeof metadataSchema>;

export interface SkillResources {
  readonly scripts: readonly string[];
  readonly examples: readonly string[];
  readonly references: readonly string[];
  readonly assets: readonly string[];
}

export interface Skill extends SkillMetadata {
  readonly body: string;
  readonly path: string;
  readonly dir: string;
  readonly resources: SkillResources;
}

export interface SkillLoaderOptions {
  readonly skillsDir?: string;
}

type CachedMetadata = SkillMetadata & { readonly path: string; readonly dir: string };

function parseScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'");
  return /^[^#\n]+$/.test(trimmed) ? trimmed.trim() : undefined;
}

function splitSkillDocument(content: string): { frontmatter: string; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/u.exec(content);
  if (!match) throw new SkillError('Invalid SKILL.md frontmatter');
  return { frontmatter: match[1] ?? '', body: (match[2] ?? '').trim() };
}

function parseFrontmatter(content: string): SkillMetadata {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!match) throw new SkillError('Invalid SKILL.md frontmatter');
    const key = match[1] ?? '';
    const value = parseScalar(match[2] ?? '');
    if (value === undefined || !['name', 'description', 'license', 'version'].includes(key)) {
      throw new SkillError('Invalid SKILL.md frontmatter');
    }
    values[key] = value;
  }
  const parsed = parseOrThrow(metadataSchema, values, 'Skill frontmatter', SkillError);
  return { name: parsed.name, description: parsed.description };
}

async function collectFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const output: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) output.push(...(await collectFiles(path)));
      else if (entry.isFile()) output.push(path);
    }
    return output;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}

async function resources(dir: string): Promise<SkillResources> {
  return {
    scripts: await collectFiles(join(dir, 'scripts')),
    examples: await collectFiles(join(dir, 'examples')),
    references: await collectFiles(join(dir, 'references')),
    assets: await collectFiles(join(dir, 'assets'))
  };
}

/** Progressive skill discovery: scan frontmatter first and load full bodies only on demand. */
export class SkillLoader {
  public readonly skillsDir: string;
  private metadata = new Map<string, CachedMetadata>();
  private cache = new Map<string, Skill>();
  private order: string[] = [];

  private constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  public static async create(options: SkillLoaderOptions = {}): Promise<SkillLoader> {
    const loader = new SkillLoader(options.skillsDir ?? '.');
    await loader.reload();
    return loader;
  }

  public listSkills(): readonly string[] {
    return [...this.order];
  }

  public getDescriptions(): string {
    return this.order.length === 0
      ? '（暂无可用技能）'
      : this.order
          .map((name) => `- ${name}: ${this.metadata.get(name)?.description ?? ''}`)
          .join('\n');
  }

  public getCachedSkill(name: string): Skill | undefined {
    return this.cache.get(name);
  }

  public async getSkill(name: string): Promise<Skill | undefined> {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const metadata = this.metadata.get(name);
    if (!metadata) return undefined;
    try {
      const document = splitSkillDocument(await readFile(metadata.path, 'utf8'));
      const parsed = parseFrontmatter(document.frontmatter);
      const skill: Skill = {
        name: parsed.name || name,
        description: parsed.description,
        body: document.body,
        path: metadata.path,
        dir: metadata.dir,
        resources: await resources(metadata.dir)
      };
      this.cache.set(name, skill);
      return skill;
    } catch (error) {
      if (error instanceof SkillError) throw error;
      throw new SkillError(`Failed to load skill '${name}'`, error);
    }
  }

  public async reload(): Promise<void> {
    const metadata = new Map<string, CachedMetadata>();
    const order: string[] = [];
    try {
      const entries = await readdir(this.skillsDir, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue;
        const dir = join(this.skillsDir, entry.name);
        const path = join(dir, 'SKILL.md');
        let document: { frontmatter: string; body: string };
        try {
          document = splitSkillDocument(await readFile(path, 'utf8'));
        } catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') continue;
          if (error instanceof SkillError) throw error;
          throw new SkillError(`Failed to read skill '${entry.name}'`, error);
        }
        const parsed = parseFrontmatter(document.frontmatter);
        const name = parsed.name;
        if (metadata.has(name)) throw new SkillError(`Duplicate skill name: ${name}`);
        metadata.set(name, { name, description: parsed.description, path, dir });
        order.push(name);
      }
    } catch (error) {
      if (error instanceof SkillError) throw error;
      if ((error as { code?: string }).code === 'ENOENT') {
        this.metadata = metadata;
        this.cache.clear();
        this.order = order;
        return;
      }
      throw new SkillError('Failed to scan skills directory', error);
    }
    this.metadata = metadata;
    this.cache.clear();
    this.order = order;
  }
}
