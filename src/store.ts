import { openDB, type DBSchema } from 'idb';
import type { Artifact, Run, Snippet, SaveFile } from './types';
import { safePath } from './paths';

interface Schema extends DBSchema {
  snippets: { key: string; value: Snippet };
  runs: { key: string; value: Run };
  artifacts: { key: string; value: Artifact; indexes: { 'run-path': [string, string] } };
}
export const db = openDB<Schema>('browser-code-snippets', 1, {
  upgrade(database) {
    database.createObjectStore('snippets', { keyPath: 'id' });
    database.createObjectStore('runs', { keyPath: 'id' });
    const artifacts = database.createObjectStore('artifacts', { keyPath: 'id' });
    artifacts.createIndex('run-path', ['runId', 'path'], { unique: true });
  },
});

export async function patchRun(id: string, update: (run: Run) => void): Promise<Run> {
  const database = await db;
  const tx = database.transaction('runs', 'readwrite');
  const run = await tx.store.get(id);
  if (!run) throw new Error('Run not found.');
  update(run);
  await tx.store.put(run);
  await tx.done;
  return run;
}

export async function saveArtifact(runId: string, file: SaveFile): Promise<Artifact> {
  const path = safePath(file.path);
  if (typeof file.content !== 'string') throw new Error('File content must be text or encoded binary.');
  if (file.encoding && file.encoding !== 'base64' && file.encoding !== 'utf8') throw new Error('Unsupported encoding.');
  const encoding = file.encoding || 'utf8';
  if (file.content.length > 12 * 1024 * 1024) throw new Error('Artifacts must be at most 8 MiB.');
  const sizeBytes = encoding === 'base64' ? atob(file.content).length : new TextEncoder().encode(file.content).length;
  if (sizeBytes > 8 * 1024 * 1024) throw new Error('Artifacts must be at most 8 MiB.');
  const mimeType = file.mimeType || 'text/plain';
  if (!/^[\w.+-]+\/[\w.+-]+(?:;[\w =.+-]+)?$/.test(mimeType)) throw new Error('Invalid MIME type.');
  const database = await db;
  const tx = database.transaction(['runs', 'artifacts'], 'readwrite');
  const run = await tx.objectStore('runs').get(runId);
  if (!run || run.status !== 'running') throw new Error('This run is no longer active.');
  const store = tx.objectStore('artifacts');
  const previous = await store.index('run-path').get([runId, path]);
  if (previous && file.overwrite !== true) throw new Error(`Artifact already exists: ${path}. Use overwrite: true to replace it.`);
  const artifact: Artifact = {
    id: previous?.id || crypto.randomUUID(), runId, path, mimeType, content: file.content, encoding, sizeBytes,
    createdAt: new Date().toISOString(),
  };
  await store.put(artifact);
  await tx.done;
  return artifact;
}

export async function deleteSnippet(id: string): Promise<void> {
  const database = await db;
  const tx = database.transaction(['snippets', 'runs', 'artifacts'], 'readwrite');
  const runs = (await tx.objectStore('runs').getAll()).filter(run => run.snippetId === id);
  if (runs.some(run => run.status === 'running')) throw new Error('Stop active runs before deleting this snippet.');
  const ids = new Set(runs.map(run => run.id));
  for (const artifact of await tx.objectStore('artifacts').getAll()) {
    if (ids.has(artifact.runId)) await tx.objectStore('artifacts').delete(artifact.id);
  }
  for (const run of runs) await tx.objectStore('runs').delete(run.id);
  await tx.objectStore('snippets').delete(id);
  await tx.done;
}
