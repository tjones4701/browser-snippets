export function safePath(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 400 || input.startsWith('/') || /[\\:]/.test(input)) {
    throw new Error('Use a relative path with / between folders (maximum 400 characters).');
  }
  return input.split('/').map(segment => {
    if (!segment || segment === '.' || segment === '..') throw new Error('Empty folders and . or .. segments are not allowed.');
    let safe = segment.replace(/[<>"|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
    if (!safe) throw new Error('A filename or folder is empty after sanitising.');
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
    if (safe.length > 120) throw new Error('Each filename or folder must be at most 120 characters.');
    return safe;
  }).join('/');
}
export function downloadPath(name: string, snippetId: string, startedAt: string, runId: string, path: string): string {
  const folder = name.replace(/[\\/:<>"|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 70) || 'Snippet';
  return safePath(`Browser Code Snippets/${folder}_${snippetId.slice(0, 8)}/${startedAt.replace(/[:.]/g, '-')}_${runId.slice(0, 8)}/${path}`);
}
