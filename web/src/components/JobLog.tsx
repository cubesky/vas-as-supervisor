import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, onEvent, type JobSummary } from '../api';
import { t } from '../i18n';
import { Badge, Modal } from './ui';

const openJobId = signal<{ id: string; title: string } | null>(null);
export const runningJobs = signal<JobSummary[]>([]);

export function openJob(id: string, title: string): void {
  openJobId.value = { id, title };
}

// track running jobs globally for the top bar indicator
onEvent((ev) => {
  if (ev.type !== 'job') return;
  const rest = runningJobs.value.filter((j) => j.id !== ev.job.id);
  runningJobs.value = ev.job.state === 'running' ? [...rest, ev.job] : rest;
});

export function JobDialog() {
  const cur = openJobId.value;
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<JobSummary['state']>('running');
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!cur) return;
    setLines([]);
    setState('running');
    const off = onEvent((ev) => {
      if (ev.type === 'job-line' && ev.id === cur.id) setLines((l) => [...l, ev.line]);
      if (ev.type === 'job' && ev.job.id === cur.id) setState(ev.job.state);
    });
    api<JobSummary & { lines: string[] }>(`/jobs/${cur.id}`)
      .then((j) => {
        setLines((l) => (l.length > j.lines.length ? l : j.lines));
        setState(j.state);
      })
      .catch(() => undefined);
    return off;
  }, [cur?.id]);

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [lines.length]);

  if (!cur) return null;
  return (
    <Modal title={cur.title} wide onClose={() => (openJobId.value = null)} footer={<Badge state={state} label={t(`job.${state}`)} />}>
      <pre ref={pre} class="logbox tall">
        {lines.join('\n') || (state === 'running' ? t('job.waiting') : t('common.empty'))}
      </pre>
    </Modal>
  );
}
