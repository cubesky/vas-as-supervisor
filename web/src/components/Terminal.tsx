import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from '../api';
import { t } from '../i18n';
import { Badge, Button } from './ui';

/**
 * xterm.js bound to a WebSocket. Input is sent as {t:'i', d}, resizes as
 * {t:'r', c, r}; output arrives as text or binary frames. Used for LXC
 * terminals and the VM web serial console.
 */
export function Terminal({ path, height = 480 }: { path: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0d0f12', foreground: '#d7dae0', cursor: '#c9a227' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const ws = new WebSocket(wsUrl(path));
    ws.binaryType = 'arraybuffer';
    const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    ws.onopen = () => {
      setStatus('online');
      send({ t: 'r', c: term.cols, r: term.rows });
      term.focus();
    };
    ws.onclose = (e) => {
      setStatus('offline');
      term.write(`\r\n\x1b[33m[${t('term.disconnected')}${e.reason ? `: ${e.reason}` : ''}]\x1b[0m\r\n`);
    };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    const dataSub = term.onData((d) => send({ t: 'i', d }));
    const resizeSub = term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(host.current);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [path, nonce]);

  return (
    <div class="console">
      <div class="console-bar">
        <Badge state={status} label={t(`term.${status}`)} />
        <Button small onClick={() => setNonce((n) => n + 1)}>
          {t('term.reconnect')}
        </Button>
      </div>
      <div ref={host} class="term-host" style={{ height }} />
    </div>
  );
}
