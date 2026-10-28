// Only this string is executed through userScripts. Extension pages never evaluate pasted code.
export function runnerSource(runId: string, token: string, source: string): string {
  return `void (async () => {
    const runId = ${JSON.stringify(runId)}, token = ${JSON.stringify(token)};
    const controller = new AbortController();
    const send = async (operation, payload) => {
      const reply = await chrome.runtime.sendMessage({ channel: 'runner', runId, token, operation, payload });
      if (!reply?.ok) throw new Error(reply?.error || 'Extension connection lost');
      return reply.value;
    };
    let timer;
    let pollPending = false;
    const pending = new Set();
    let helperError;
    const queue = (operation, payload) => {
      const task = send(operation, payload).catch(error => { helperError = error; }).finally(() => pending.delete(task));
      pending.add(task);
    };
    let outcome;
    try {
      await send('hello');
      timer = setInterval(async () => {
        if (pollPending) return;
        pollPending = true;
        try { if ((await send('heartbeat')).stopRequested) controller.abort(); }
        catch { controller.abort(); }
        finally { pollPending = false; }
      }, 1000);
      const snippet = Object.freeze({
        signal: controller.signal,
        log: value => queue('log', String(value)),
        progress: value => queue('progress', value),
        saveFile: async file => {
          let content = file.content, encoding = 'utf8';
          if (typeof content !== 'string') {
            let bytes;
            if (content instanceof Blob) bytes = new Uint8Array(await content.arrayBuffer());
            else if (content instanceof ArrayBuffer) bytes = new Uint8Array(content);
            else if (ArrayBuffer.isView(content)) bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
            else throw new Error('Use text, Blob, ArrayBuffer, or a typed array for content.');
            if (bytes.length > 8 * 1024 * 1024) throw new Error('Artifacts must be at most 8 MiB.');
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            content = btoa(binary); encoding = 'base64';
          }
          return send('saveFile', { path: file.path, content, encoding, mimeType: file.mimeType, overwrite: file.overwrite });
        },
        downloadFile: id => send('download', { id }),
        setOutcome: async value => { outcome = value; },
      });
      await (async () => {
${source}
      })();
      await Promise.all([...pending]);
      if (helperError) throw helperError;
      await send('finish', { status: controller.signal.aborted ? 'stopped' : outcome?.status || 'completed', reason: outcome?.reason || (controller.signal.aborted ? 'Stopped by user' : '') });
    } catch (error) {
      await Promise.all([...pending]);
      await send('finish', { status: 'failed', reason: String(error?.message || error) }).catch(() => {});
    } finally { clearInterval(timer); }
  })();`;
}
