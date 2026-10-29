'use strict';
// "Sign in with Google" — OpenID Connect authorization-code flow with PKCE, state and nonce.
// No library: the id_token (RS256) is verified with Google's published JWKS via node:crypto.
// Only the Google subject id ("sub") and the verified e-mail are used; no Google access token is kept.
const crypto = require('node:crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
// Google-only accounts get a password hash that can never verify (auth.verifyPassword requires "scrypt$").
const NO_PASSWORD = 'none$google';
const hasPassword = (passHash) => String(passHash || '').startsWith('scrypt$');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function newFlow() {
  const verifier = b64url(crypto.randomBytes(32));
  return { state: b64url(crypto.randomBytes(24)), nonce: b64url(crypto.randomBytes(24)), verifier,
    challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
function authUrl({ clientId, redirectUri, state, nonce, challenge }) {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  return `${AUTH_URL}?${p}`;
}

async function exchangeCode({ code, verifier, clientId, clientSecret, redirectUri, fetchImpl }) {
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString() });
  if (!res.ok) throw new Error('token exchange failed');
  const j = await res.json();
  if (!j || typeof j.id_token !== 'string') throw new Error('no id_token');
  return j.id_token;
}

function jwksCache(fetchImpl, nowMs = () => Date.now()) {
  let keys = null; let at = 0;
  const load = async () => {
    const res = await fetchImpl(JWKS_URL);
    if (!res.ok) throw new Error('jwks fetch failed');
    keys = (await res.json()).keys || []; at = nowMs();
  };
  return async (kid) => {
    if (!keys || nowMs() - at > 3600000) await load();
    let k = keys.find((x) => x.kid === kid);
    if (!k && nowMs() - at > 60000) { await load(); k = keys.find((x) => x.kid === kid); } // key rotation
    return k || null;
  };
}

async function verifyIdToken(idToken, { clientId, nonce, getKey, nowSec = () => Math.floor(Date.now() / 1000) }) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new Error('malformed token'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected algorithm');
  const jwk = await getKey(header.kid);
  if (!jwk || jwk.kty !== 'RSA') throw new Error('unknown key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = nowSec();
  if (!ISSUERS.includes(claims.iss)) throw new Error('bad issuer');
  if (claims.aud !== clientId && !(Array.isArray(claims.aud) && claims.aud.includes(clientId))) throw new Error('bad audience');
  if (!(claims.exp > now - 60)) throw new Error('expired');
  if (claims.iat && claims.iat > now + 300) throw new Error('issued in the future');
  if (!nonce || claims.nonce !== nonce) throw new Error('bad nonce');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('email not verified');
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') throw new Error('missing claims');
  return { sub: claims.sub, email: claims.email.trim().toLowerCase() };
}

// Finds or creates the local account. deps: { startTrial(userId) }
function signIn(db, { sub, email }, deps) {
  const linked = db.identity('google', sub);
  if (linked) return { userId: linked.user_id, created: false };
  if (email.length > 254) return { error: 'EMAIL' };
  return db.transaction(() => {
    const u = db.userByEmail(email);
    if (u) {
      // Google has verified the address. If this account never proved it owns the address, someone else may
      // have registered it first: their password and sessions are cancelled before linking (account takeover guard).
      if (!db.emailVerifiedAt(u.id)) { db.setPassword(u.id, NO_PASSWORD); db.deleteSessionsFor(u.id); }
      db.linkIdentity('google', sub, u.id);
      db.setEmailVerified(u.id);
      return { userId: u.id, created: false, linked: true };
    }
    const id = Number(db.createUser(email, NO_PASSWORD));
    db.linkIdentity('google', sub, id);
    db.setEmailVerified(id);
    deps.startTrial(id);
    return { userId: id, created: true };
  });
}

module.exports = { newFlow, authUrl, exchangeCode, jwksCache, verifyIdToken, signIn, hasPassword, NO_PASSWORD, ISSUERS, TOKEN_URL, JWKS_URL };
