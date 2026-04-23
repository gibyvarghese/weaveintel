/**
 * Example 59: OAuth connection patterns for cloud tool connectors
 *
 * Run:
 *   npx tsx examples/59-oauth-tool-connection-examples.ts
 *
 * This example shows how to:
 * 1) Exchange an authorization code using client_id/client_secret.
 * 2) Refresh access tokens.
 * 3) Build execution-context metadata for each connector package.
 *
 * Note: This file demonstrates wiring and token lifecycle patterns.
 * It does not invoke connector MCP servers directly.
 */

type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`OAuth token request failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function exchangeGoogleCode(code: string, redirectUri: string): Promise<TokenSet> {
  const form = new URLSearchParams({
    client_id: requireEnv('OAUTH_GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('OAUTH_GOOGLE_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const data = await postForm('https://oauth2.googleapis.com/token', form);
  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken: data['refresh_token'] ? String(data['refresh_token']) : undefined,
    expiresIn: data['expires_in'] ? Number(data['expires_in']) : undefined,
    tokenType: data['token_type'] ? String(data['token_type']) : undefined,
  };
}

async function refreshGoogleToken(refreshToken: string): Promise<TokenSet> {
  const form = new URLSearchParams({
    client_id: requireEnv('OAUTH_GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('OAUTH_GOOGLE_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const data = await postForm('https://oauth2.googleapis.com/token', form);
  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken,
    expiresIn: data['expires_in'] ? Number(data['expires_in']) : undefined,
    tokenType: data['token_type'] ? String(data['token_type']) : undefined,
  };
}

async function exchangeMicrosoftCode(code: string, redirectUri: string): Promise<TokenSet> {
  const tenant = process.env['OAUTH_MICROSOFT_TENANT'] ?? 'common';
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: requireEnv('OAUTH_MICROSOFT_CLIENT_ID'),
    client_secret: requireEnv('OAUTH_MICROSOFT_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const data = await postForm(tokenUrl, form);
  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken: data['refresh_token'] ? String(data['refresh_token']) : undefined,
    expiresIn: data['expires_in'] ? Number(data['expires_in']) : undefined,
    tokenType: data['token_type'] ? String(data['token_type']) : undefined,
  };
}

async function refreshMicrosoftToken(refreshToken: string): Promise<TokenSet> {
  const tenant = process.env['OAUTH_MICROSOFT_TENANT'] ?? 'common';
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: requireEnv('OAUTH_MICROSOFT_CLIENT_ID'),
    client_secret: requireEnv('OAUTH_MICROSOFT_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const data = await postForm(tokenUrl, form);
  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken: data['refresh_token'] ? String(data['refresh_token']) : refreshToken,
    expiresIn: data['expires_in'] ? Number(data['expires_in']) : undefined,
    tokenType: data['token_type'] ? String(data['token_type']) : undefined,
  };
}

async function exchangeDropboxCode(code: string, redirectUri: string): Promise<TokenSet> {
  const form = new URLSearchParams({
    client_id: requireEnv('OAUTH_DROPBOX_CLIENT_ID'),
    client_secret: requireEnv('OAUTH_DROPBOX_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const data = await postForm('https://api.dropboxapi.com/oauth2/token', form);
  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken: data['refresh_token'] ? String(data['refresh_token']) : undefined,
    expiresIn: data['expires_in'] ? Number(data['expires_in']) : undefined,
    tokenType: data['token_type'] ? String(data['token_type']) : undefined,
  };
}

async function exchangeSlackCode(code: string, redirectUri: string): Promise<TokenSet> {
  const form = new URLSearchParams({
    client_id: requireEnv('OAUTH_SLACK_CLIENT_ID'),
    client_secret: requireEnv('OAUTH_SLACK_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const data = await postForm('https://slack.com/api/oauth.v2.access', form);
  const authedUser = data['authed_user'] as Record<string, unknown> | undefined;
  return {
    accessToken: String(data['access_token'] ?? authedUser?.['access_token'] ?? ''),
    refreshToken: data['refresh_token'] ? String(data['refresh_token']) : undefined,
    expiresIn: data['expires_in'] ? Number(data['expires_in']) : undefined,
    tokenType: data['token_type'] ? String(data['token_type']) : undefined,
  };
}

function connectorMetadata(tokens: {
  google?: TokenSet;
  microsoft?: TokenSet;
  dropbox?: TokenSet;
  slack?: TokenSet;
}): Record<string, string> {
  const metadata: Record<string, string> = {};

  if (tokens.google) {
    metadata['gmailAccessToken'] = tokens.google.accessToken;
    if (tokens.google.refreshToken) {
      metadata['gmailRefreshAccessToken'] = tokens.google.refreshToken;
    }
    metadata['gmailUserId'] = 'me';

    metadata['gdriveAccessToken'] = tokens.google.accessToken;
    if (tokens.google.refreshToken) {
      metadata['gdriveRefreshAccessToken'] = tokens.google.refreshToken;
    }

    metadata['gcalAccessToken'] = tokens.google.accessToken;
    if (tokens.google.refreshToken) {
      metadata['gcalRefreshAccessToken'] = tokens.google.refreshToken;
    }
    metadata['gcalCalendarId'] = 'primary';
  }

  if (tokens.microsoft) {
    metadata['outlookAccessToken'] = tokens.microsoft.accessToken;
    if (tokens.microsoft.refreshToken) {
      metadata['outlookRefreshAccessToken'] = tokens.microsoft.refreshToken;
    }
    metadata['outlookUserId'] = 'me';

    metadata['outlookCalAccessToken'] = tokens.microsoft.accessToken;
    if (tokens.microsoft.refreshToken) {
      metadata['outlookCalRefreshAccessToken'] = tokens.microsoft.refreshToken;
    }
    metadata['outlookCalUserId'] = 'me';

    metadata['onedriveAccessToken'] = tokens.microsoft.accessToken;
    if (tokens.microsoft.refreshToken) {
      metadata['onedriveRefreshAccessToken'] = tokens.microsoft.refreshToken;
    }
    metadata['onedriveUserId'] = 'me';
  }

  if (tokens.dropbox) {
    metadata['dropboxAccessToken'] = tokens.dropbox.accessToken;
    if (tokens.dropbox.refreshToken) {
      metadata['dropboxRefreshAccessToken'] = tokens.dropbox.refreshToken;
    }
  }

  if (tokens.slack) {
    metadata['slackBotToken'] = tokens.slack.accessToken;
    if (tokens.slack.refreshToken) {
      metadata['slackRefreshBotToken'] = tokens.slack.refreshToken;
    }
  }

  return metadata;
}

async function gmailOnlyExample(): Promise<void> {
  const authCode = process.env['GMAIL_AUTH_CODE'];
  const redirectUri = process.env['GMAIL_REDIRECT_URI'];
  if (!authCode || !redirectUri) {
    console.log('Skipping gmailOnlyExample. Set GMAIL_AUTH_CODE and GMAIL_REDIRECT_URI to run it.');
    return;
  }

  const gmailTokens = await exchangeGoogleCode(authCode, redirectUri);
  console.log('Gmail access token acquired. Expires in seconds:', gmailTokens.expiresIn ?? 'unknown');

  if (gmailTokens.refreshToken) {
    const refreshed = await refreshGoogleToken(gmailTokens.refreshToken);
    gmailTokens.accessToken = refreshed.accessToken;
  }

  const metadata = connectorMetadata({ google: gmailTokens });
  console.log('Execution-context metadata for Gmail + Google tools:');
  console.log(JSON.stringify(metadata, null, 2));
}

async function main(): Promise<void> {
  console.log('OAuth connector wiring example.');
  await gmailOnlyExample();

  console.log('\nFor other connectors, use the corresponding exchange function:');
  console.log('- exchangeMicrosoftCode(...) for outlook/outlook-cal/onedrive');
  console.log('- exchangeDropboxCode(...) for dropbox');
  console.log('- exchangeSlackCode(...) for slack');
  console.log('Then call connectorMetadata(...) with the resulting token sets.');

  // Keep symbols referenced for copy/paste usage patterns.
  void exchangeMicrosoftCode;
  void refreshMicrosoftToken;
  void exchangeDropboxCode;
  void exchangeSlackCode;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
