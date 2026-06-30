// Supabase Edge Function: sync-fixtures
// ---------------------------------------------------------------------------
// Server-authoritative source of truth for the prediction game. It mirrors the
// SAME public feeds the client shows (openfootball schedule + worldcup26.ir live
// scores), but server-side, into the `fixtures` table:
//   * kickoff_utc  — used by submit_prediction to LOCK picks at kickoff. The
//                    client's clock is never trusted; this row is.
//   * result/ft    — written once a match is finished, settling predictions.
//
// Only real matchups are stored (group stage now; knockout rows appear once the
// teams resolve) — bracket placeholders like "W74"/"1A"/"3A/B/C" are skipped.
//
// Deploy (needs the service-role key, which is auto-injected as an env var):
//   supabase functions deploy sync-fixtures --no-verify-jwt
// Run it on a schedule (Dashboard → Edge Functions → Schedules, e.g. every 3
// min) and once manually to seed the group-stage fixtures.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Source priority: raw.githubusercontent FIRST (served fresh, max-age=300), with
// jsDelivr as an availability fallback. jsDelivr caches the @master branch ref for
// up to ~12h and ignores our `?cb=` query string, so it can serve a stale snapshot
// that's missing freshly-entered scores — which is exactly what stranded the
// Argentina 3-0 result. We hit raw GitHub first so finished scores settle promptly.
const OPENFOOTBALL_PRIMARY =
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const OPENFOOTBALL_FALLBACK =
  'https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.json';
const LIVE = 'https://worldcup26.ir/get/games';

/** Fetch the openfootball schedule fresh, falling back to the jsDelivr CDN. */
async function fetchOpenfootball(): Promise<Response> {
  const cb = `?cb=${Math.floor(Date.now() / 300_000)}`;
  try {
    const r = await fetch(`${OPENFOOTBALL_PRIMARY}${cb}`);
    if (r.ok) return r;
  } catch {
    /* primary unreachable → fall through to CDN */
  }
  return fetch(`${OPENFOOTBALL_FALLBACK}${cb}`);
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Match {
  round: string;
  date: string;
  time: string;
  team1: string;
  team2: string;
  group?: string;
  // et = aggregate after extra time, p = penalty shootout (knockouts only).
  score?: { ft?: [number, number]; et?: [number, number]; p?: [number, number] };
}

/** Canonical team token: lowercase, diacritic-free, alphanumeric only. */
function canon(name: string): string {
  const k = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
  const alias: Record<string, string> = { unitedstates: 'usa' };
  return alias[k] ?? k;
}

/** Stable match key — MUST mirror matchKey() in src/lib/predictions.ts. */
function matchKey(m: Match): string {
  return `${m.date}|${canon(m.team1)}|${canon(m.team2)}`;
}

/** True for an actual matchup; false for bracket placeholders (1A, W74, 3A/B…). */
function isRealTeam(name: string): boolean {
  return /[a-z]/i.test(name) && !/^\d/.test(name) && !/^[wl]\d+$/i.test(name) &&
    !name.includes('/');
}

/** Kick-off epoch (ms) from openfootball's "13:00 UTC-6" form. Null if unparsable. */
function kickoffMs(m: Match): number | null {
  const t = /^(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})?/.exec(m.time);
  if (!t) return null;
  const [, hh, mm, off] = t;
  const offset = off ? Number(off) : 0;
  const [y, mo, d] = m.date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, Number(hh) - offset, Number(mm));
}

interface RawGame {
  home_team_name_en: string;
  away_team_name_en: string;
  home_score: string;
  away_score: string;
  finished: string;
}

/** Finished-score map from the live feed, keyed by unordered canon pair. */
async function liveFinished(): Promise<Map<string, [number, number]>> {
  const out = new Map<string, [number, number]>();
  try {
    const r = await fetch(LIVE, { headers: { accept: 'application/json' } });
    if (!r.ok) return out;
    const data = (await r.json()) as { games?: RawGame[] };
    for (const g of data.games ?? []) {
      if (g.finished !== 'TRUE' || !g.home_team_name_en || !g.away_team_name_en) continue;
      const hs = Number(g.home_score) || 0;
      const as = Number(g.away_score) || 0;
      // The live feed reports a placeholder 0-0 for matches it has marked
      // finished but hasn't got the real score for yet, so a 0-0 here is more
      // likely "score unknown" than a genuine goalless draw. Don't settle on
      // it — leave the match open and let openfootball (authoritative, and the
      // only source that can confirm a real 0-0) fill it in.
      if (hs === 0 && as === 0) continue;
      const key = [canon(g.home_team_name_en), canon(g.away_team_name_en)].sort().join('|');
      out.set(key, [hs, as]);
      // Store oriented-by-home too, so we can re-orient to team1/team2 below.
      out.set(`home:${canon(g.home_team_name_en)}|${canon(g.away_team_name_en)}`, [hs, as]);
    }
  } catch {
    /* feed down → settle only what openfootball already has */
  }
  return out;
}

/** Final score for a match: openfootball if present, else the live feed. */
function finalScore(m: Match, live: Map<string, [number, number]>): [number, number] | null {
  if (Array.isArray(m.score?.ft)) return m.score!.ft!;
  const homeKey = `home:${canon(m.team1)}|${canon(m.team2)}`;
  if (live.has(homeKey)) return live.get(homeKey)!;
  const awayKey = `home:${canon(m.team2)}|${canon(m.team1)}`;
  if (live.has(awayKey)) {
    const [h, a] = live.get(awayKey)!; // feed had them reversed → flip
    return [a, h];
  }
  return null;
}

function outcome(ft: [number, number]): '1' | 'X' | '2' {
  return ft[0] > ft[1] ? '1' : ft[0] < ft[1] ? '2' : 'X';
}

/**
 * Who advanced from a knockout tie: '1' = team1, '2' = team2, or null if not yet
 * decided. Penalties have the final say, then the after-extra-time aggregate,
 * then 90'. Mirrors winningSide() in src/lib/worldcup.ts. A tie level after 90'
 * with no shootout recorded stays open (the live feed can't report penalties).
 */
function koWinner(m: Match): '1' | '2' | null {
  const s = m.score;
  if (!s?.ft) return null;
  const [a, b] = s.p ?? s.et ?? s.ft;
  if (a === b) return null;
  return a > b ? '1' : '2';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [mres, live, settledRes] = await Promise.all([
      fetchOpenfootball(),
      liveFinished(),
      // Already-settled results, so a flaky feed can't wipe a known final score.
      supabase.from('fixtures').select('match_key, ft, result').not('ft', 'is', null),
    ]);
    if (!mres.ok) throw new Error(`openfootball ${mres.status}`);
    const matches = ((await mres.json()) as { matches: Match[] }).matches;

    // Sticky results: once a match has a final score in the table, never let a
    // later run overwrite it with null. Both upstreams are flaky (openfootball
    // lags hours; the live feed intermittently drops finished games or fails to
    // connect), and a blank run upserting null over a settled row is what made
    // results flicker in and out server-side. So we only ever *add* a result.
    const settled = new Map<string, { ft: [number, number]; result: string | null }>();
    for (const r of settledRes.data ?? []) {
      if (Array.isArray(r.ft)) settled.set(r.match_key, { ft: r.ft as [number, number], result: r.result });
    }

    const rows = [];
    for (const m of matches) {
      if (!isRealTeam(m.team1) || !isRealTeam(m.team2)) continue;
      const k = kickoffMs(m);
      if (k == null) continue;
      const key = matchKey(m);
      const fresh = finalScore(m, live);
      // Prefer a fresh final (so corrections still land); fall back to the
      // already-settled value rather than blanking it.
      const ft = fresh ?? settled.get(key)?.ft ?? null;
      // Group games settle on the 90' result (1/X/2). Knockouts settle on who
      // actually advanced — extra time and penalties included — so a 1-1 won on
      // penalties resolves to the shootout winner, never 'X'. A level knockout
      // with no et/p yet stays open until openfootball fills the shootout in.
      const result = m.group
        ? ft
          ? outcome(ft)
          : null
        : koWinner(m) ?? (ft && ft[0] !== ft[1] ? outcome(ft) : null);
      rows.push({
        match_key: key,
        team1: m.team1,
        team2: m.team2,
        kickoff_utc: new Date(k).toISOString(),
        round: m.round,
        grp: m.group ?? null,
        result,
        ft: ft ?? null,
        updated_at: new Date().toISOString(),
      });
    }

    const { error } = await supabase.from('fixtures').upsert(rows, { onConflict: 'match_key' });
    if (error) throw error;

    return new Response(
      JSON.stringify({ ok: true, upserted: rows.length, settled: rows.filter((r) => r.result).length }),
      { headers: { ...cors, 'content-type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { ...cors, 'content-type': 'application/json' },
    });
  }
});
