// 팀 포지셔닝 + Stage 2 placeholder 경기 구동 (마스터 §5·§6, 계획서 §2.3).
// stepPositioning: 매 틱 공/점유를 읽어 22명을 배치(형상 앵커 + 압박1인 + 커버 + GK).
// stepPlay: Stage 2 임시 구동 — 캐리어가 상대 골문으로 드리블하다 파이널서드에서 소유권 교체.
//   → 공이 피치를 오르내리며 공격/수비/전환 형상을 시연. Stage 3 utility AI 로 교체 예정.
// rng 소비 금지(결정론). matchState 는 이 두 함수가 소유(위치·공·점유 갱신).

import { seek, computeSeparation, hash01, clamp } from './movement.js';
import {
  teamShape, teamBackDist, anchorFor, easeShape, depthRanks, dBallOwn, distToWorldX,
} from './shape.js';
import { FIELD } from './field.js';

const other = (t) => (t === 'A' ? 'B' : 'A');
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** 팀 team 필드 플레이어(GK 제외) 중 pos 최근접 1인 */
function nearestOutfield(state, team, pos) {
  let best = null, bd = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== team || p.role === 'GK' || p.sentOff) continue;
    const d = dist2(p.position, pos);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ── Stage 2 placeholder 경기 구동 ───────────────────────────
/** 캐리어를 상대 골문 쪽으로 드리블시키고, 파이널서드 도달 시 소유권을 교체한다(임시). */
export function stepPlay(state, dt) {
  const cfg = state.cfg, P = cfg.player, ball = state.ball;
  if (!state.possessionTeamId) state.possessionTeamId = state.kickoffFirstHalf;

  let carrier = ball.carrierId ? state.players[ball.carrierId] : null;
  if (!carrier || carrier.teamId !== state.possessionTeamId || carrier.role === 'GK') {
    carrier = nearestOutfield(state, state.possessionTeamId, ball.position);
    ball.carrierId = carrier.id;
  }
  const dir = state.attackDirection[carrier.teamId];

  // 상대 골문 8m 앞을 향해 run 추진, z는 완만한 사인 드리프트(결정론)
  const targetX = dir * (FIELD.halfLength - 8);
  const driftZ = Math.sin(state.clockSeconds * 0.22 + hash01(carrier.id) * 6.2832) * 6;
  seek(carrier, { x: targetX, z: driftZ }, P.run, P, dt, P.arrivalRadius);
  carrier.hasBall = true;

  // 공은 캐리어 진행방향 살짝 앞
  ball.position = { x: carrier.position.x + dir * cfg.ball.carryAhead, y: 0, z: carrier.position.z };
  ball.velocity = { x: carrier.velocity.x, y: 0, z: carrier.velocity.z };
  ball.mode = 'CONTROLLED';
  ball.ownerId = carrier.id;
  ball.lastTouchPlayerId = carrier.id;
  ball.lastTouchTeamId = carrier.teamId;

  // 파이널서드 도달 → 소유권 교체(임시 턴오버)
  if (dBallOwn(dir, ball.position.x) >= cfg.play.turnoverDist) {
    carrier.hasBall = false;
    const nt = other(carrier.teamId);
    state.possessionTeamId = nt;
    const nc = nearestOutfield(state, nt, ball.position);
    ball.carrierId = nc.id;
    state.eventLog.push({ t: Math.round(state.clockSeconds * 100) / 100, half: state.half, type: 'TURNOVER', to: nt });
  }
}

// ── 수비 역할 배정: first defender(압박1인) + cover(1인) ──────
function assignDefenders(state, defTeam, carrier, cfg) {
  if (!state._press) state._press = { presserId: null, coverId: null, since: -1 };
  const ps = state._press;
  if (!defTeam || !carrier) { ps.presserId = null; ps.coverId = null; return ps; }

  const P = cfg.press;
  // 압박자 후보: 수비팀 필드 알 중 캐리어 최근접(존/현위치). 존이 engageDist 밖이면 압박 없음.
  let best = null, bd = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== defTeam || p.role === 'GK' || p.sentOff) continue;
    const d = dist2(p.position, carrier.position);
    if (d < bd) { bd = d; best = p; }
  }
  const desired = best && bd <= P.engageDist ? best.id : null;

  // 히스테리시스: 현재 압박자가 유효하고 지정 후 hysteresisSec 미만이면 유지
  const curValid = ps.presserId && state.players[ps.presserId] && !state.players[ps.presserId].sentOff
    && state.players[ps.presserId].teamId === defTeam;
  if (!(curValid && state.clockSeconds - ps.since < P.hysteresisSec)) {
    if (desired !== ps.presserId) { ps.presserId = desired; ps.since = state.clockSeconds; }
  }

  // 커버: 압박자 제외 수비 필드 알 중, 캐리어~자기 골문 라인 뒤쪽 지점 최근접 1인
  if (ps.presserId) {
    const dir = state.attackDirection[defTeam];
    const ownGoalDir = { x: -dir, z: 0 };                       // 자기 골문 방향(단위)
    const coverPt = {
      x: carrier.position.x + ownGoalDir.x * P.coverBehind,
      z: carrier.position.z * 0.5,                              // 안쪽(중앙)으로 당김
    };
    let cbest = null, cbd = Infinity;
    for (const p of Object.values(state.players)) {
      if (p.teamId !== defTeam || p.role === 'GK' || p.sentOff || p.id === ps.presserId) continue;
      const d = dist2(p.position, coverPt);
      if (d < cbd) { cbd = d; cbest = p; }
    }
    ps.coverId = cbest ? cbest.id : null;
  } else {
    ps.coverId = null;
  }
  return ps;
}

// ── GK 목표 위치 ────────────────────────────────────────────
function gkTargetPos(gk, dir, ballX, ballZ, teamBack, possTeam, cfg) {
  const G = cfg.gk;
  let ownDist;
  if (possTeam === gk.teamId) {
    // 공격 중 GK = 스위퍼: 자기 backLine 의 ratio 만큼 전진(≤sweeperMaxX)
    ownDist = Math.min(teamBack * G.sweeperRatio, G.sweeperMaxX);
  } else {
    // 수비/중립 GK: 골문 앞 restDist, 공이 박스면 advance 만큼 전진
    const inBox = dBallOwn(dir, ballX) <= G.boxX;
    ownDist = G.restDist + (inBox ? G.advance : 0);
  }
  return {
    x: distToWorldX(dir, ownDist),
    z: clamp(ballZ, -G.trackClampY, G.trackClampY),
  };
}

// ── 매 틱 포지셔닝 ──────────────────────────────────────────
/** 공/점유를 읽어 22명(캐리어 제외 — stepPlay 담당)을 한 dt 배치한다. */
export function stepPositioning(state, dt) {
  const cfg = state.cfg, P = cfg.player, S = cfg.shape;
  const players = state.players;
  if (!state.depthRank) state.depthRank = depthRanks(players);
  const rank = state.depthRank;

  const poss = state.possessionTeamId;
  const ball = state.ball.position;
  const carrierId = state.ball.carrierId;
  const carrier = carrierId ? players[carrierId] : null;

  // 팀 back 먼저(공격 front 오프사이드에 상대 back 필요) → 형상
  const dirA = state.attackDirection.A, dirB = state.attackDirection.B;
  const backA = teamBackDist('A', dirA, ball.x, poss, cfg);
  const backB = teamBackDist('B', dirB, ball.x, poss, cfg);
  const shape = {
    A: teamShape('A', dirA, ball.x, ball.z, poss, cfg, backB),
    B: teamShape('B', dirB, ball.x, ball.z, poss, cfg, backA),
  };
  const back = { A: backA, B: backB };

  const defTeam = poss ? other(poss) : null;
  const ps = assignDefenders(state, defTeam, carrier, cfg);
  const sep = computeSeparation(players, cfg);

  for (const p of Object.values(players)) {
    if (p.sentOff || p.id === carrierId) continue;   // 캐리어는 stepPlay 가 이동
    const dir = state.attackDirection[p.teamId];
    let target, spd;

    if (p.role === 'GK') {
      target = gkTargetPos(p, dir, ball.x, ball.z, back[p.teamId], poss, cfg);
      spd = P.jog;
    } else if (p.id === ps.presserId && carrier) {
      // first defender: 캐리어의 자기 골문 쪽 standoff 지점까지 run
      const toGoal = { x: -dir, z: 0 };
      target = { x: carrier.position.x + toGoal.x * cfg.press.standoff, z: carrier.position.z };
      spd = P.run;
    } else if (p.id === ps.coverId && carrier) {
      // cover: 압박자 뒤·안쪽 커버 지점까지 run
      target = { x: carrier.position.x - dir * cfg.press.coverBehind, z: carrier.position.z * 0.5 };
      spd = P.run;
    } else {
      // 블록: 형상 앵커(이징) + 유휴 흔들림. 앵커까지 ≤runThreshold면 jog, 넘으면 run 램프
      if (!p._tau) p._tau = S.smoothTau * (0.7 + 0.6 * hash01(p.id + 't'));
      const raw = shape[p.teamId];
      p._shape = p._shape ? easeShape(p._shape, raw, dt, p._tau) : { ...raw };
      const anchor = anchorFor(p, p._shape, dir, rank[p.id]);
      const ph = hash01(p.id) * 6.2832;
      const nx = Math.sin(state.clockSeconds * cfg.idle.freq + ph) * cfg.idle.driftRadius;
      const nz = Math.cos(state.clockSeconds * cfg.idle.freq * 0.8 + ph * 1.7) * cfg.idle.driftRadius;
      target = { x: anchor.x + nx, z: anchor.z + nz };
      const dA = dist2(p.position, anchor);
      spd = dA <= S.runThreshold ? P.jog
        : Math.min(P.run, P.jog + (P.run - P.jog) * (dA - S.runThreshold) / S.runRamp);
    }

    const off = sep[p.id];
    seek(p, { x: target.x + off.x, z: target.z + off.z }, spd, P, dt, P.arrivalRadius);
  }
}
