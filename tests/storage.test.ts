import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, deleteSnippet, patchRun, saveArtifact } from '../src/store';
import { downloadPath, safePath } from '../src/paths';
import type { Run } from '../src/types';

const activeRun = (id = 'run-1'): Run => ({ id, snippetId: 'snippet-1', snippetName: 'Test', sourceSnapshot: '', token: 'test-token', pageUrl: 'https://example.com', tabId: 1, startedAt: '2026-10-29T00:00:00.000Z', heartbeat: Date.now(), status: 'running', stopRequested: false, logs: [], reason: '' });
beforeEach(async () => {
  const database = await db;
  await Promise.all([database.clear('snippets'), database.clear('runs'), database.clear('artifacts')]);
  await database.put('runs', activeRun());
});
describe('artifact paths', () => {
  it.each(['/etc/passwd', '../secrets', 'a/../b', 'a/./b', 'C:/file', 'a\\file', 'a//file', 'a/', ''])('rejects unsafe path %s', path => {
    expect(() => safePath(path)).toThrow();
  });
  it('sanitises reserved names and invalid filename characters', () => {
    expect(safePath('reports/CON.txt')).toBe('reports/_CON.txt');
    expect(safePath('reports/question?.json')).toBe('reports/question-.json');
  });
  it('puts downloads in a unique snippet and run folder', () => {
    const path = downloadPath('My:snippet', 'abcdefghi', '2026-10-29T00:00:00.000Z', '123456789', 'a/b.txt');
    expect(path).toContain('My-snippet_abcdefgh/2026-10-29T00-00-00-000Z_12345678/a/b.txt');
  });
});
describe('durable artifact storage', () => {
  it('commits files, rejects accidental replacement, and retains IDs for checkpoints', async () => {
    const first = await saveArtifact('run-1', { path: 'chat/messages.json', content: '[]', mimeType: 'application/json' });
    await expect(saveArtifact('run-1', { path: first.path, content: 'new' })).rejects.toThrow('already exists');
    const second = await saveArtifact('run-1', { path: first.path, content: 'updated', overwrite: true });
    expect(second.id).toBe(first.id);
    expect((await (await db).getAll('artifacts')).map(artifact => artifact.content)).toEqual(['updated']);
  });
  it('isolates identical paths across runs', async () => {
    await (await db).put('runs', activeRun('run-2'));
    await saveArtifact('run-1', { path: 'output.txt', content: 'first' });
    await saveArtifact('run-2', { path: 'output.txt', content: 'second' });
    expect(await (await db).count('artifacts')).toBe(2);
  });
  it('serialises concurrent saves to the same path', async () => {
    const results = await Promise.allSettled([saveArtifact('run-1', { path: 'output.txt', content: 'one' }), saveArtifact('run-1', { path: 'output.txt', content: 'two' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await (await db).count('artifacts')).toBe(1);
  });
  it('rejects writes after interruption and keeps existing checkpoints', async () => {
    await saveArtifact('run-1', { path: 'checkpoint.json', content: 'saved' });
    await patchRun('run-1', run => { run.status = 'interrupted'; });
    await expect(saveArtifact('run-1', { path: 'checkpoint.json', content: 'lost', overwrite: true })).rejects.toThrow('no longer active');
    expect((await (await db).getAll('artifacts'))[0].content).toBe('saved');
  });
  it('stores unicode and binary accurately and reports adjusted paths', async () => {
    expect((await saveArtifact('run-1', { path: 'hello?.txt', content: '🙂' })).sizeBytes).toBe(4);
    const binary = await saveArtifact('run-1', { path: 'file.bin', content: btoa('\u0000\u00ff'), encoding: 'base64', mimeType: 'application/octet-stream' });
    expect(binary.sizeBytes).toBe(2);
    expect((await (await db).getAll('artifacts')).some(artifact => artifact.path === 'hello-.txt')).toBe(true);
  });
  it('rejects oversized artifacts before saving', async () => {
    await expect(saveArtifact('run-1', { path: 'big.txt', content: 'a'.repeat(8 * 1024 * 1024 + 1) })).rejects.toThrow('8 MiB');
    expect(await (await db).count('artifacts')).toBe(0);
  });
  it('preserves history on edits and blocks deletion while running', async () => {
    const snippet = { id: 'snippet-1', name: 'Original', source: 'code', site: '', description: '', updatedAt: '' };
    await (await db).put('snippets', snippet);
    await saveArtifact('run-1', { path: 'saved.txt', content: 'saved' });
    await (await db).put('snippets', { ...snippet, name: 'Renamed', source: 'new code' });
    expect(await (await db).count('artifacts')).toBe(1);
    await expect(deleteSnippet('snippet-1')).rejects.toThrow('Stop active runs');
    await patchRun('run-1', run => { run.status = 'completed'; });
    await deleteSnippet('snippet-1');
    expect(await (await db).count('artifacts')).toBe(0);
    expect(await (await db).count('runs')).toBe(0);
  });
});
