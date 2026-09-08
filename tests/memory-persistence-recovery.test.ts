import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EpisodicMemory,
  MemoryConfig,
  MemoryItem,
  PerceptualMemory,
  SQLiteDocumentStore
} from '../hello_agents/memory/index.js';

afterEach(() => {
  SQLiteDocumentStore.resetForTesting();
});

function makeItem(
  id: string,
  content: string,
  memoryType: 'episodic' | 'perceptual',
  userId: string,
  metadata: Record<string, unknown>
): MemoryItem {
  return new MemoryItem({
    id,
    content,
    memoryType,
    userId,
    timestamp: new Date(),
    importance: 0.8,
    metadata
  });
}

describe('memory cache recovery from a reopened SQLiteDocumentStore', () => {
  test('EpisodicMemory restores persisted episodes and keeps user/session filters', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ha-episodic-recovery-')), 'memory.db');
    const firstStore = SQLiteDocumentStore.getInstance(dbPath);
    const first = new EpisodicMemory(new MemoryConfig(), { docStore: firstStore });
    first.add(
      makeItem('e-a-s1', 'alpha project decision', 'episodic', 'user-a', {
        session_id: 'session-1'
      })
    );
    first.add(
      makeItem('e-b-s1', 'alpha project decision', 'episodic', 'user-b', {
        session_id: 'session-1'
      })
    );
    first.add(
      makeItem('e-a-s2', 'alpha project follow-up', 'episodic', 'user-a', {
        session_id: 'session-2'
      })
    );

    // Simulate a process restart: close the old synchronous connection and
    // construct both a fresh store and a fresh memory cache.
    SQLiteDocumentStore.resetForTesting();
    const reopenedStore = SQLiteDocumentStore.getInstance(dbPath);
    const recovered = new EpisodicMemory(new MemoryConfig(), { docStore: reopenedStore });

    expect(recovered.getAll()).toHaveLength(3);
    expect(recovered.retrieve('alpha', 10, { userId: 'user-a', sessionId: 'session-1' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'e-a-s1' })])
    );
    expect(recovered.retrieve('alpha', 10, { userId: 'user-a' }).map((item) => item.id)).toEqual(
      expect.arrayContaining(['e-a-s1', 'e-a-s2'])
    );
    expect(recovered.retrieve('alpha', 10, { userId: 'user-b' }).map((item) => item.id)).toEqual([
      'e-b-s1'
    ]);
  });

  test('PerceptualMemory restores persisted perceptions and keeps user/modality filters', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ha-perceptual-recovery-')), 'memory.db');
    const firstStore = SQLiteDocumentStore.getInstance(dbPath);
    const first = new PerceptualMemory(new MemoryConfig(), { docStore: firstStore });
    first.add(
      makeItem('p-a', 'kitten photo', 'perceptual', 'user-a', {
        modality: 'image',
        raw_data: 'kitten-image-bytes'
      })
    );
    first.add(
      makeItem('p-b', 'kitten photo', 'perceptual', 'user-b', {
        modality: 'image',
        raw_data: 'kitten-image-bytes-2'
      })
    );
    first.add(
      makeItem('p-a-audio', 'kitten sound', 'perceptual', 'user-a', {
        modality: 'audio',
        raw_data: 'kitten-audio-bytes'
      })
    );

    SQLiteDocumentStore.resetForTesting();
    const reopenedStore = SQLiteDocumentStore.getInstance(dbPath);
    const recovered = new PerceptualMemory(new MemoryConfig(), { docStore: reopenedStore });

    expect(recovered.getAll()).toHaveLength(3);
    expect(recovered.getByModality('image').map((item) => item.id)).toEqual(
      expect.arrayContaining(['p-a', 'p-b'])
    );
    expect(recovered.retrieve('kitten', 10, { userId: 'user-a', targetModality: 'image' })).toEqual(
      [expect.objectContaining({ id: 'p-a' })]
    );
    expect(recovered.retrieve('kitten', 10, { userId: 'user-b', targetModality: 'image' })).toEqual(
      [expect.objectContaining({ id: 'p-b' })]
    );
    expect(recovered.retrieve('kitten', 10, { userId: 'user-a', targetModality: 'audio' })).toEqual(
      [expect.objectContaining({ id: 'p-a-audio' })]
    );
  });
});
