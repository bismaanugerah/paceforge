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
async function upsert(table, row, onConflict) {
  return restRequest(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
}

module.exports = { selectOne, upsert };
