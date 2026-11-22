import { createHmac } from 'node:crypto'
import type { HmacProfile } from './catalogue.js'

/**
 * Sign with one of the closed HMAC recipes. The inbound verifiers check the same recipes, so a delivery this
 * platform signs can be checked by a receiver that follows the recipe.
 * @param profile The recipe.
 * @param secret The shared secret.
 * @param parts The body exactly as sent, and the timestamp (seconds since 1970, as text) for timestamped recipes.
 * @returns the signature (hex or base64, as the recipe says), without any prefix.
 */
export function signHmac(profile: HmacProfile, secret: string, parts: { readonly body: string; readonly timestamp: string }): string {
  switch (profile) {
    case 'body_sha256_hex': return createHmac('sha256', secret).update(parts.body, 'utf8').digest('hex')
    case 'body_sha256_base64': return createHmac('sha256', secret).update(parts.body, 'utf8').digest('base64')
    case 'timestamp_body_sha256_hex': return createHmac('sha256', secret).update(`${parts.timestamp}.${parts.body}`, 'utf8').digest('hex')
  }
}
