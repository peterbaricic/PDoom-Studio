// events.js: in-process pub/sub, and a server-sent-events stream of it for the studio page. onStreams(fn) calls fn with
// the number of open streams whenever it changes: none open means no studio page is watching (studio/frames/service.js
// stops painting ahead then). Every stream opens with a `hello` naming this server run (boot): a page whose stream
// came back from another run knows at once that the studio restarted (studio/web/src/api/events.ts).
export function createEvents() {
  const boot = crypto.randomUUID();
  const subs = new Set(), streamWatchers = new Set();
  let streams = 0;
  const publish = (type, data) => { for (const fn of subs) fn({ type, data }); };
  const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
  const onStreams = fn => { streamWatchers.add(fn); return () => streamWatchers.delete(fn); };
  const counted = delta => { streams += delta; for (const fn of streamWatchers) fn(streams); };
  const stream = req => {
    const enc = new TextEncoder();
    let off, ping, open = false;
    const cleanup = () => {
      off?.(); clearInterval(ping);
      if (open) { open = false; counted(-1); }
    };
    const body = new ReadableStream({
      start(ctrl) {
        const send = s => { try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); } };
        off = subscribe(e => send(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
        ping = setInterval(() => send(': ping\n\n'), 15000);
        req.signal?.addEventListener('abort', () => { cleanup(); try { ctrl.close(); } catch {} });
        open = true; counted(1);
        if (req.signal?.aborted) { cleanup(); try { ctrl.close(); } catch {} return; }
        send(`: connected\n\nevent: hello\ndata: ${JSON.stringify({ boot })}\n\n`);
      },
      cancel() { cleanup(); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  };
  return { publish, subscribe, stream, onStreams, streamCount: () => streams };
}
