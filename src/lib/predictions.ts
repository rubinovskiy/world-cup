// Client side of the match-prediction game. Identity is a name + 4-digit PIN
// (claimed once per device and cached in localStorage). Picks are 1 / X / 2 and
// are public. The server (submit_prediction + the fixtures table) is what locks
// picks at kickoff and settles them — this module is just typed plumbing.

import { supabase } from './supabase';
import { canon } from './live';
import { Match } from './worldcup';

/** Stable match key — MUST mirror matchKey() in supabase/functions/sync-fixtures. */
export function matchKey(m: Match): string {
  return `${m.date}|${canon(m.team1)}|${canon(m.team2)}`;
}

export type Pick = '1' | 'X' | '2';

/** A row from the server-authoritative fixtures table. */
export interface Fixture {
  match_key: string;
  team1: string;
  team2: string;
  kickoff_utc: string;
  round: string;
  grp: string | null;
  result: Pick | null;
  ft: [number, number] | null;
  // Win probabilities from bookmaker odds (proportionally normalised so they sum
  // to 1). Populated daily by the sync-odds Edge Function; null until a line is
  // posted, or for matches no book covers.
  p1: number | null; // P(team1 win)
  px: number | null; // P(draw)
  p2: number | null; // P(team2 win)
  odds_updated_at: string | null;
}

export interface PredictionRow {
  player_id: string;
  match_key: string;
  pick: Pick;
}

export interface LeaderboardRow {
  player_id: string;
  name: string;
  settled: number;
  points: number;
  picks: number;
}

// --- Identity (cached so name + PIN are entered once per device) ------------
// The PIN is cached locally too, so a returning friend can keep picking without
// re-typing it. It's a 4-digit code for a friends game and the bcrypt hash stays
// server-side — the local copy only re-authorises this same device.
const ID_KEY = 'wc26_player_id';   // shared with the lottery (same player row)
const NAME_KEY = 'wc26_player_name';
const PIN_KEY = 'wc26_player_pin';

export interface Identity {
  id: string;
  name: string;
  pin: string;
}

export function loadIdentity(): Identity | null {
  const id = localStorage.getItem(ID_KEY);
  const name = localStorage.getItem(NAME_KEY);
  const pin = localStorage.getItem(PIN_KEY);
  return id && name && pin ? { id, name, pin } : null;
}

export function storeIdentity(idy: Identity): void {
  localStorage.setItem(ID_KEY, idy.id);
  localStorage.setItem(NAME_KEY, idy.name);
  localStorage.setItem(PIN_KEY, idy.pin);
}

export function clearIdentity(): void {
  localStorage.removeItem(ID_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(PIN_KEY);
}

/** Set a PIN (first time) or log in with name + PIN. Caches the identity. */
export async function claimPlayer(name: string, pin: string): Promise<Identity> {
  const { data, error } = await supabase.rpc('claim_player', { p_name: name, p_pin: pin });
  if (error) throw new Error(error.message);
  const idy = { id: data as string, name: name.trim(), pin };
  storeIdentity(idy);
  return idy;
}

/** Submit (or change) a 1/X/2 pick. Server rejects if the match has kicked off. */
export async function submitPrediction(idy: Identity, match_key: string, pick: Pick): Promise<void> {
  const { error } = await supabase.rpc('submit_prediction', {
    p_name: idy.name,
    p_pin: idy.pin,
    p_match_key: match_key,
    p_pick: pick,
  });
  if (error) throw new Error(error.message);
}

// --- Public reads -----------------------------------------------------------
export async function getFixtures(): Promise<Map<string, Fixture>> {
  const { data } = await supabase
    .from('fixtures')
    .select('match_key,team1,team2,kickoff_utc,round,grp,result,ft,p1,px,p2,odds_updated_at');
  const idx = new Map<string, Fixture>();
  for (const f of (data as Fixture[]) ?? []) idx.set(f.match_key, f);
  return idx;
}

/** All picks, grouped by match_key (picks are public). */
export async function getPredictions(): Promise<Map<string, PredictionRow[]>> {
  const { data } = await supabase.from('predictions').select('player_id,match_key,pick');
  const idx = new Map<string, PredictionRow[]>();
  for (const p of (data as PredictionRow[]) ?? []) {
    const arr = idx.get(p.match_key) ?? [];
    arr.push(p);
    idx.set(p.match_key, arr);
  }
  return idx;
}

/** Hit rate = correct / settled. Players with nothing settled sort last (−1). */
export function accuracy(r: LeaderboardRow): number {
  return r.settled > 0 ? r.points / r.settled : -1;
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const { data } = await supabase
    .from('prediction_leaderboard')
    .select('player_id,name,settled,points,picks');
  // Rank by accuracy; break ties by volume (more settled, then more points) so a
  // perfect 5/5 outranks a perfect 1/1, then alphabetically.
  return ((data as LeaderboardRow[]) ?? []).sort(
    (a, b) =>
      accuracy(b) - accuracy(a) ||
      b.settled - a.settled ||
      b.points - a.points ||
      a.name.localeCompare(b.name),
  );
}

/** id → name, for showing who picked what. */
export async function getPlayerNames(): Promise<Map<string, string>> {
  const { data } = await supabase.from('players').select('id,name');
  return new Map(((data as { id: string; name: string }[]) ?? []).map((p) => [p.id, p.name]));
}

/** Friendly text for the error codes raised by the prediction RPCs. */
export function predictionError(message: string): string {
  const map: Record<string, string> = {
    EMPTY_NAME: 'Введи имя.',
    WEAK_PIN: 'PIN — ровно 4 цифры.',
    BAD_PIN: 'Неверный PIN для этого имени.',
    NO_PLAYER: 'Такого имени нет — сначала задай PIN.',
    NO_PIN: 'Для этого имени ещё не задан PIN.',
    NO_MATCH: 'Матч не найден.',
    LOCKED: '⏱️ Матч уже начался — ставки закрыты.',
    ALREADY_PICKED: 'Прогноз на этот матч уже сделан — менять нельзя.',
    BAD_PICK: 'Выбери 1, X или 2.',
  };
  for (const code of Object.keys(map)) if (message.includes(code)) return map[code];
  return message;
}
