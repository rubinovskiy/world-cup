import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMatches,
  getFlagMap,
  refreshMatches,
  stageLabel,
  kickoffMs,
  displayScore,
  Match,
} from '../lib/worldcup';
import { liveFor, LiveIndex } from '../lib/live';
import { useClock, useLiveScores } from '../lib/useLive';
import { formatKickoff, useTimezone, ymdInZone } from '../lib/timezone';
import { TimezonePicker } from '../components/TimezonePicker';
import { WinChances } from '../components/WinChances';
import {
  claimPlayer,
  clearIdentity,
  getFixtures,
  getLeaderboard,
  getPlayerNames,
  getPredictions,
  loadIdentity,
  matchKey,
  predictionError,
  submitPrediction,
  Fixture,
  Identity,
  LeaderboardRow,
  Pick,
  PredictionRow,
} from '../lib/predictions';

/** Russian plural: plural(2,'прогноз','прогноза','прогнозов') → 'прогноза'. */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** Prediction game: guess the outcome of each match, public picks + leaderboard. */
export function Predict() {
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [flags, setFlags] = useState<Map<string, string>>(new Map());
  const [fixtures, setFixtures] = useState<Map<string, Fixture>>(new Map());
  const [preds, setPreds] = useState<Map<string, PredictionRow[]>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [board, setBoard] = useState<LeaderboardRow[]>([]);
  const [me, setMe] = useState<Identity | null>(() => loadIdentity());
  const now = useClock(60_000);
  const liveIdx = useLiveScores();
  const [tz] = useTimezone();

  // Reload the prediction data (fixtures/picks/leaderboard) after each pick.
  const reload = () => {
    Promise.all([getFixtures(), getPredictions(), getLeaderboard(), getPlayerNames()])
      .then(([f, p, b, n]) => {
        setFixtures(f);
        setPreds(p);
        setBoard(b);
        setNames(n);
      })
      .catch(() => {});
  };

  useEffect(() => {
    let alive = true;
    getFlagMap().then((f) => alive && setFlags(f)).catch(() => {});
    const load = (refresh = false) =>
      (refresh ? refreshMatches() : getMatches())
        .then((m) => alive && setMatches(m))
        .catch(() => {});
    load();
    reload();
    const id = setInterval(() => {
      load(true);
      reload();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Like the home board: only today & tomorrow (in the viewer's zone), and only
  // matches the server knows about (a fixture row = a kickoff lock).
  const days = useMemo(() => {
    const todayStr = ymdInZone(now, tz);
    const tomorrowStr = ymdInZone(now + 86_400_000, tz);
    const dayOf = (m: Match) => {
      const k = kickoffMs(m);
      return k == null ? m.date : ymdInZone(k, tz);
    };
    const inDay = (ymd: string) =>
      (matches ?? [])
        .filter((m) => fixtures.has(matchKey(m)) && dayOf(m) === ymd)
        .sort((a, b) => (kickoffMs(a) ?? 0) - (kickoffMs(b) ?? 0));
    return [
      ['Сегодня', todayStr, inDay(todayStr)] as const,
      ['Завтра', tomorrowStr, inDay(tomorrowStr)] as const,
    ].filter(([, , ms]) => ms.length > 0);
  }, [matches, fixtures, now, tz]);

  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <Link className="back" to="/">← В лотерею</Link>
          <h1>🔮 Прогнозы матчей</h1>
          <p className="muted">
            Угадай исход каждого матча — победа одной из команд или ничья. За
            угаданный результат — очко. Ставки закрываются в момент стартового свистка,
            до него выбор можно менять.
          </p>
        </header>

        <IdentityBar me={me} onLogin={setMe} onLogout={() => { clearIdentity(); setMe(null); }} />

        <Leaderboard board={board} meId={me?.id} />

        <section className="card">
          <div className="today-head">
            <h2>📅 Матчи</h2>
            <TimezonePicker />
          </div>
          {!matches ? (
            <p className="muted">Загрузка…</p>
          ) : days.length === 0 ? (
            <p className="muted small">
              Сегодня и завтра матчей нет. Загляни позже — прогнозы открываются по
              мере приближения игр.
            </p>
          ) : (
            days.map(([title, ymd, ms]) => (
              <DayBlock
                key={ymd}
                title={title}
                ymd={ymd}
                matches={ms}
                fixtures={fixtures}
                preds={preds}
                names={names}
                flags={flags}
                liveIdx={liveIdx}
                now={now}
                tz={tz}
                me={me}
                onPicked={reload}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

// --- Identity bar -----------------------------------------------------------
function IdentityBar({
  me,
  onLogin,
  onLogout,
}: {
  me: Identity | null;
  onLogin: (idy: Identity) => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) {
    return (
      <div className="card pred-id">
        <span>Ты играешь как <strong>{me.name}</strong></span>
        <button className="link" onClick={onLogout}>сменить игрока</button>
      </div>
    );
  }

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      onLogin(await claimPlayer(name, pin));
    } catch (e) {
      setErr(predictionError((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card pred-login">
      <p className="muted small">
        Войди именем и 4-значным PIN. Первый раз — PIN задаётся, потом он же тебя
        пускает (и защищает твои прогнозы от чужих рук).
      </p>
      <div className="signup">
        <input
          placeholder="Имя"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
        />
        <input
          placeholder="PIN (4 цифры)"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          maxLength={4}
        />
        <button onClick={submit} disabled={busy || !name.trim() || pin.length !== 4}>
          Войти
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// --- Leaderboard ------------------------------------------------------------
function Leaderboard({ board, meId }: { board: LeaderboardRow[]; meId?: string }) {
  const anySettled = board.some((r) => r.settled > 0);

  return (
    <section className="card">
      <h2>🏅 Таблица прогнозистов</h2>
      {board.length === 0 ? (
        <p className="muted small">
          Пока никто не сделал прогноз. Поставь на матчи ниже — и сюда подтянутся
          очки (по 1 за угаданный исход).
        </p>
      ) : !anySettled ? (
        // Nothing settled yet → reward participation, not raw pick count ordering.
        <>
          <ul className="pred-board participation">
            {[...board]
              .sort((a, b) => b.picks - a.picks || a.name.localeCompare(b.name))
              .map((r) => (
                <li key={r.player_id} className={`pb-row ${r.player_id === meId ? 'me' : ''}`}>
                  <span className="pb-name">{r.name}</span>
                  <span className="pb-num">
                    {r.picks} {plural(r.picks, 'прогноз', 'прогноза', 'прогнозов')}
                  </span>
                </li>
              ))}
          </ul>
          <p className="muted small">🏁 Очки появятся после первых сыгранных матчей.</p>
        </>
      ) : (
        <ul className="pred-board results">
          <li className="pb-head">
            <span className="pb-rank">#</span>
            <span className="pb-name">Игрок</span>
            <span className="pb-num" title="Очки за угаданные исходы">Очки</span>
            <span className="pb-acc" title="Доля угаданных из сыгранных">Точность</span>
            <span className="pb-guessed" title="Угадано из сыгранных матчей">Угадано</span>
          </li>
          {board.map((r, i) => (
            <li key={r.player_id} className={`pb-row ${r.player_id === meId ? 'me' : ''}`}>
              <span className="pb-rank">{i + 1}</span>
              <span className="pb-name">{r.name}</span>
              <span className="pb-num pb-pts">{r.points}</span>
              <span className="pb-acc">
                {r.settled > 0 ? `${Math.round((r.points / r.settled) * 100)}%` : '—'}
              </span>
              <span className="pb-guessed">
                {r.settled > 0 ? `${r.points} из ${r.settled}` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- A day's matches --------------------------------------------------------
function DayBlock({
  title,
  ymd,
  matches,
  fixtures,
  preds,
  names,
  flags,
  liveIdx,
  now,
  tz,
  me,
  onPicked,
}: {
  title: string;
  ymd: string;
  matches: Match[];
  fixtures: Map<string, Fixture>;
  preds: Map<string, PredictionRow[]>;
  names: Map<string, string>;
  flags: Map<string, string>;
  liveIdx: LiveIndex;
  now: number;
  tz: string;
  me: Identity | null;
  onPicked: () => void;
}) {
  const label = new Date(ymd + 'T12:00:00Z').toLocaleDateString('ru-RU', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div className="day-block">
      <div className="day-head">
        <span className="day-title">{title}</span>
        <span className="day-sub">{label}</span>
      </div>
      <ul className="fixtures">
        {matches.map((m) => (
          <PredictRow
            key={matchKey(m)}
            m={m}
            fixture={fixtures.get(matchKey(m))!}
            picks={preds.get(matchKey(m)) ?? []}
            names={names}
            flags={flags}
            liveIdx={liveIdx}
            now={now}
            tz={tz}
            me={me}
            onPicked={onPicked}
          />
        ))}
      </ul>
    </div>
  );
}

// --- One match row with the 1 / X / 2 controls ------------------------------
function PredictRow({
  m,
  fixture,
  picks,
  names,
  flags,
  liveIdx,
  now,
  tz,
  me,
  onPicked,
}: {
  m: Match;
  fixture: Fixture;
  picks: PredictionRow[];
  names: Map<string, string>;
  flags: Map<string, string>;
  liveIdx: LiveIndex;
  now: number;
  tz: string;
  me: Identity | null;
  onPicked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const kickoff = Date.parse(fixture.kickoff_utc);
  const locked = now >= kickoff;
  const info = liveFor(m, liveIdx);
  const isLive = locked && !fixture.result && info?.phase === 'live';
  // Knockout rounds can't end level — offer "who goes through" (2 buttons), not
  // 1 / X / 2. Group games keep win · draw · win.
  const isKnockout = !m.group;
  const options: { pick: Pick; cap: string; team?: string }[] = isKnockout
    ? [
        { pick: '1', cap: 'Проход', team: m.team1 },
        { pick: '2', cap: 'Проход', team: m.team2 },
      ]
    : [
        { pick: '1', cap: 'Победа', team: m.team1 },
        { pick: 'X', cap: 'Ничья' },
        { pick: '2', cap: 'Победа', team: m.team2 },
      ];

  // Extra-time / penalty detail for finished knockouts, so a 1–1 won on penalties
  // doesn't read as an unresolved draw.
  const ds = !isLive && m.score?.ft ? displayScore(m) : null;
  const ft = fixture.ft ?? (isLive ? info?.ft : ds?.ft);

  const myPick = me ? picks.find((p) => p.player_id === me.id)?.pick : undefined;
  const tally = (p: Pick) => picks.filter((x) => x.pick === p);
  const total = picks.length;
  const maxVotes = Math.max(0, ...options.map((o) => tally(o.pick).length));

  // Editable until kickoff: clicking another option just updates the pick.
  const choose = async (pick: Pick) => {
    if (!me || locked || busy || pick === myPick) return;
    setErr(null);
    setBusy(true);
    try {
      await submitPrediction(me, fixture.match_key, pick);
      onPicked();
    } catch (e) {
      setErr(predictionError((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const side = (name: string) => (
    <span className="fx-team">
      <span className="fx-flag">{flags.get(name) ?? '·'}</span>
      <span className="fx-name">{name}</span>
    </span>
  );

  return (
    <li className={`pred-card ${isLive ? 'live' : ''} ${locked ? 'locked' : ''}`}>
      <div className="pred-top">
        <span className="pred-when">
          {fixture.result ? 'Завершён' : isLive ? (
            <span className="badge live"><span className="live-dot" /> LIVE</span>
          ) : (
            formatKickoff(kickoff, tz, m.time)
          )}
        </span>
        <span className="pred-stage">{stageLabel(m)}</span>
      </div>

      <div className="pred-teams">
        {side(m.team1)}
        <span className="fx-score">
          {ft ? `${ft[0]}–${ft[1]}` : ':'}
          {ds?.pens ? (
            <span className="score-extra"> ({ds.pens[0]}–{ds.pens[1]} pen)</span>
          ) : ds?.aet ? (
            <span className="score-extra"> a.e.t.</span>
          ) : null}
        </span>
        {side(m.team2)}
      </div>

      {!fixture.result && (
        <WinChances
          className="pred-odds"
          team1={m.team1}
          team2={m.team2}
          p1={fixture.p1}
          px={fixture.px}
          p2={fixture.p2}
          flags={flags}
        />
      )}

      <div className={`pred-choices ${options.length === 2 ? 'two' : ''}`}>
        {options.map(({ pick, cap, team }) => {
          const voters = tally(pick);
          const isWin = fixture.result === pick;
          const mine = myPick === pick;
          const pct = total ? Math.round((voters.length / total) * 100) : 0;
          // The crowd favourite glows brightest (only meaningful with votes and
          // before the result is in).
          const lead = total > 0 && !fixture.result && voters.length === maxVotes && maxVotes > 0;
          return (
            <button
              key={pick}
              className={`pred-opt ${mine ? 'mine' : ''} ${isWin ? 'win' : ''} ${lead ? 'lead' : ''}`}
              onClick={() => choose(pick)}
              disabled={!me || locked || busy}
              title={voters.map((v) => names.get(v.player_id) ?? '?').join(', ') || 'пока никто'}
            >
              {!fixture.result && <span className="po-fill" style={{ width: `${pct}%` }} />}
              <span className="po-cap">{cap}</span>
              {team && (
                <span className="po-team">
                  <span className="po-flag">{flags.get(team) ?? '⚽'}</span>
                  {team}
                </span>
              )}
              <span className="po-pct">{pct}%</span>
              {mine && <span className="po-mark">{isWin ? '✓' : fixture.result ? '✗' : '✓ твой'}</span>}
            </button>
          );
        })}
      </div>

      {!me && <p className="muted small pred-hint">Войди именем и PIN выше, чтобы голосовать.</p>}
      {me && !locked && !myPick && <p className="muted small pred-hint">Выбери исход — можно менять до начала матча.</p>}
      {total > 0 && <p className="muted small pred-voted">Проголосовали: {total}</p>}
      {err && <p className="error small">{err}</p>}
    </li>
  );
}
