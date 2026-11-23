/**
 * Contact resolution (design §8, §9, §10; tick step 5): interceptions and
 * blocks on the ball's path, landings and aerial duels, receptions and first
 * touches, loose-ball recoveries, tackles and fouls.
 */
import { nextFloat } from '../rng/sfc32.js';
import { sigmoid } from '../math/detmath.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { ballHeightBand, sweptContests, makeContestList, launchProjectile, segmentCircleSpan } from '../ball/BallPhysics.js';
import { bodyRandom } from '../rng/streams.js';
import { contestOutcome, tackleOutcome, aerialDuel } from './duels.js';
import { firstTouch, n } from './passing.js';
import { judgeContact, showCard, startAdvantage } from '../officiating/Referee.js';
import { startFoulRestart, startRestart } from '../restarts/RestartMachine.js';
import { rollContactInjury } from '../injuries/Injuries.js';
import { giveBall, endPass, launchClearance, launchShot } from '../decisions/Actions.js';
import { ACTION, GOAL_Y, along, attackGoalX, hyp, inOwnBox, keeperOf, nearestOpponent, pressureAt } from '../decisions/Perception.js';
import { PITCH_WIDTH } from '../state/MatchState.js';

const contests = makeContestList();
const contestOut = { pWin: 0, won: false };
const touchOut = { pControl: 0, controlled: false };
const tackleOut = { pWin: 0, pFoul: 0, won: false, foul: false };
const aerialOut = { pWinA: 0, aWins: false };

/**
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function resolveContacts(state) {
  if (state.restart.state !== 'IN_PLAY' || state.ballStatus.code !== 0) return;
  const b = state.ball;
  if (b.owner >= 0) {
    tackle(state);
    return;
  }
  interceptions(state);
  if (state.ball.owner >= 0 || state.restart.state !== 'IN_PLAY') return;
  bodyBlock(state);
  if (state.ball.owner >= 0 || state.restart.state !== 'IN_PLAY') return;
  if (state.ballStatus.landed) landing(state);
  if (state.ball.owner >= 0 || state.restart.state !== 'IN_PLAY') return;
  if (b.pass !== null) reception(state);
  else looseBall(state);
}

/** @param {import('../state/MatchState.js').MatchState} state */
function pressureDist(state) {
  return state.k.weights.decision.features.pressureDist;
}

/**
 * Opponents of the last toucher may intercept (or block) the ball on this tick's path.
 * @param {import('../state/MatchState.js').MatchState} state
 */
function interceptions(state) {
  const b = state.ball;
  const speed = hyp(b.vx, b.vy);
  if (b.flight === null && speed < state.k.weights.ball.looseSpeedMax * 0.5) return;
  sweptContests(state, contests);
  const reach = state.k.weights.contest.groundReach;
  for (let i = 0; i < contests.count; i++) {
    const q = state.players[contests.player[i]];
    // Each defender gets one chance per pass.
    if (b.pass !== null) {
      if (b.pass.tried.includes(q.index)) continue;
      b.pass.tried.push(q.index);
    }
    const anticipation = getEffectiveAttribute(q, q.isKeeper === 1 ? 'reflexes' : 'positioning', state.k);
    const d = hyp(q.x - contests.x[i], q.y - contests.y[i]);
    contestOutcome(anticipation, speed, d, reach, state.k.weights, nextFloat(state.rng), contestOut, state.k.weights.morale.contestLogit * q.moraleLevel);
    if (!contestOut.won) continue;
    if (b.pass !== null) endPass(state, false);
    state.emit('INTERCEPTION', { teamIndex: q.team, actorIndex: q.index, x: q.x, y: q.y });
    if (nextFloat(state.rng) < state.k.weights.contest.deflectP) deflect(state, q, speed);
    else giveBall(state, q.index, false);
    return;
  }
}

/**
 * Ball-to-body blocking: a player is a vertical cylinder, and the ball cannot pass through it. When this
 * tick's 3D segment enters a cylinder (the earliest one, ties to the lowest player index) the player
 * either controls the ball (`firstTouch`, so a hard strike is rarely killed) or it is deflected with
 * damped speed and scattered direction. The kicker is exempt for `bodyGraceTicks` after the touch (and a shot, deflection or rebound clears every body for that long) and a
 * pass's intended receiver is left to `reception`. Draws come from the ball-to-body stream.
 * @param {import('../state/MatchState.js').MatchState} state
 */
function bodyBlock(state) {
  const b = state.ball;
  const k = state.k;
  const c = k.weights.contest;
  const sx = b.x - b.prevX;
  const sy = b.y - b.prevY;
  if (sx === 0 && sy === 0 && b.z === b.prevZ) return;
  // A lofted ball on its way down belongs to the aerial duel / keeper claim (`landing`), not to body blocks.
  if (b.flight !== null && state.tick - b.flight.launchTick > b.flight.flightTicks / 2) return;
  if (state.ballStatus.landed) return;
  const radius = c.bodyRadius + c.ballRadius;
  const grace = state.tick - b.touchTick < c.bodyGraceTicks;
  const receiver = b.pass !== null ? b.pass.receiver : -1;
  let hit = -1;
  let hitT = Infinity;
  const list = state.onPitchList;
  for (let n = 0; n < list.length; n++) {
    const i = list[n];
    if (i === receiver || (grace && (i === b.lastTouch || b.pass === null))) continue;
    const q = state.players[i];
    const sp = segmentCircleSpan(b.prevX, b.prevY, b.x, b.y, q.x, q.y, radius);
    if (sp === null || sp.t0 > hitT) continue;
    // A ball struck from inside a body's reach (a presser on the kicker) is not stopped by it: that is the tackle's job.
    if (grace && sp.t0 === 0) continue;
    let height = c.bodyHeight;
    if (q.pendingAction === ACTION.CHASE || q.pendingAction === ACTION.PRESS) height += c.bodyJumpBonus;
    // The ball is under the player's height at the point it enters or leaves the cylinder.
    const zIn = b.flight !== null ? b.heightAt(state.tick - 1 + sp.t0) : b.prevZ + sp.t0 * (b.z - b.prevZ);
    const zOut = b.flight !== null ? b.heightAt(state.tick - 1 + sp.t1) : b.prevZ + sp.t1 * (b.z - b.prevZ);
    if (zIn > height && zOut > height) continue;
    if (sp.t0 < hitT || i < hit) {
      hitT = sp.t0;
      hit = i;
    }
  }
  if (hit < 0) return;
  const q = state.players[hit];
  const u = bodyRandom(state.seed, state.tick, hit);
  const speed = hyp(b.vx, b.vy);
  const hx = b.prevX + hitT * (b.x - b.prevX);
  const hy = b.prevY + hitT * (b.y - b.prevY);
  firstTouch(
    speed, pressureAt(state, q.team, q.x, q.y, pressureDist(state)), getEffectiveAttribute(q, 'firstTouch', state.k),
    getEffectiveAttribute(q, 'technique', state.k), state.k.weights, nextFloat(u), touchOut,
  );
  const mate = b.lastTouch >= 0 && state.players[b.lastTouch].team === q.team;
  if (touchOut.controlled) {
    if (b.pass !== null) endPass(state, mate);
    if (!mate) state.emit('INTERCEPTION', { teamIndex: q.team, actorIndex: q.index, x: q.x, y: q.y });
    giveBall(state, q.index, false);
    return;
  }
  if (b.pass !== null) endPass(state, false);
  // Deflected: the ball loses pace and turns by up to atan(bodyScatter), from the point of contact.
  const len = speed || 1;
  const dx = speed > 0 ? b.vx / len : q.x - hx;
  const dy = speed > 0 ? b.vy / len : q.y - hy;
  const tilt = (nextFloat(u) * 2 - 1) * c.bodyScatter;
  const nx = dx - dy * tilt;
  const ny = dy + dx * tilt;
  const nl = hyp(nx, ny) || 1;
  const z0 = b.z < 0.05 ? 0.05 : b.z > 2.2 ? 2.2 : b.z;
  launchProjectile(state, hx, hy, hx + nx / nl, hy + ny / nl, speed * c.bodyKeep * (0.6 + 0.8 * nextFloat(u)), 0.5 + 2 * nextFloat(u), 0, q.index, z0);
  b.touchTick = state.tick;
}

/**
 * The defender gets a touch but cannot control it: the ball carries on,
 * slowed and turned by up to atan(deflectTilt), as a loose ball (into touch or
 * behind for a corner, when near a line).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} q
 * @param {number} speed ball speed before the touch
 */
function deflect(state, q, speed) {
  const b = state.ball;
  const c = state.k.weights.contest;
  const len = hyp(b.vx, b.vy) || 1;
  const dx = b.vx / len;
  const dy = b.vy / len;
  const tilt = (nextFloat(state.rng) * 2 - 1) * c.deflectTilt;
  const nx = dx - dy * tilt;
  const ny = dy + dx * tilt;
  const nl = hyp(nx, ny);
  const z0 = b.height < 0.05 ? 0.05 : b.height > 2.2 ? 2.2 : b.height;
  launchProjectile(state, q.x, q.y, q.x + nx / nl, q.y + ny / nl, speed * c.deflectKeep * (0.6 + 0.8 * nextFloat(state.rng)), 1 + 2 * nextFloat(state.rng), 0, q.index, z0);
  b.touchTick = state.tick;
}

/**
 * A lofted ball has come down: the keeper claims or punches it, or the nearest
 * attacker and defender contest it in the air, or one side simply collects it.
 * @param {import('../state/MatchState.js').MatchState} state
 */
function landing(state) {
  const b = state.ball;
  const k = state.k.weights;
  const lastTeam = b.lastTouch >= 0 ? state.players[b.lastTouch].team : 0;
  let att = -1;
  let def = -1;
  let attD = Infinity;
  let defD = Infinity;
  const radius = k.aerial.radius;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    const d = hyp(q.x - b.x, q.y - b.y);
    if (d > radius) continue;
    if (q.team === lastTeam) {
      if (d < attD) {
        attD = d;
        att = i;
      }
    } else if (d < defD) {
      defD = d;
      def = i;
    }
  }
  const keeper = def >= 0 && state.players[def].isKeeper === 1 ? state.players[def] : null;
  if (keeper !== null || (def < 0 && att < 0)) {
    // The keeper comes for it when it lands in their box.
    const kIdx = keeper !== null ? keeper.index : keeperOf(state, 1 - lastTeam);
    if (kIdx >= 0 && inOwnBox(state, 1 - lastTeam, b.x, b.y) && hyp(state.players[kIdx].x - b.x, state.players[kIdx].y - b.y) <= k.keeper.commandBase + k.keeper.commandPer * getEffectiveAttribute(state.players[kIdx], 'commandOfArea', state.k)) {
      const kp = state.players[kIdx];
      let crowd = 0;
      for (const i of state.onPitchList) if (i !== kIdx && hyp(state.players[i].x - b.x, state.players[i].y - b.y) <= k.keeper.crowdRadius) crowd++;
      const pClaim = sigmoid(k.keeper.q0 + k.keeper.q1 * n(getEffectiveAttribute(kp, 'commandOfArea', state.k)) - k.keeper.q2 * crowd);
      if (b.pass !== null) endPass(state, false);
      if (nextFloat(state.rng) < pClaim) {
        state.emit('CLAIM', { teamIndex: kp.team, actorIndex: kIdx, x: kp.x, y: kp.y });
        giveBall(state, kIdx, false);
      } else {
        state.emit('PUNCH', { teamIndex: kp.team, actorIndex: kIdx, x: kp.x, y: kp.y });
        const dir = state.attackDir(kp.team);
        b.lastTouch = kIdx;
        b.touchTick = state.tick;
        b.vx = dir * 8;
        b.vy = (nextFloat(state.rng) * 2 - 1) * 4;
      }
      return;
    }
  }
  if (att >= 0 && def >= 0) {
    const a = state.players[att];
    const d = state.players[def];
    aerialDuel(
      (getEffectiveAttribute(a, 'jumpingReach', state.k) + getEffectiveAttribute(a, 'strength', state.k) + getEffectiveAttribute(a, 'bravery', state.k)) / 3,
      (getEffectiveAttribute(d, 'jumpingReach', state.k) + getEffectiveAttribute(d, 'strength', state.k) + getEffectiveAttribute(d, 'bravery', state.k)) / 3,
      k, nextFloat(state.rng), aerialOut,
    );
    const duelZ = Math.round(Math.min(2.4, k.contest.standHeight + 0.35) * 1000) / 1000;
    const duelMaxZ = Math.round(Math.max(duelZ, b.maxZ) * 1000) / 1000;
    state.emit('AERIAL_DUEL', {
      teamIndex: a.team,
      actorIndex: att,
      secondaryIndices: [def],
      x: b.x,
      y: b.y,
      meta: { won: aerialOut.aWins, z: duelZ, maxZ: duelMaxZ, heightBand: ballHeightBand(duelZ) },
    });
    rollContactInjury(state, aerialOut.aWins ? def : att, aerialOut.aWins ? att : def);
    if (aerialOut.aWins) {
      const header = b.pass !== null && b.pass.kind === 'CROSS';
      if (b.pass !== null) endPass(state, true);
      giveBall(state, att, true);
      const gx = along(state, a.team, a.x);
      if (header && gx > 90 && hyp(105 - gx, a.y - GOAL_Y) < 14 && nextFloat(state.rng) < 0.6) launchShot(state, a, { header: true });
    } else {
      if (b.pass !== null) endPass(state, false);
      if (inOwnBox(state, d.team, d.x, d.y) && nextFloat(state.rng) < k.aerial.behindP) {
        // Headed behind under pressure: a corner.
        b.owner = -1;
        b.lastTouch = def;
        b.touchTick = state.tick;
        startRestart(state, 'CORNER', a.team, attackGoalX(state, a.team), b.y < GOAL_Y ? 0 : PITCH_WIDTH);
        return;
      }
      giveBall(state, def, false);
      if (inOwnBox(state, d.team, d.x, d.y)) launchClearance(state, d);
    }
    return;
  }
  if (att >= 0) {
    if (b.pass !== null) endPass(state, true);
    giveBall(state, att, true);
  } else if (def >= 0) {
    if (b.pass !== null) endPass(state, false);
    state.emit('RECOVERY', { teamIndex: state.players[def].team, actorIndex: def, x: b.x, y: b.y });
    giveBall(state, def, false);
  }
}

/**
 * The receiver (or, for a ball into an area, any team-mate) controls a ball that has reached them.
 * @param {import('../state/MatchState.js').MatchState} state
 */
function reception(state) {
  const b = state.ball;
  const pass = b.pass;
  if (pass === null || b.flight !== null) return;
  const k = state.k.weights;
  const radius = k.ball.receiveRadius;
  const passer = state.players[pass.passer];
  let rIdx = -1;
  let best = Infinity;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team !== passer.team || i === pass.passer) continue;
    if (pass.receiver >= 0 && i !== pass.receiver) continue;
    const d = hyp(q.x - b.x, q.y - b.y);
    if (d <= radius && d < best) {
      best = d;
      rIdx = i;
    }
  }
  if (rIdx >= 0) {
    const r = state.players[rIdx];
    firstTouch(
      hyp(b.vx, b.vy), pressureAt(state, r.team, r.x, r.y, pressureDist(state)), getEffectiveAttribute(r, 'firstTouch', state.k),
      getEffectiveAttribute(r, 'technique', state.k), k, nextFloat(state.rng), touchOut,
    );
    if (touchOut.controlled) {
      endPass(state, true);
      giveBall(state, rIdx, true);
    } else {
      state.emit('MISCONTROL', { teamIndex: r.team, actorIndex: rIdx, x: r.x, y: r.y });
      endPass(state, false);
      b.lastTouch = rIdx;
      b.touchTick = state.tick;
      b.vx = (nextFloat(state.rng) * 2 - 1) * 3;
      b.vy = (nextFloat(state.rng) * 2 - 1) * 3;
    }
    return;
  }
  // The pass has run out of pace with nobody on it.
  if (b.vx === 0 && b.vy === 0) endPass(state, false);
}

/**
 * The nearest player collects a loose ball (not the player who just kicked it).
 * @param {import('../state/MatchState.js').MatchState} state
 */
function looseBall(state) {
  const b = state.ball;
  const k = state.k.weights;
  const speed = hyp(b.vx, b.vy);
  if (speed > k.ball.looseSpeedMax || b.flight !== null) return;
  let best = -1;
  let bestD = k.ball.receiveRadius;
  for (const i of state.onPitchList) {
    if (i === b.lastTouch && state.tick - b.touchTick < k.ball.lockTicks) continue;
    const q = state.players[i];
    const d = hyp(q.x - b.x, q.y - b.y);
    if (d < bestD || (d === bestD && best >= 0 && i < best)) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return;
  const q = state.players[best];
  if (speed > 3) {
    firstTouch(speed, pressureAt(state, q.team, q.x, q.y, pressureDist(state)), getEffectiveAttribute(q, 'firstTouch', state.k), getEffectiveAttribute(q, 'technique', state.k), k, nextFloat(state.rng), touchOut);
    if (!touchOut.controlled) {
      state.emit('MISCONTROL', { teamIndex: q.team, actorIndex: best, x: q.x, y: q.y });
      b.lastTouch = best;
      b.touchTick = state.tick;
      b.vx = (nextFloat(state.rng) * 2 - 1) * 3;
      b.vy = (nextFloat(state.rng) * 2 - 1) * 3;
      return;
    }
  }
  const lastTeam = b.lastTouch >= 0 ? state.players[b.lastTouch].team : -1;
  if (lastTeam !== q.team) state.emit('RECOVERY', { teamIndex: q.team, actorIndex: best, x: q.x, y: q.y });
  giveBall(state, best, true);
}

/**
 * A pressing defender in range challenges the carrier on their decision cycle.
 * @param {import('../state/MatchState.js').MatchState} state
 */
function tackle(state) {
  const b = state.ball;
  const c = state.players[b.owner];
  const k = state.k.weights;
  const t = k.tackle;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === c.team || q.pendingAction !== ACTION.PRESS) continue;
    if ((state.tick + i) % 5 !== 0) continue;
    const d = hyp(q.x - c.x, q.y - c.y);
    if (d > t.range) continue;
    // Defenders are more careful inside their own box and once booked.
    const inBox = inOwnBox(state, q.team, c.x, c.y);
    const booked = q.card === 1;
    const pAttempt = t.attemptP * (0.6 + t.aggressionGain * n(getEffectiveAttribute(q, 'aggression', state.k))) * (inBox ? t.boxAttempt : 1) * (booked ? t.bookedAttempt : 1);
    if (nextFloat(state.rng) >= pAttempt) continue;
    // Approached from behind: the challenger is behind the carrier's direction of travel.
    const speed = hyp(c.vx, c.vy);
    const fx = speed > 0.5 ? c.vx / speed : state.attackDir(c.team);
    const fy = speed > 0.5 ? c.vy / speed : 0;
    const fromBehind = d > 0 && ((q.x - c.x) * fx + (q.y - c.y) * fy) / d < -0.3 ? 1 : 0;
    tackleOutcome(
      getEffectiveAttribute(q, 'tackling', state.k), getEffectiveAttribute(q, 'strength', state.k), getEffectiveAttribute(c, 'dribbling', state.k),
      getEffectiveAttribute(c, 'balance', state.k), getEffectiveAttribute(q, 'aggression', state.k), q.fitness, fromBehind, q.injury,
      k, nextFloat(state.rng), nextFloat(state.rng), tackleOut, k.morale.tackleLogit * (q.moraleLevel - c.moraleLevel), (inBox ? t.boxFoul : 0) + (booked ? t.bookedFoul : 0),
    );
    if (tackleOut.foul) {
      foul(state, q, c, fromBehind === 1);
      rollContactInjury(state, c.index, q.index);
    } else {
      state.emit('TACKLE', { teamIndex: q.team, actorIndex: q.index, secondaryIndices: [c.index], x: c.x, y: c.y, meta: { won: tackleOut.won } });
      if (tackleOut.won) {
        state.emit('POSSESSION_LOST', { teamIndex: c.team, actorIndex: c.index, x: c.x, y: c.y });
        if (nextFloat(state.rng) < t.looseP) {
          // Poked away rather than won cleanly: a loose ball in any direction.
          const ax = nextFloat(state.rng) * 2 - 1;
          const ay = nextFloat(state.rng) * 2 - 1;
          launchProjectile(state, c.x, c.y, c.x + ax, c.y + ay, 3 + 6 * nextFloat(state.rng), 0, 0, q.index, 0);
          state.ball.touchTick = state.tick;
          c.pendingAction = ACTION.HOLD;
        } else giveBall(state, q.index, false);
      }
      rollContactInjury(state, c.index, q.index);
    }
    return;
  }
}

/**
 * A foul on the carrier: the referee judges it, shows any card, and the fouled
 * team gets an advantage, a free kick or a penalty. No advantage is played
 * while a substitution is queued, so every foul then stops the ball.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} q the fouler
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} c the fouled carrier
 * @param {boolean} fromBehind
 */
function foul(state, q, c, fromBehind) {
  // The last attacker past the last defender (the goalkeeper aside).
  let lastMan = along(state, c.team, c.x) > 52.5;
  if (lastMan) {
    for (const i of state.onPitchList) {
      const o = state.players[i];
      if (o.team !== c.team && o.isKeeper !== 1 && o.index !== q.index && along(state, c.team, o.x) > along(state, c.team, c.x)) {
        lastMan = false;
        break;
      }
    }
  }
  const otherDist = nearestOpponent(state, c.team, c.x, c.y, q.index);
  const v = judgeContact({
    state, tackler: q.index, fouled: c.index, fromBehind, tacklerSpeed: hyp(q.vx, q.vy), lastMan,
    inBox: inOwnBox(state, q.team, c.x, c.y), otherOpponentDist: otherDist,
  });
  const card = v.card;
  const penalty = v.penalty;
  // A queued substitution makes every foul a stoppage: the referee blows for
  // the free kick instead of playing advantage, so the change can be made.
  const advantage = v.advantage && state.pendingSubs.length === 0;
  const x = c.x;
  const y = c.y;
  state.emit('FOUL', { teamIndex: q.team, actorIndex: q.index, secondaryIndices: [c.index], x, y });
  if (card > 0) showCard(state, q.index, card, c.index);
  if (advantage) startAdvantage(state, c.index, q.index);
  else startFoulRestart(state, c.team, x, y, penalty, q.index, c.index);
}

