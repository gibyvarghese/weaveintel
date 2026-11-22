/**
 * @weaveintel/connect/credentials — credential kinds, their appliers, and the single-flight token cache.
 */
export { CREDENTIAL_KINDS, HMAC_PROFILES, isCredentialKind, settingOf, type CredentialKindDefinition, type CredentialKindKey, type HmacProfile, type SettingPart } from './catalogue.js'
export { applyCredential, redactRequest, type ApplyContext, type ApplyResult, type CredentialMaterial } from './apply.js'
export { createTokenCache, type FetchedToken, type TokenCache } from './token-cache.js'
export { signHmac, standardWebhooksKey } from './hmac.js'
