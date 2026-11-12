// SPDX-License-Identifier: MIT
/**
 * Reader for the AWS binary event stream that Bedrock's streaming replies use.
 *
 * In plain terms: Bedrock does not stream text lines. It streams small binary
 * envelopes, each with a length, a few named headers (what kind of event this
 * is) and a JSON payload, protected by two checksums. This file cuts the byte
 * stream back into those envelopes and checks the checksums.
 *
 * Layout of one message (all numbers big-endian):
 *   [4 total length][4 headers length][4 CRC of those 8 bytes]
 *   [headers][payload][4 CRC of everything before it]
 * One header: [1 name length][name][1 value type][2 value length][value]
 * Only value type 7 (string) is used by Bedrock.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (the one zip and PNG use). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface EventStreamMessage {
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Uint8Array;
}

/** Thrown when the bytes are not a well-formed event stream. */
export class EventStreamFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventStreamFormatError';
  }
}

function decodeMessage(bytes: Uint8Array): EventStreamMessage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0);
  const headersLength = view.getUint32(4);
  if (view.getUint32(8) !== crc32(bytes.subarray(0, 8))) throw new EventStreamFormatError('prelude checksum mismatch');
  if (view.getUint32(total - 4) !== crc32(bytes.subarray(0, total - 4))) throw new EventStreamFormatError('message checksum mismatch');
  if (12 + headersLength > total - 4) throw new EventStreamFormatError('headers run past the message');
  const text = new TextDecoder();
  const headers: Record<string, string> = {};
  let p = 12;
  const headersEnd = 12 + headersLength;
  while (p < headersEnd) {
    const nameLength = view.getUint8(p);
    p += 1;
    const name = text.decode(bytes.subarray(p, p + nameLength));
    p += nameLength;
    const type = view.getUint8(p);
    p += 1;
    if (type === 7 || type === 6) {
      const valueLength = view.getUint16(p);
      p += 2;
      if (type === 7) headers[name] = text.decode(bytes.subarray(p, p + valueLength));
      p += valueLength;
    } else if (type === 0 || type === 1) {
      /* boolean true / false: no value bytes */
    } else if (type === 2) p += 1;
    else if (type === 3) p += 2;
    else if (type === 4) p += 4;
    else if (type === 5 || type === 8) p += 8;
    else if (type === 9) p += 16;
    else throw new EventStreamFormatError(`unknown header value type ${type}`);
  }
  return { headers, payload: bytes.subarray(headersEnd, total - 4) };
}

/** Cut a byte stream into event-stream messages. */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.length > 0) {
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer, 0);
        next.set(value, buffer.length);
        buffer = next;
      }
      for (;;) {
        if (buffer.length < 12) break;
        const total = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
        if (total < 16 || total > 16 * 1024 * 1024) throw new EventStreamFormatError('impossible message length');
        if (buffer.length < total) break;
        yield decodeMessage(buffer.subarray(0, total));
        buffer = buffer.slice(total);
      }
      if (done) {
        if (buffer.length > 0) throw new EventStreamFormatError('the stream ended in the middle of a message');
        return;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** Build one event-stream message. Used by tests and fake servers. */
export function encodeEventStreamMessage(headers: Readonly<Record<string, string>>, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const h = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    h[0] = n.length;
    h.set(n, 1);
    h[1 + n.length] = 7;
    new DataView(h.buffer).setUint16(2 + n.length, v.length);
    h.set(v, 4 + n.length);
    parts.push(h);
  }
  const headersLength = parts.reduce((s, p) => s + p.length, 0);
  const total = 12 + headersLength + payload.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  let p = 12;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  out.set(payload, p);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}
