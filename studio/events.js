// events.js: in-process pub/sub, and a server-sent-events stream of it for the studio page.
export function createEvents() {
  const subs = new Set();
  const publish = (type, data) => { for (const fn of subs) fn({ type, data }); };
  const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
  const stream = req => {
    const enc = new TextEncoder();
    let off, ping;
    const body = new ReadableStream({
      start(ctrl) {
        const send = s => { try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); } };
        const cleanup = () => { off?.(); clearInterval(ping); };
        off = subscribe(e => send(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
        ping = setInterval(() => send(': ping\n\n'), 15000);
        req.signal?.addEventListener('abort', () => { cleanup(); try { ctrl.close(); } catch {} });
        send(': connected\n\n');
      },
      cancel() { off?.(); clearInterval(ping); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  };
  return { publish, subscribe, stream };
}
