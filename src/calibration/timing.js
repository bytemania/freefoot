// 15-minute timing buckets (calibration, report-only). One mapping serves both sides: the
// benchmark (StatsBomb events carry a period and a match-clock minute that runs on past 45
// and 90) and the engine (events carry only a tick; the HALF_TIME event marks the break).
//
// Buckets by match-clock minute `m` (0 = the first minute):
//   first half   m 0-14 "1–15", 15-29 "16–30", 30-44 "31–45", 45 and later "45+" (first-half stoppage)
//   second half  m 45-59 "46–60", 60-74 "61–75", 75-89 "76–90", 90 and later "90+" (second-half stoppage)

/** Bucket labels, in match order. */
export const TIMING_BUCKETS = Object.freeze(['1–15', '16–30', '31–45', '45+', '46–60', '61–75', '76–90', '90+']);

/** Ticks per match minute (20 ticks/s). */
export const TICKS_PER_MINUTE = 20 * 60;

/** Counted categories. */
export const TIMING_KINDS = Object.freeze(['goals', 'shots', 'yellowCards', 'redCards', 'substitutions']);

/**
 * Bucket of a moment given the half and the match-clock minute.
 * @param {1 | 2} half
 * @param {number} minute whole minute of the match clock, from 0; runs past 45 / 90 in stoppage time
 * @returns {string}
 */
export function bucketOfMinute(half, minute) {
  if (half === 1) {
    if (minute >= 45) return '45+';
    return minute < 15 ? '1–15' : minute < 30 ? '16–30' : '31–45';
  }
  if (minute >= 90) return '90+';
  return minute < 60 ? '46–60' : minute < 75 ? '61–75' : '76–90';
}

/**
 * Bucket of an engine tick. The engine's tick keeps counting through the half-time break:
 * the first half is ticks 1..halfTimeTick, the second half starts at halfTimeTick + 1.
 * @param {number} tick
 * @param {number} halfTimeTick tick of the HALF_TIME event
 * @returns {string}
 */
export function bucketOfTick(tick, halfTimeTick) {
  if (tick <= halfTimeTick) return bucketOfMinute(1, Math.floor(Math.max(0, tick - 1) / TICKS_PER_MINUTE));
  return bucketOfMinute(2, 45 + Math.floor((tick - halfTimeTick - 1) / TICKS_PER_MINUTE));
}

/** @returns {Record<string, Record<string, number>>} zeroed counts: kind -> bucket -> n */
export function blankTiming() {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const k of TIMING_KINDS) {
    out[k] = {};
    for (const b of TIMING_BUCKETS) out[k][b] = 0;
  }
  return out;
}

/**
 * Adds one match of engine events to `into`. Goals are GOAL events, shots SHOT events, cards
 * YELLOW_CARD / RED_CARD events and substitutions SUBSTITUTION events. A match without a
 * HALF_TIME event is skipped.
 * @param {Array<{type: string, tick: number}>} events
 * @param {Record<string, Record<string, number>>} into
 * @returns {boolean} whether the match was counted
 */
export function addEngineTiming(events, into) {
  const ht = events.find((e) => e.type === 'HALF_TIME');
  if (ht === undefined) return false;
  /** @type {Record<string, string>} */
  const kindOf = { GOAL: 'goals', SHOT: 'shots', YELLOW_CARD: 'yellowCards', RED_CARD: 'redCards', SUBSTITUTION: 'substitutions' };
  for (const e of events) {
    const kind = kindOf[e.type];
    if (kind !== undefined) into[kind][bucketOfTick(e.tick, ht.tick)]++;
  }
  return true;
}

/**
 * Adds one match of StatsBomb events to `into`. Periods 1 and 2 only (extra time and shoot-outs
 * are left out). Goals are Shot events with the Goal outcome plus Own Goal For events; cards come
 * from Foul Committed / Bad Behaviour (a Second Yellow counts as a yellow and a red).
 * @param {any[]} events
 * @param {Record<string, Record<string, number>>} into
 */
export function addStatsbombTiming(events, into) {
  for (const ev of events) {
    const period = ev.period;
    if (period !== 1 && period !== 2) continue;
    const bucket = bucketOfMinute(period, ev.minute);
    const type = ev.type?.name;
    if (type === 'Shot') {
      into.shots[bucket]++;
      if (ev.shot?.outcome?.name === 'Goal') into.goals[bucket]++;
    } else if (type === 'Own Goal For') {
      into.goals[bucket]++;
    } else if (type === 'Substitution') {
      into.substitutions[bucket]++;
    } else if (type === 'Foul Committed' || type === 'Bad Behaviour') {
      const card = ev[type === 'Foul Committed' ? 'foul_committed' : 'bad_behaviour']?.card?.name;
      if (card === 'Yellow Card' || card === 'Second Yellow') into.yellowCards[bucket]++;
      if (card === 'Red Card' || card === 'Second Yellow') into.redCards[bucket]++;
    }
  }
}

/**
 * Share of each bucket in the kind's total (zeros when nothing was counted).
 * @param {Record<string, number>} counts bucket -> n
 * @returns {Record<string, number>} bucket -> share in [0, 1]
 */
export function shares(counts) {
  let total = 0;
  for (const b of TIMING_BUCKETS) total += counts[b] ?? 0;
  /** @type {Record<string, number>} */
  const out = {};
  for (const b of TIMING_BUCKETS) out[b] = total > 0 ? (counts[b] ?? 0) / total : 0;
  return out;
}

/**
 * Report-only comparison table of simulated vs benchmark bucket shares.
 * @param {Record<string, Record<string, number>>} sim kind -> bucket -> n over `simMatches` matches
 * @param {number} simMatches
 * @param {Record<string, {matches: number, counts: Record<string, number>}> | null} bench kind -> benchmark counts
 * @returns {string} Markdown
 */
export function formatTimingTable(sim, simMatches, bench) {
  const f = (/** @type {number} */ x) => `${(100 * x).toFixed(1)}%`;
  const lines = [];
  lines.push('### Timing by 15-minute bucket (report only)', '');
  lines.push('Share of the match total in each bucket. `45+` and `90+` are first- and second-half stoppage time.', '');
  for (const kind of TIMING_KINDS) {
    const s = shares(sim[kind]);
    const b = bench?.[kind] ? shares(bench[kind].counts) : null;
    const perMatch = simMatches > 0 ? TIMING_BUCKETS.reduce((a, k) => a + sim[kind][k], 0) / simMatches : 0;
    lines.push(`**${kind}** (simulated ${perMatch.toFixed(2)} per match${bench?.[kind] ? `, benchmark ${bench[kind].matches} matches` : ', no benchmark'})`, '');
    lines.push(`| Bucket | ${TIMING_BUCKETS.join(' | ')} |`, `| :--- | ${TIMING_BUCKETS.map(() => '---:').join(' | ')} |`);
    lines.push(`| Simulated | ${TIMING_BUCKETS.map((k) => f(s[k])).join(' | ')} |`);
    if (b) {
      lines.push(`| Benchmark | ${TIMING_BUCKETS.map((k) => f(b[k])).join(' | ')} |`);
      lines.push(`| Difference | ${TIMING_BUCKETS.map((k) => `${s[k] - b[k] >= 0 ? '+' : ''}${(100 * (s[k] - b[k])).toFixed(1)}`).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
