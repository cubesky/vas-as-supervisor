import { EventEmitter } from 'node:events';

export type VASEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'job'; job: JobSummary }
  | { type: 'job-line'; id: string; line: string }
  | { type: 'changed'; topic: string; id?: string }
  | { type: 'ports' };

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  msg: string;
  data?: unknown;
}

export interface JobSummary {
  id: string;
  title: string;
  topic: string;
  state: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

class Bus extends EventEmitter {
  publish(ev: VASEvent): void {
    this.emit('event', ev);
  }
  /** Notify UIs that a resource collection changed so they refetch. */
  changed(topic: string, id?: string): void {
    this.publish({ type: 'changed', topic, id });
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
