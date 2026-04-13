/**
 * Pre-built auth profile templates for common services.
 * Users just supply their domain + credentials and get a ready-to-use profile.
 */
import type { AuthProfile } from './types.js';

type PartialProfile = Omit<AuthProfile, 'id' | 'domain'> & { id?: string; domain?: string };

function template(base: PartialProfile) {
  return (id: string, domain: string, overrides?: Partial<AuthProfile>): AuthProfile => ({
    ...base,
    id,
    domain,
    ...overrides,
  } as AuthProfile);
}

/**
 * Jira Cloud — Basic auth (email + API token) or OAuth 2.0 3LO.
 * domain = "mycompany" → baseUrl = "https://mycompany.atlassian.net"
 */
export const jiraBasicAuth = template({
  label: 'Jira Cloud (Basic Auth)',
  method: 'basic',
});

export const jiraOAuth2 = template({
  label: 'Jira Cloud (OAuth 2.0)',
  method: 'oauth2_authorization_code',
  authorizationUrl: 'https://auth.atlassian.com/authorize',
  tokenUrl: 'https://auth.atlassian.com/oauth/token',
  scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'manage:jira-project', 'manage:jira-configuration'],
  redirectUri: 'http://localhost:3500/auth/callback',
});

/**
 * ServiceNow — Basic auth or OAuth 2.0 (client-credentials or auth-code).
 * domain = "mycompany" → baseUrl = "https://mycompany.service-now.com"
 */
export const serviceNowBasicAuth = template({
  label: 'ServiceNow (Basic Auth)',
  method: 'basic',
});

export const serviceNowOAuth2 = template({
  label: 'ServiceNow (OAuth 2.0)',
  method: 'oauth2_authorization_code',
  authorizationUrl: 'https://{{domain}}.service-now.com/oauth_auth.do',
  tokenUrl: 'https://{{domain}}.service-now.com/oauth_token.do',
  scopes: ['useraccount'],
  redirectUri: 'http://localhost:3500/auth/callback',
});

export const serviceNowClientCredentials = template({
  label: 'ServiceNow (Client Credentials)',
  method: 'oauth2_client_credentials',
  tokenUrl: 'https://{{domain}}.service-now.com/oauth_token.do',
});

/**
 * Facebook / Instagram — OAuth 2.0 via Meta.
 * domain = app ID or ignored; uses graph.facebook.com.
 */
export const facebookOAuth2 = template({
  label: 'Facebook (OAuth 2.0)',
  method: 'oauth2_authorization_code',
  authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
  scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_metadata'],
  redirectUri: 'http://localhost:3500/auth/callback',
});

export const instagramOAuth2 = template({
  label: 'Instagram (OAuth 2.0)',
  method: 'oauth2_authorization_code',
  authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
  scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_messages'],
  redirectUri: 'http://localhost:3500/auth/callback',
});

/**
 * Canva — OAuth 2.0.
 * domain = ignored for API calls (uses api.canva.com), but required for profile.
 */
export const canvaOAuth2 = template({
  label: 'Canva (OAuth 2.0)',
  method: 'oauth2_authorization_code',
  authorizationUrl: 'https://www.canva.com/api/oauth/authorize',
  tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
  scopes: ['design:content:read', 'design:content:write', 'design:meta:read', 'asset:read', 'asset:write', 'folder:read', 'folder:write', 'comment:read', 'comment:write'],
  redirectUri: 'http://localhost:3500/auth/callback',
});
