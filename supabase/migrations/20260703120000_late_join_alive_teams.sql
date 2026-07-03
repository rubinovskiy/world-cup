-- ===========================================================================
-- Migration: late joiners only get teams still alive in the tournament,
-- ranked by the CURRENT bookmaker title-win odds (team_odds), plus a
-- read-only preview RPC so the UI can warn a late joiner about their real
-- chances before registering.
--
-- Why: by the knockout rounds some pool teams are out (e.g. Uruguay never
-- reached the R32; Japan/Germany/... lost their ties). The old join_lobby
-- walked config.teams in pre-tournament order, so a late joiner could be
-- handed an already-eliminated team. Elimination is derived from the
-- `fixtures` table (sync-fixtures settles knockout ties by who advanced,
-- ET/penalties included) — NOT from team_odds, whose rows go stale for
-- eliminated teams (bookmakers just drop them from the outright market).
--
-- Additive, forward-only: two new helper functions + one new RPC; join_lobby
-- is replaced in-place (same signature/behaviour except the late-join pick).
-- No tables or data are touched. Safe to run multiple times.
-- ===========================================================================

-- --- team_alive -------------------------------------------------------------
-- Is a team still in the tournament? Alive means: it appears in the knockout
-- bracket and hasn't lost a settled knockout tie. Knockout rows only exist in
-- `fixtures` once real teams resolve (sync-fixtures skips placeholders), so:
--   * no knockout rows at all yet (group stage) → everyone counts as alive
--     (group-standings math is deliberately not modelled — moot once the
--     bracket exists);
--   * bracket known, team absent from it → out at the group stage;
--   * result = '1'/'2' on a knockout row = who ADVANCED (ET/pens resolved by
--     sync-fixtures), so the other side is out. A level tie with the shootout
--     not yet recorded keeps both teams alive until it settles.
-- Internal helper — intentionally not granted to anon (callers are the
-- SECURITY DEFINER functions below), though it only reads public data.

create or replace function public.team_alive(p_team text)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    not exists (select 1 from fixtures where grp is null)
    or (
      exists (
        select 1 from fixtures k
        where k.grp is null and (k.team1 = p_team or k.team2 = p_team)
      )
      and not exists (
        select 1 from fixtures k
        where k.grp is null
          and ((k.result = '1' and k.team2 = p_team)
            or (k.result = '2' and k.team1 = p_team))
      )
    );
$$;

-- --- next_late_team ---------------------------------------------------------
-- The team a late joiner would receive RIGHT NOW: the strongest pool team that
-- is unassigned AND still alive, ranked by the current bookmaker title-win
-- odds (the same team_odds numbers the Lobby chart shows). Teams missing from
-- team_odds sort last, by the original pool order — so the pick still works
-- before the first odds sync. Empty result = nothing left to hand out.
-- Shared by join_lobby (the actual pick) and late_join_preview (the warning
-- pop-up), so the number the user confirms is the rule the server applies.

create or replace function public.next_late_team()
returns table (team text, prob real)
language sql
stable
set search_path = public
as $$
  select t.team, o.prob
  from config c
  cross join unnest(c.teams) with ordinality as t(team, rank)
  left join team_odds o on o.team = t.team
  where c.id = 1
    and t.team not in (select a.team from assignments a)
    and public.team_alive(t.team)
  order by o.prob desc nulls last, t.rank
  limit 1;
$$;

-- --- join_lobby (replace) ---------------------------------------------------
-- Same as before (name/capacity/dedupe rules untouched), EXCEPT the late-join
-- pick now comes from next_late_team(): eliminated teams are skipped and
-- "best available" means best by current bookmaker odds, not by the
-- pre-tournament ranking.

create or replace function public.join_lobby(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_key   text := lower(v_name);
  v_max   int;
  v_drawn boolean;
  v_count int;
  v_team  text;
  v_id    uuid;
begin
  if v_name = '' then
    raise exception 'EMPTY_NAME' using hint = 'Please enter your name.';
  end if;

  select max_players, drawn into v_max, v_drawn from config where id = 1;
  if v_max is null then
    raise exception 'NO_CONFIG' using hint = 'Game is not configured yet.';
  end if;

  select count(*) into v_count from players;
  if v_count >= v_max then
    raise exception 'LOBBY_FULL' using hint = 'The lobby is full.';
  end if;

  if exists (select 1 from players where name_key = v_key) then
    raise exception 'DUPLICATE_NAME' using hint = 'That name is already taken.';
  end if;

  -- Late joiner (keyed off the draw flag, not assignment existence — ultra
  -- players hold assignments before the main draw runs). Picked before the
  -- insert so a clean error if nothing remains.
  if v_drawn then
    select nlt.team into v_team from public.next_late_team() nlt;

    if v_team is null then
      raise exception 'NO_TEAMS_LEFT'
        using hint = 'Every team still in the tournament is already taken.';
    end if;
  end if;

  insert into players (name, name_key) values (v_name, v_key) returning id into v_id;

  if v_drawn then
    insert into assignments (player_id, team) values (v_id, v_team);
  end if;

  return v_id;
end;
$$;

-- --- late_join_preview ------------------------------------------------------
-- Read-only: what a late joiner is signing up for, BEFORE they commit. Returns
--   team / prob        — the team they'd receive right now + its current
--                        bookmaker title-win prob (0..1; null until the first
--                        odds sync). team = null → nothing left (the join
--                        would fail with NO_TEAMS_LEFT).
--   top_team / top_prob — the strongest still-alive team already held by a
--                        player (the "top-1" they'd compete against).
-- The UI shows the two percentages and only calls join_lobby if the user
-- confirms. Everything here is derivable from anon-readable tables
-- (assignments/team_odds/fixtures) — SECURITY DEFINER is only needed to read
-- config.teams (config also holds the passcode, which is never exposed).

create or replace function public.late_join_preview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_team     text;
  v_prob     real;
  v_top_team text;
  v_top_prob real;
begin
  select nlt.team, nlt.prob into v_team, v_prob from public.next_late_team() nlt;

  select a.team, o.prob into v_top_team, v_top_prob
  from assignments a
  left join team_odds o on o.team = a.team
  where public.team_alive(a.team)
  order by o.prob desc nulls last
  limit 1;

  return json_build_object(
    'team', v_team,
    'prob', v_prob,
    'top_team', v_top_team,
    'top_prob', v_top_prob
  );
end;
$$;

-- --- Grants -----------------------------------------------------------------
grant execute on function public.join_lobby(text)    to anon;
grant execute on function public.late_join_preview() to anon;
-- team_alive / next_late_team stay ungranted (internal helpers).
