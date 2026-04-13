/**
 * @weaveintel/tools-enterprise — Auth profile templates unit tests
 */
import { describe, it, expect } from 'vitest';
import {
  jiraBasicAuth,
  jiraOAuth2,
  serviceNowBasicAuth,
  serviceNowOAuth2,
  serviceNowClientCredentials,
  facebookOAuth2,
  instagramOAuth2,
  canvaOAuth2,
} from '../auth/profiles.js';

describe('Auth profile templates', () => {
  it('jiraBasicAuth creates a valid basic auth profile', () => {
    const p = jiraBasicAuth('jira-1', 'mycompany', { username: 'alice@co.com', password: 'api-token-xyz' });
    expect(p.id).toBe('jira-1');
    expect(p.domain).toBe('mycompany');
    expect(p.method).toBe('basic');
    expect(p.label).toContain('Jira');
    expect(p.username).toBe('alice@co.com');
    expect(p.password).toBe('api-token-xyz');
  });

  it('jiraOAuth2 creates a valid OAuth profile', () => {
    const p = jiraOAuth2('jira-oauth', 'acme', { clientId: 'c1', clientSecret: 's1' });
    expect(p.id).toBe('jira-oauth');
    expect(p.domain).toBe('acme');
    expect(p.method).toBe('oauth2_authorization_code');
    expect(p.authorizationUrl).toContain('atlassian.com');
    expect(p.tokenUrl).toContain('atlassian.com');
    expect(p.scopes).toBeDefined();
    expect(p.scopes!.length).toBeGreaterThan(0);
    expect(p.redirectUri).toContain('localhost');
    expect(p.clientId).toBe('c1');
  });

  it('serviceNowBasicAuth creates a valid profile', () => {
    const p = serviceNowBasicAuth('sn-1', 'myinst');
    expect(p.method).toBe('basic');
    expect(p.domain).toBe('myinst');
  });

  it('serviceNowOAuth2 resolves domain in URLs', () => {
    const p = serviceNowOAuth2('sn-o', 'myinst');
    expect(p.authorizationUrl).toContain('{{domain}}');
    expect(p.tokenUrl).toContain('{{domain}}');
    expect(p.method).toBe('oauth2_authorization_code');
  });

  it('serviceNowClientCredentials creates client creds profile', () => {
    const p = serviceNowClientCredentials('sn-cc', 'prod');
    expect(p.method).toBe('oauth2_client_credentials');
    expect(p.tokenUrl).toContain('{{domain}}');
  });

  it('facebookOAuth2 creates a Meta OAuth profile', () => {
    const p = facebookOAuth2('fb-1', 'myapp');
    expect(p.method).toBe('oauth2_authorization_code');
    expect(p.authorizationUrl).toContain('facebook.com');
    expect(p.tokenUrl).toContain('graph.facebook.com');
    expect(p.scopes).toBeDefined();
    expect(p.scopes!.some(s => s.includes('pages'))).toBe(true);
  });

  it('instagramOAuth2 creates an IG OAuth profile', () => {
    const p = instagramOAuth2('ig-1', 'myapp');
    expect(p.method).toBe('oauth2_authorization_code');
    expect(p.scopes).toBeDefined();
    expect(p.scopes!.some(s => s.includes('instagram'))).toBe(true);
  });

  it('canvaOAuth2 creates a Canva OAuth profile', () => {
    const p = canvaOAuth2('canva-1', 'myapp');
    expect(p.method).toBe('oauth2_authorization_code');
    expect(p.authorizationUrl).toContain('canva.com');
    expect(p.tokenUrl).toContain('canva.com');
    expect(p.scopes).toBeDefined();
    expect(p.scopes!.some(s => s.includes('design'))).toBe(true);
  });

  it('all templates honour overrides', () => {
    const p = jiraBasicAuth('custom', 'dom', {
      label: 'Custom Label',
      extraHeaders: { 'X-Test': 'yes' },
    });
    expect(p.label).toBe('Custom Label');
    expect(p.extraHeaders?.['X-Test']).toBe('yes');
  });
});
