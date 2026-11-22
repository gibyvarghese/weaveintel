/**
 * The credential kinds this package can apply: a CLOSED list (FRAMEWORK 2.1). A host offers a kind only when it is
 * here; a pack chooses among these; a workspace cannot add one. Each kind names its secret parts (sealed by the host,
 * never read back) and its setting parts (plain, shown, prefilled by a template).
 *
 * Kinds not yet built (FRAMEWORK 2.2 lists them): api_key_set, oauth_person, oauth_jwt_bearer, oauth_saml_bearer,
 * oauth_token_exchange, oauth_device, oauth_fapi, dpop_key, client_certificate, keystore, ws_trust_sts, aws_keys,
 * aws_assume_role, aws_web_identity, gcp_service_account_key, workload_identity, private_key, oauth1_signed, ssh_key,
 * pgp_keys, kerberos_keytab, jwt_signing_key, signing_secret (inbound, see ../inbound), inbound_oidc, db_iam_token,
 * connection_string. Each arrives as a release of this file plus its applier and golden tests.
 */

/** A setting part: its name, the value used when nothing is set, and (for a closed choice) the allowed values. */
export interface SettingPart {
  readonly name: string
  readonly label: string
  readonly default?: string | undefined
  readonly choices?: readonly string[] | undefined
  /** Must be filled before the credential can be used. */
  readonly required?: boolean | undefined
}

/** One kind: its secret and setting parts, and whether it fetches tokens (so it needs `send` and the cache). */
export interface CredentialKindDefinition {
  readonly label: string
  readonly secretParts: readonly string[]
  readonly settingParts: readonly SettingPart[]
  readonly fetchesTokens: boolean
}

/** The HMAC recipes outbound signing may use (closed; the inbound verifiers mirror them). */
export const HMAC_PROFILES = ['body_sha256_hex', 'body_sha256_base64', 'timestamp_body_sha256_hex'] as const
/** One HMAC recipe. */
export type HmacProfile = (typeof HMAC_PROFILES)[number]

/** The catalogue. */
export const CREDENTIAL_KINDS = {
  none: { label: 'No credential', secretParts: [], settingParts: [], fetchesTokens: false },
  api_key: {
    label: 'API key', secretParts: ['api_key'], fetchesTokens: false,
    settingParts: [
      { name: 'placement', label: 'Sent in the', default: 'header', choices: ['header', 'query', 'cookie'] },
      { name: 'name', label: 'Header or parameter name', default: 'x-api-key' },
      { name: 'prefix', label: 'Written before the key', default: '' },
    ],
  },
  bearer_token: { label: 'Token', secretParts: ['token'], fetchesTokens: false, settingParts: [{ name: 'prefix', label: 'Written before the token', default: 'Bearer' }] },
  basic: { label: 'User name and password', secretParts: ['password'], fetchesTokens: false, settingParts: [{ name: 'username', label: 'User name', required: true }] },
  oauth_client: {
    label: 'OAuth client (client credentials)', secretParts: ['client_secret'], fetchesTokens: true,
    settingParts: [
      { name: 'client_id', label: 'Client id', required: true },
      { name: 'token_url', label: 'Token address', required: true },
      { name: 'scope', label: 'Scopes', default: '' },
      { name: 'audience', label: 'Audience', default: '' },
      { name: 'client_auth', label: 'Client sends its secret', default: 'client_secret_basic', choices: ['client_secret_basic', 'client_secret_post'] },
    ],
  },
  oauth_refresh: {
    label: 'OAuth sign-in by an administrator (refresh token)', secretParts: ['client_secret', 'refresh_token'], fetchesTokens: true,
    settingParts: [
      { name: 'client_id', label: 'Client id', required: true },
      { name: 'token_url', label: 'Token address', required: true },
      { name: 'scope', label: 'Scopes', default: '' },
      { name: 'client_auth', label: 'Client sends its secret', default: 'client_secret_basic', choices: ['client_secret_basic', 'client_secret_post'] },
    ],
  },
  hmac_signing: {
    label: 'Signed with a shared secret (HMAC)', secretParts: ['secret'], fetchesTokens: false,
    settingParts: [
      { name: 'canonical_profile', label: 'Signing recipe', default: 'timestamp_body_sha256_hex', choices: [...HMAC_PROFILES] },
      { name: 'signature_header', label: 'Signature header', default: 'x-signature' },
      { name: 'timestamp_header', label: 'Timestamp header', default: 'x-signature-timestamp' },
      { name: 'prefix', label: 'Written before the signature', default: '' },
      { name: 'key_id', label: 'Key id', default: '' },
      { name: 'key_id_header', label: 'Key id header', default: '' },
    ],
  },
} as const satisfies Record<string, CredentialKindDefinition>

/** A kind this package can apply. */
export type CredentialKindKey = keyof typeof CREDENTIAL_KINDS

/** Whether a value names a kind in the catalogue. */
export function isCredentialKind(v: unknown): v is CredentialKindKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CREDENTIAL_KINDS, v)
}

/** A setting's value: what is set, else the kind's default, else empty. */
export function settingOf(kind: CredentialKindKey, settings: Readonly<Record<string, string>>, name: string): string {
  const set = settings[name]
  if (set !== undefined && set !== '') return set
  const part = (CREDENTIAL_KINDS[kind].settingParts as readonly SettingPart[]).find((p) => p.name === name)
  return part?.default ?? ''
}
