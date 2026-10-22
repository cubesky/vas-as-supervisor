import { useEffect, useRef, useState } from 'preact/hooks';
import RFB from '@novnc/novnc';
import { wsUrl } from '../api';
import { t } from '../i18n';
import { Badge, Button, Toggle } from './ui';

/** noVNC client for a VM's VNC display, proxied by the manager over WebSocket. */
export function VncViewer({ vm }: { vm: string }) {
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [reason, setReason] = useState('');
  const [scale, setScale] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!host.current) return;
    setStatus('connecting');
    setReason('');
    const r = new RFB(host.current, wsUrl(`/vms/${encodeURIComponent(vm)}/vnc`), { shared: true });
    r.scaleViewport = scale;
    r.resizeSession = false;
    r.viewOnly = viewOnly;
    r.background = '#0d0f12';
    r.addEventListener('connect', () => setStatus('online'));
    r.addEventListener('disconnect', (e: any) => {
      setStatus('offline');
      if (!e?.detail?.clean) setReason(t('vnc.lost'));
    });
    r.addEventListener('credentialsrequired', () => {
      const password = window.prompt(t('vnc.password')) ?? '';
      r.sendCredentials({ password });
    });
    rfb.current = r;
    return () => {
      r.disconnect();
      rfb.current = null;
    };
  }, [vm, nonce]);

  useEffect(() => {
    if (rfb.current) rfb.current.scaleViewport = scale;
  }, [scale]);
  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = viewOnly;
  }, [viewOnly]);

  return (
    <div class="console">
      <div class="console-bar">
        <Badge state={status} label={t(`term.${status}`)} />
        {reason && <span class="muted">{reason}</span>}
        <div class="spacer" />
        <Toggle label={t('vnc.scale')} checked={scale} onChange={setScale} />
        <Toggle label={t('vnc.viewOnly')} checked={viewOnly} onChange={setViewOnly} />
        <Button small onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</Button>
        <Button small onClick={() => host.current?.requestFullscreen?.()}>{t('vnc.fullscreen')}</Button>
        <Button small onClick={() => setNonce((n) => n + 1)}>{t('term.reconnect')}</Button>
      </div>
      <div ref={host} class="vnc-host" />
    </div>
  );
}
