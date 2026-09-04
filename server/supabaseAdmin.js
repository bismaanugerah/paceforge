/**
 * PaceForge — server/supabaseAdmin.js
 * Thin fetch wrapper around Supabase's PostgREST API, authenticated with the
 * SERVICE ROLE key (full read/write, bypasses Row Level Security).
 *
 * IMPORTANT: SUPABASE_SERVICE_ROLE_KEY must only ever exist as a server-side
 * environment variable — unlike the old Supabase Auth anon key, this key is
 * NOT safe to ship to the browser. Never import this file from js/.
 */

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset di environment variable server.');
  }
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

async function restRequest(path, options = {}) {
  const { url, serviceRoleKey } = getConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase REST ${options.method || 'GET'} ${path} gagal (${res.status}): ${body}`);
  }
  // Some requests (upsert with return=minimal) come back with no body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Returns the single matching row, or null if none exists.
async function selectOne(table, filterColumn, filterValue) {
  const rows = await restRequest(`${table}?${filterColumn}=eq.${encodeURIComponent(filterValue)}&limit=1`, {
    method: 'GET',
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Insert-or-update-on-conflict, keyed by `onConflict` (a primary key column).
// IMPORTANT: `row` must include every NOT NULL column that has no default —
// PostgREST's upsert is a real `INSERT ... ON CONFLICT DO UPDATE`, and
// Postgres validates the INSERT's proposed row (including NOT NULL
// constraints) before it ever gets to the "is there a conflict" check, even
// though only the columns you pass end up in the eventual UPDATE. A partial
// row here can fail on a column you never meant to touch. To patch just a
// few columns on a row you already know exists, use `update` instead.
async function upsert(table, row, onConflict) {
  return restRequest(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
}

// All rows matching filterColumn=filterValue, newest-orderColumn-first,
// capped at `limit` — for an append-only table (plan_history) where every
// row is independent, unlike `selectOne`'s single-row-per-key lookup.
async function selectMany(table, filterColumn, filterValue, orderColumn, limit) {
  const rows = await restRequest(
    `${table}?${filterColumn}=eq.${encodeURIComponent(filterValue)}&order=${orderColumn}.desc&limit=${limit}`,
    { method: 'GET' },
  );
  return Array.isArray(rows) ? rows : [];
}

// Plain INSERT — for an append-only table (plan_history) with no natural
// conflict key to `upsert` onto (every row is its own independent entry,
// unlike `plans`' one-row-per-athlete shape).
async function insert(table, row) {
  return restRequest(table, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
}

// Plain UPDATE of an existing row — unlike `upsert`, `patch` can safely
// contain only the columns you want to change; every other column
// (including NOT NULL ones) is left untouched, no insert-path validation
// involved.
async function update(table, filterColumn, filterValue, patch) {
  return restRequest(`${table}?${filterColumn}=eq.${encodeURIComponent(filterValue)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

module.exports = { selectOne, selectMany, insert, upsert, update };
