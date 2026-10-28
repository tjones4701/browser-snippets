export interface Snippet {
  id: string;
  name: string;
  description: string;
  source: string;
  site: string;
  updatedAt: string;
}
export type RunStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface Run {
  id: string;
  snippetId: string;
  snippetName: string;
  sourceSnapshot: string;
  pageUrl: string;
  tabId: number;
  documentId?: string;
  token: string;
  startedAt: string;
  finishedAt?: string;
  heartbeat: number;
  status: RunStatus;
  stopRequested: boolean;
  reason: string;
  logs: string[];
  progress?: { current: number; total?: number; message: string };
}
export interface Artifact {
  id: string;
  runId: string;
  path: string;
  mimeType: string;
  content: string;
  encoding: 'utf8' | 'base64';
  sizeBytes: number;
  createdAt: string;
  downloadId?: number;
  downloadState?: string;
}
export interface SaveFile {
  path: string;
  content: string;
  mimeType?: string;
  encoding?: 'utf8' | 'base64';
  overwrite?: boolean;
}
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
