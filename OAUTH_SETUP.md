# OAuth Setup Guide

This guide explains how to configure OAuth 2.0 authentication with Google, GitHub, and other providers in geneWeave.

## Overview

The OAuth implementation supports the following providers:
- **Google**
- **GitHub**  
- **Microsoft** 
- **Apple**
- **Facebook**

## Environment Variables

Set the following environment variables in your `.env` file:

```bash
# Google OAuth
OAUTH_GOOGLE_CLIENT_ID=your_google_client_id
OAUTH_GOOGLE_CLIENT_SECRET=your_google_client_secret

# GitHub OAuth
OAUTH_GITHUB_CLIENT_ID=your_github_client_id
OAUTH_GITHUB_CLIENT_SECRET=your_github_client_secret

# Microsoft OAuth
OAUTH_MICROSOFT_CLIENT_ID=your_microsoft_client_id
OAUTH_MICROSOFT_CLIENT_SECRET=your_microsoft_client_secret

# Apple OAuth
OAUTH_APPLE_CLIENT_ID=your_apple_client_id
OAUTH_APPLE_CLIENT_SECRET=your_apple_client_secret

# Facebook OAuth
OAUTH_FACEBOOK_CLIENT_ID=your_facebook_client_id
OAUTH_FACEBOOK_CLIENT_SECRET=your_facebook_client_secret
```

## Provider Setup Instructions

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google+ API
4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client IDs"
5. Choose "Web application"
6. Add authorized redirect URIs:
   - Local: `http://localhost:3500/api/oauth/callback`
   - Production: `https://yourdomain.com/api/oauth/callback`
7. Copy the Client ID and Client Secret
8. Add to `.env`:
   ```
   OAUTH_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
   OAUTH_GOOGLE_CLIENT_SECRET=xyz
   ```

### GitHub OAuth Setup

1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Click "New OAuth App"
3. Fill in the form:
   - **Application name**: geneWeave
   - **Homepage URL**: `http://localhost:3500` (or your domain)
   - **Application description**: AI Chat & Observability Platform
   - **Authorization callback URL**: `http://localhost:3500/api/oauth/callback`
4. Copy the Client ID and Client Secret
5. Add to `.env`:
   ```
   OAUTH_GITHUB_CLIENT_ID=xxxxx
   OAUTH_GITHUB_CLIENT_SECRET=xxxxx
   ```

### Microsoft OAuth Setup

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to Azure Active Directory → App registrations
3. Click "New registration"
4. Set redirect URI to `http://localhost:3500/api/oauth/callback`
5. Go to "Certificates & secrets" → "New client secret"
6. Copy the Application (client) ID and client secret value
7. Add to `.env`:
   ```
   OAUTH_MICROSOFT_CLIENT_ID=xxxxx
   OAUTH_MICROSOFT_CLIENT_SECRET=xxxxx
   ```

### Apple OAuth Setup

1. Go to [Apple Developer Account](https://developer.apple.com/)
2. Go to Certificates, Identifiers & Profiles
3. Create a new Service ID
4. Enable "Sign in with Apple"
5. Configure Return URLs: `http://localhost:3500/api/oauth/callback`
6. Generate and download the private key
7. Add to `.env`:
   ```
   OAUTH_APPLE_CLIENT_ID=xxxxx
   OAUTH_APPLE_CLIENT_SECRET=xxxxx
   ```

### Facebook OAuth Setup

1. Go to [Meta Developers](https://developers.facebook.com/)
2. Create a new app or use an existing one
3. Add "Facebook Login" product
4. In Settings → Basic, copy App ID and App Secret
5. In Facebook Login → Settings, add redirect URLs:
   - `http://localhost:3500/api/oauth/callback`
6. Add to `.env`:
   ```
   OAUTH_FACEBOOK_CLIENT_ID=xxxxx
   OAUTH_FACEBOOK_CLIENT_SECRET=xxxxx
   ```

## Callback URL

When running locally, use: `http://localhost:3500/api/oauth/callback`

When deploying to production, update the redirect URIs in each OAuth provider's dashboard to match your domain:
- `https://yourdomain.com/api/oauth/callback`

## Testing OAuth Flow

1. Start the server: `npm run dev`
2. Open `http://localhost:3500`
3. On the login page, click "Google" or "GitHub" button
4. You'll be redirected to the provider's authorization page
5. After granting permission, you'll be redirected back and automatically signed in
6. Your OAuth account will be linked to your geneWeave account

## Account Linking

After signup/login, navigate to Connectors page to:
- View all linked OAuth accounts
- Link new accounts from additional providers
- Unlink existing accounts

Linked accounts are stored securely in the database with:
- Provider name
- Provider user ID
- Email and name (if available from provider)
- Profile picture URL
- Last used timestamp

## Security Notes

- All OAuth tokens are exchanged server-side (never exposed to client)
- Tokens are not stored; we only store provider user IDs
- Session IDs use secure random generation (UUID v4)
- State tokens expire after 10 minutes
- OAuth state is stored in in-memory store (production should use Redis)

## Troubleshooting

### "Provider not configured" error
- Ensure all required environment variables are set
- Restart the server after adding new environment variables
- Check that the values don't have extra spaces

### Popup blocked
- Allow popups for localhost in your browser settings
- Check browser console for JavaScript errors

### "Invalid redirect URI" error
- Ensure the redirect URI in your .env matches exactly what's configured in each provider's dashboard
- Common issue: `http://` vs `https://` mismatch

### OAuth account not linking
- Clear browser cookies and try again
- Check server logs for token exchange errors
- Ensure the provider's API is returning expected data

## Production Deployment

For production deployments:

1. Update all redirect URIs in OAuth provider dashboards to your production domain
2. Use Redis instead of in-memory store for OAuth state (update `SessionStore` in server.ts)
3. Enable HTTPS (required by most OAuth providers)
4. Use strong random values for JWT secrets
5. Regularly rotate OAuth client secrets
6. Monitor OAuth logs for suspicious activity

## Additional Resources

- [OAuth 2.0 Specification](https://tools.ietf.org/html/rfc6749)
- [OpenID Connect](https://openid.net/connect/)
- [geneWeave Documentation](README.md)
