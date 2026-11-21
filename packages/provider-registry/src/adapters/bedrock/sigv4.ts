// SPDX-License-Identifier: MIT
/**
 * AWS Signature Version 4, the way AWS services check who sent a request.
 *
 * In plain terms: instead of sending the secret key, the caller sends a
 * fingerprint computed from the request and the secret. AWS recomputes it and
 * compares. This file computes that fingerprint with Node's built-in crypto;
 * no AWS SDK is involved.
 *
 * Reference: "Create a signed AWS API request" in the AWS IAM user guide.
 */

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SignInput {
  readonly method: 'GET' | 'POST';
  /** The full URL as it will be sent (path already percent-encoded once). */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding as AWS wants it: everything but A-Z a-z 0-9 - _ . ~ */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Sign a request. Returns the headers to send: the caller's own, plus
 * `x-amz-date`, `x-amz-security-token` (when a session token is used) and
 * `authorization`.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers['host'] = url.host;
  headers['x-amz-date'] = amzDate;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  // For every service except S3 the path is encoded a second time in the
  // canonical request: a model id's ":" travels as "%3A" and is signed as "%253A".
  const canonicalUri =
    url.pathname
      .split('/')
      .map((segment) => awsEncode(segment))
      .join('/') || '/';

  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${(headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, sha256Hex(input.body)].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const out: Record<string, string> = { ...headers };
  // `host` is set by the HTTP client from the URL; sending it twice is an error in some runtimes.
  delete out['host'];
  out['authorization'] = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
