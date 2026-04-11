/**
 * JSON file sink — writes spans and usage records to JSON files
 */
import type { SpanRecord, UsageRecord, TraceSink } from '@weaveintel/core';
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface JsonSinkConfig {
  dir: string;
  /** Max records per file before rotation */
  maxRecords?: number;
}

export function weaveJsonSink(config: JsonSinkConfig): TraceSink & {
  flush(): Promise<void>;
  recordCount(): number;
} {
  if (!existsSync(config.dir)) mkdirSync(config.dir, { recursive: true });
  const maxRecords = config.maxRecords ?? 1000;
  let buffer: Array<{ type: string; record: SpanRecord | UsageRecord; timestamp: number }> = [];
  let fileIndex = 0;

  function currentFile(): string {
    return join(config.dir, `traces-${fileIndex}.jsonl`);
  }

  async function flush() {
    if (buffer.length === 0) return;
    const lines = buffer.map(r => JSON.stringify(r)).join('\n') + '\n';
    appendFileSync(currentFile(), lines);
    buffer = [];
  }

  function maybeRotate() {
    // Simple check: rotate if file line count exceeds max
    if (buffer.length >= maxRecords) {
      flush();
      fileIndex++;
    }
  }

  return {
    record(span: SpanRecord) {
      buffer.push({ type: 'span', record: span, timestamp: Date.now() });
      maybeRotate();
    },
    flush,
    recordCount() {
      return buffer.length;
    },
  };
}
