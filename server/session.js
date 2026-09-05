/**
 * PaceForge — server/session.js
 * Minimal hand-rolled JWT (HS256) + cookie helpers for the Strava login
 * session. Not an npm dependency on purpose — the rest of this project's
 * server code (api/enhance-plan.js) is zero-dependency plain `fetch`, so
 * this keeps that same footprint instead of adding `jsonwebtoken`.
 *
 * NOT loaded by the browser — only required from files under api/.
 */
const crypto = require('crypto');

const SESSION_COOKIE = 'pf_session';
const STATE_COOKIE = 'pf_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 hari
const STATE_TTL_SECONDS = 60 * 10; // 10 menit — cukup buat satu round-trip OAuth
// Kalender yang sudah di-subscribe akan menarik feed ini berbulan-bulan
// tanpa user pernah membuka PaceForge lagi — TTL sependek session (30
// hari) berarti feed-nya diam-diam mati di tengah blok latihan. Dua tahun
// jauh melebihi umur satu blok latihan mana pun.
const CALENDAR_TTL_SECONDS = 60 * 60 * 24 * 730; // ~2 tahun

// Membedakan token feed kalender (read-only, muncul di URL yang
// ditempel user ke Google/Apple Calendar) dari cookie session login
// (kredensial penuh) — lihat getSession & readCalendarToken di bawah.
const TOKEN_TYPE_SESSION = 'session';
const TOKEN_TYPE_CALENDAR = 'cal';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function getSecret() {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error('SESSION_JWT_SECRET belum diset di environment variable server.');
  return secret;
}

// Sign an arbitrary JSON-serializable payload into a compact HS256 token.
// Caller is responsible for putting an `exp` (unix seconds) in payload.
function sign(payloadObj) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(payloadObj));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verifies signature + expiry, returns the decoded payload or null if the
// token is missing/tampered/expired — callers should treat null exactly
// like "not logged in", never throw on a bad/absent cookie.
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  let expectedSig;
  try {
    expectedSig = crypto.createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest('base64url');
  } catch {
    return null;
  }
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let parsed;
  try { parsed = JSON.parse(base64urlDecode(payload)); } catch { return null; }
  if (typeof parsed.exp !== 'number' || Date.now() / 1000 > parsed.exp) return null;
  return parsed;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// Vercel puts the request behind a proxy — req.connection.encrypted is
// never true there, so HTTPS has to be read from the forwarded-proto
// header. Falls back to the raw socket for other hosting setups.
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.connection?.encrypted;
}

function serializeCookie(name, value, { maxAge, httpOnly = true, secure, sameSite = 'Lax', path = '/' } = {}) {
  let str = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) str += '; HttpOnly';
  if (secure) str += '; Secure';
  if (maxAge != null) str += `; Max-Age=${maxAge}`;
  return str;
}

// --- High-level session helpers (what api/*.js actually calls) ---

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const payload = verify(token);
  if (!payload || !payload.athleteId) return null;
  // Both a login session and a calendar-feed token (see
  // buildCalendarToken) are signed with the same secret and both carry an
  // athleteId — so without this check, pasting a calendar token into the
  // pf_session cookie would log an attacker in as that athlete. A calendar
  // URL is meant to be handed to Google/Apple and is not treated as a
  // password by anyone, so that would be a real escalation from
  // "read one runner's schedule" to "full account access".
  // Sessions issued before this claim existed have no `typ` at all and
  // stay valid; anything that declares a different type is rejected.
  if (payload.typ && payload.typ !== TOKEN_TYPE_SESSION) return null;
  return payload;
}

function buildSessionCookie(req, athlete) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = sign({
    typ: TOKEN_TYPE_SESSION,
    athleteId: athlete.athleteId,
    firstname: athlete.firstname || '',
    lastname: athlete.lastname || '',
    profilePicture: athlete.profilePicture || '',
    exp,
  });
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure: isHttps(req) });
}

function buildLogoutCookie(req) {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(req) });
}

// Short-lived CSRF-protection cookie set right before redirecting the
// browser to Strava's authorize page, and checked again on callback so an
// attacker can't trick a logged-in user into completing a login they never
// started (state-fixation).
function buildStateCookie(req, state) {
  const token = sign({ state, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS });
  return serializeCookie(STATE_COOKIE, token, { maxAge: STATE_TTL_SECONDS, secure: isHttps(req) });
}

function readStateCookie(req) {
  const payload = verify(parseCookies(req)[STATE_COOKIE]);
  return payload ? payload.state : null;
}

function clearStateCookie(req) {
  return serializeCookie(STATE_COOKIE, '', { maxAge: 0, secure: isHttps(req) });
}

// --- Calendar feed tokens (api/calendar.js) ---

// A calendar app fetches the feed with no cookies at all, so the URL
// itself has to carry the identity — a signed, read-only, long-lived
// token naming one athlete. Anyone holding the URL can read that
// runner's training schedule, which is why it grants nothing else (see
// the typ check in getSession) and why it's shown to the user as
// something to keep to themselves.
function buildCalendarToken(athleteId) {
  return sign({
    typ: TOKEN_TYPE_CALENDAR,
    athleteId,
    exp: Math.floor(Date.now() / 1000) + CALENDAR_TTL_SECONDS,
  });
}

// Returns the athleteId the token is for, or null if it's missing,
// tampered with, expired, or is any other kind of token (a login session
// cookie included — the check runs in both directions).
function readCalendarToken(token) {
  const payload = verify(token);
  if (!payload || payload.typ !== TOKEN_TYPE_CALENDAR || !payload.athleteId) return null;
  return payload.athleteId;
}

module.exports = {
  getSession,
  buildCalendarToken,
  readCalendarToken,
  buildSessionCookie,
  buildLogoutCookie,
  buildStateCookie,
  readStateCookie,
  clearStateCookie,
};
