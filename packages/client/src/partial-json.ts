/**
 * parsePartialJson — tolerant incremental JSON parser (Phase 7).
 *
 * Structured-object streaming delivers a JSON object one text fragment at a
 * time. To render it *progressively* the client must parse the buffer even when
 * it is mid-token — a half-written string, a trailing comma, an unclosed array.
 * This completes the partial text (closes open strings/containers, drops dangling
 * separators) and `JSON.parse`s the result, returning the best-effort value plus
 * a state flag.
 *
 * It NEVER throws and NEVER `eval`s — it only ever feeds sanitized text to the
 * native `JSON.parse`, so a malicious payload cannot execute or hang it.
 *
 * Browser-safe: no Node.js APIs.
 */

export type PartialJsonState = 'valid' | 'partial' | 'failed';

export interface PartialJsonResult {
  /** The parsed value (best-effort for `partial`), or undefined for `failed`. */
  value: unknown;
  /** `valid` = whole buffer parsed as-is; `partial` = parsed after completion; `failed` = unparseable. */
  state: PartialJsonState;
}

/** Hard cap so a pathological buffer can't make completion loop unboundedly. */
const MAX_LEN = 5_000_000;

/**
 * Extract the JSON candidate from a streamed text buffer that may be wrapped in
 * a markdown code fence (```json …```), prefixed with prose, or trailed by
 * commentary. Returns the balanced top-level object/array substring (dropping
 * trailing junk), or the unclosed remainder for progressive parsing. Robust to
 * how a model actually formats "respond with JSON" — keeps `parsePartialJson`
 * itself strict. Returns the trimmed input when no structure has appeared yet.
 */
export function extractJsonCandidate(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[a-zA-Z0-9]*\s*/);
  if (fence) t = t.slice(fence[0].length);
  const start = t.search(/[{[]/);
  if (start === -1) return t;       // no JSON structure yet
  if (start > 0) t = t.slice(start); // drop leading prose

  // Scan to the matching top-level close (respecting strings) to drop a trailing
  // fence / commentary. If unclosed, return the remainder (still streaming).
  const open = t[0];
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return t.slice(0, i + 1); }
  }
  void open;
  return t;
}

export function parsePartialJson(text: string): PartialJsonResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { value: undefined, state: 'failed' };
  }
  // Fast path: the buffer is already complete, valid JSON.
  try {
    return { value: JSON.parse(text), state: 'valid' };
  } catch {
    // fall through to completion
  }
  if (text.length > MAX_LEN) return { value: undefined, state: 'failed' };

  const completed = completeJson(text);
  if (completed === null) return { value: undefined, state: 'failed' };
  try {
    return { value: JSON.parse(completed), state: 'partial' };
  } catch {
    return { value: undefined, state: 'failed' };
  }
}

type Expect = 'value' | 'key' | 'colon' | 'comma-close';

/**
 * Best-effort completion of a truncated JSON document via a single-pass JSON
 * state machine. Returns null when the text is structurally invalid (a mismatched
 * or extra closer, an unquoted key, a stray token) — those are malformed inputs,
 * not partials. Otherwise it closes an open string, drops a dangling
 * key/separator or partial primitive at the tail, and appends the closers needed
 * to balance the open containers.
 */
function completeJson(text: string): string | null {
  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escaped = false;
  let expect: Expect = 'value';
  let stringRole: 'key' | 'value' = 'value';
  let stringStart = -1;
  let primStart = -1; // start index of an in-progress primitive (number/keyword)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; expect = stringRole === 'key' ? 'colon' : 'comma-close'; }
      continue;
    }

    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      if (primStart >= 0) primStart = -1; // whitespace terminates a primitive
      continue;
    }

    switch (ch) {
      case '"':
        if (primStart >= 0) return null;
        if (expect === 'key') stringRole = 'key';
        else if (expect === 'value') stringRole = 'value';
        else return null;
        inString = true; stringStart = i;
        break;
      case '{':
        if (expect !== 'value') return null;
        stack.push('{'); expect = 'key';
        break;
      case '[':
        if (expect !== 'value') return null;
        stack.push('['); expect = 'value';
        break;
      case '}': {
        if (primStart >= 0) primStart = -1;
        if (stack.pop() !== '{') return null;
        if (expect !== 'comma-close' && expect !== 'key') return null; // 'key' ⇒ empty {}
        expect = 'comma-close';
        break;
      }
      case ']': {
        if (primStart >= 0) primStart = -1;
        if (stack.pop() !== '[') return null;
        if (expect !== 'comma-close' && expect !== 'value') return null; // 'value' ⇒ empty []
        expect = 'comma-close';
        break;
      }
      case ':':
        if (expect !== 'colon') return null;
        expect = 'value';
        break;
      case ',':
        if (primStart >= 0) primStart = -1;
        if (expect !== 'comma-close') return null;
        expect = stack[stack.length - 1] === '{' ? 'key' : 'value';
        break;
      default:
        // A primitive char (digit, -, or a t/f/n keyword char).
        if (expect === 'value') { primStart = i; expect = 'comma-close'; }
        else if (expect === 'comma-close' && primStart >= 0) { /* primitive continues */ }
        else return null;
        break;
    }
  }

  let out: string;
  if (inString) {
    if (stringRole === 'key') {
      out = cleanTail(text.slice(0, stringStart)); // drop the partial key + its comma
    } else {
      out = (escaped ? text.slice(0, -1) : text) + '"'; // close the partial value string
    }
  } else if (primStart >= 0) {
    const token = text.slice(primStart).trim();
    out = isCompletePrimitive(token) ? text : cleanTail(text.slice(0, primStart));
  } else if (expect === 'colon') {
    // closed a key but no colon/value yet → drop the dangling key (+ its comma)
    out = cleanTail(text.replace(/"(?:[^"\\]|\\.)*"\s*$/, ''));
  } else if (expect === 'value' || expect === 'key') {
    out = cleanTail(text); // dangling separator / trailing comma
  } else {
    out = text;
  }

  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

/** Strip trailing whitespace, commas, and dangling `"key":` pairs from a prefix. */
function cleanTail(input: string): string {
  let s = input;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s+$/, '');
    s = s.replace(/,$/, '');
    if (s.endsWith(':')) {
      s = s.slice(0, -1).replace(/\s+$/, '');
      s = s.replace(/"(?:[^"\\]|\\.)*"$/, ''); // drop the now-valueless key
    }
  } while (s !== prev);
  return s;
}

function isCompletePrimitive(token: string): boolean {
  return token === 'true' || token === 'false' || token === 'null'
    || /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token);
}
