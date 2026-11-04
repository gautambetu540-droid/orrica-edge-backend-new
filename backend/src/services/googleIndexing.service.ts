import crypto from 'crypto';

interface IndexingCredentials {
  client_email?: string;
  private_key?: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

const getCredentials = (): IndexingCredentials | null => {
  const jsonEnv = process.env.GOOGLE_INDEXING_CREDENTIALS_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (jsonEnv) {
    try {
      const parsed = JSON.parse(jsonEnv);
      if (parsed.client_email && parsed.private_key) {
        return { client_email: parsed.client_email, private_key: parsed.private_key };
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  const client_email = process.env.GOOGLE_INDEXING_CLIENT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const private_key = process.env.GOOGLE_INDEXING_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY;

  if (client_email && private_key) {
    return {
      client_email,
      private_key: private_key.replace(/\\n/g, '\n'),
    };
  }

  return null;
};

const getAccessToken = async (creds: IndexingCredentials): Promise<string | null> => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  if (!creds.client_email || !creds.private_key) return null;

  try {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claimSet = Buffer.from(
      JSON.stringify({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/indexing',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
      })
    ).toString('base64url');

    const unsignedToken = `${header}.${claimSet}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken);
    const signature = signer.sign(creds.private_key, 'base64url');
    const jwt = `${unsignedToken}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      console.warn('[GOOGLE-INDEXING] Failed to get OAuth token:', res.status, await res.text());
      return null;
    }

    const data: any = await res.json();
    if (data.access_token) {
      cachedToken = {
        token: data.access_token,
        expiresAt: now + (data.expires_in || 3600),
      };
      return data.access_token;
    }
  } catch (err: any) {
    console.warn('[GOOGLE-INDEXING] Token request error:', err?.message || err);
  }

  return null;
};

export const publishGoogleIndexingUrl = async (
  url: string,
  type: 'URL_UPDATED' | 'URL_DELETED'
): Promise<void> => {
  const creds = getCredentials();
  if (!creds) {
    // Graceful silent skip if credentials are not configured yet
    return;
  }

  try {
    const token = await getAccessToken(creds);
    if (!token) return;

    const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url,
        type,
      }),
    });

    if (res.ok) {
      console.log(`[GOOGLE-INDEXING] Successfully submitted ${type} for ${url}`);
    } else {
      console.warn(`[GOOGLE-INDEXING] Notice: ${res.status} when submitting ${url}:`, await res.text());
    }
  } catch (err: any) {
    console.warn(`[GOOGLE-INDEXING] Network warning for ${url}:`, err?.message || err);
  }
};

export const notifyJobUrlUpdated = (slug: string): void => {
  if (!slug) return;
  const baseUrl = process.env.FRONTEND_URL || 'https://www.orricaedge.com';
  const url = `${baseUrl.replace(/\/+$/, '')}/jobs/${slug}`;
  publishGoogleIndexingUrl(url, 'URL_UPDATED').catch(() => {});
};

export const notifyJobUrlDeleted = (slug: string): void => {
  if (!slug) return;
  const baseUrl = process.env.FRONTEND_URL || 'https://www.orricaedge.com';
  const url = `${baseUrl.replace(/\/+$/, '')}/jobs/${slug}`;
  publishGoogleIndexingUrl(url, 'URL_DELETED').catch(() => {});
};

