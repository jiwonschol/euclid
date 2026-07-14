// 창발 경기 구동 (마스터 §6 선수 행동 AI + §7 소유/컨트롤 + §11 득점/재개).
// Stage 2 placeholder 를 대체한다. 매 틱: 공 물리 → 소유/컨트롤 갱신 → 캐리어 utility 의사결정.
// 결과는 시뮬에서 창발한다(스크립트 아님). state.rng 만 판정에 소비 → 시드 재현성 유지.

import { seek } from './movement.js';
import { stepBallPhysics, launchPass, launchCross, launchShot } from './ball.js';
import { FIELD, oppGoalX, anchorToWorld } from './field.js';
import { dBallOwn } from './shape.js';

const other = (t) => (t === 'A' ? 'B' : 'A');
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function nearestOpp(state, team, pos, includeGK = true) {
  let best = null, bd = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId === team || p.sentOff || (!includeGK && p.role === 'GK')) continue;
    const d = dist2(p.position, pos);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { p: best, d: bd } : null;
}

// 선분 from→to 에 가장 가까운 수비수 거리(패스 레인 차단 판정)
function laneMinDist(state, from, to, defTeam) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const L2 = dx * dx + dz * dz || 1e-6;
  let m = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== defTeam || p.sentOff || p.role === 'GK') continue;   // GK는 선방으로 별도 처리
    let t = ((p.position.x - from.x) * dx + (p.position.z - from.z) * dz) / L2;
    t = clamp(t, 0, 1);
    const cx = from.x + t * dx, cz = from.z + t * dz;
    m = Math.min(m, Math.hypot(p.position.x - cx, p.position.z - cz));
  }
  return m;
}

function log(state, type, data) {
  state.eventLog.push({ t: Math.round(state.clockSeconds * 100) / 100, half: state.half, type, ...data });
}

// ── 소유/컨트롤 ────────────────────────────────────────────
function gainControl(state, p, note) {
  const b = state.ball;
  b.mode = 'CONTROLLED'; b.carrierId = p.id; b.ownerId = p.id;
  b.velocity = { x: 0, y: 0, z: 0 }; b.intendedTargetPlayerId = null; b._offside = null;
  b.lastTouchPlayerId = p.id; b.lastTouchTeamId = p.teamId;
  const changed = state.possessionTeamId !== p.teamId;
  state.possessionTeamId = p.teamId;
  p.hasBall = true;
  state._carryStart = state.clockSeconds;
  state._decideAt = state.clockSeconds + state.cfg.action.minCarry;
  p._dribbleTarget = null;
  if (changed && note) log(state, note, { team: p.teamId, by: p.id });
}

function updatePossession(state, dt) {
  const cfg = state.cfg, ctl = cfg.control, b = state.ball;

  if (b.mode === 'CONTROLLED') {
    const carrier = state.players[b.carrierId];
    if (!carrier) { b.mode = 'LOOSE'; b.carrierId = null; return; }
    // 태클 경합: 캐리어 근처 상대가 controlRadius 내면 매 틱 소량 확률로 탈취(루즈볼)
    const opp = nearestOpp(state, carrier.teamId, carrier.position);
    if (opp && opp.d <= ctl.controlRadius && state.rng.chance(cfg.action.turnoverBase * dt)) {  // turnoverBase=압박 중 초당 탈취율
      b.mode = 'LOOSE'; b.carrierId = null; b.ownerId = null; carrier.hasBall = false;
      b.velocity = { x: (state.rng.float() - 0.5) * 5, y: 0, z: (state.rng.float() - 0.5) * 5 };
      b.lastTouchPlayerId = opp.p.id; b.lastTouchTeamId = opp.p.teamId;
      log(state, 'TACKLE', { by: opp.p.id, team: opp.p.teamId });
    }
    return;
  }

  // 슛 선방(정식 GK 모델은 Stage 5): 공이 골문 입구 saveZone 안에 들면 1회 판정.
  // 골라인 교차 z를 예측 → 온타겟이고 GK z가 다이빙 범위(diveReach) 안이면 saveProb로 캐치/파리.
  if (b.mode === 'SHOT' && b.lastTouchTeamId && !b._shotChecked) {
    const goalLineX = Math.sign(b.velocity.x) * FIELD.halfLength;
    if (Math.abs(goalLineX - b.position.x) <= cfg.gk.saveZone && Math.abs(b.velocity.x) > 1) {
      b._shotChecked = true;
      const crossZ = b.position.z + (b.velocity.z / b.velocity.x) * (goalLineX - b.position.x);
      if (Math.abs(crossZ) <= FIELD.goalHalfWidth + 0.3) {          // 온타겟일 때만 GK 관여
        const defTeam = other(b.lastTouchTeamId);
        const gk = Object.values(state.players).find((p) => p.teamId === defTeam && p.role === 'GK' && !p.sentOff);
        if (gk && Math.abs(gk.position.z - crossZ) <= cfg.gk.diveReach && state.rng.chance(cfg.gk.saveProb)) {
          if (state.rng.chance(cfg.gk.catchRatio)) { gainControl(state, gk, 'SAVE'); return; }  // 캐치
          b.mode = 'LOOSE';                                                                      // 파리: 골문서 멀리 걷어냄
          b.position = { x: gk.position.x, y: 0, z: gk.position.z };
          b.velocity = { x: -Math.sign(b.velocity.x) * 9 + (state.rng.float() - 0.5) * 3, y: 0, z: (state.rng.float() - 0.5) * 5 };
          b.lastTouchPlayerId = gk.id; b.lastTouchTeamId = gk.teamId; log(state, 'SAVE', { by: gk.id, parry: true });
          return;
        }
      }
    }
  }

  // 비소유(flight/loose): 공 근처 최근접 1인이 컨트롤/가로채기
  const sp = Math.hypot(b.velocity.x, b.velocity.z);
  const radius = b.mode === 'LOOSE' ? ctl.looseControlRadius : ctl.interceptRadius;
  let best = null, bd = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.sentOff) continue;
    const d = dist2(p.position, b.position);
    if (d < bd) { bd = d; best = p; }
  }
  if (best && bd <= Math.max(radius, ctl.controlRadius)) {
    if (b.mode === 'LOOSE' || sp <= ctl.controlSpeedMax) {
      // 오프사이드: 공격팀 선수가 오프사이드 패스를 받으면(관여) 수비팀 프리킥
      if (b._offside && best.teamId === b._offside.team && (b.mode === 'GROUND_PASS' || b.mode === 'AERIAL_PASS')) {
        offsideRestart(state, b._offside); b._offside = null; return;
      }
      const intercept = b.intendedTargetPlayerId && best.teamId !== b.lastTouchTeamId;
      gainControl(state, best, intercept ? 'INTERCEPT' : (b.mode === 'LOOSE' ? 'COLLECT' : null));
    }
  }
}

// ── 캐리어 utility 의사결정 ─────────────────────────────────
function shotAngleQuality(pos) { return clamp(1 - Math.abs(pos.z) / 28, 0.12, 1); }
function leadPoint(mate) { return { x: mate.position.x + mate.velocity.x * 0.4, z: mate.position.z + mate.velocity.z * 0.4 }; }

// 오프사이드 위치 판정(마스터 §10 실용 핵심): 상대 진영 + 공보다 앞 + 세컨드-라스트 수비보다 앞.
// margin: 판정 여유(m). 콜 판정은 0.3, AI 회피는 큰 margin(명백할 때만 회피 → 아슬아슬한 건 콜되어 텍스트 드라마).
function isOffside(state, receiver, team, margin = 0.3) {
  const dir = state.attackDirection[team], oppDir = -dir;
  const recvOwn = dBallOwn(dir, receiver.position.x);
  if (recvOwn <= FIELD.halfLength) return false;                       // 자기 진영 → 온사이드
  if (recvOwn <= dBallOwn(dir, state.ball.position.x)) return false;   // 공보다 뒤 → 온사이드
  const ds = [];
  for (const p of Object.values(state.players)) { if (p.teamId === team || p.sentOff) continue; ds.push(dBallOwn(oppDir, p.position.x)); }
  ds.sort((a, b) => a - b);                                            // 목표 골문 거리 오름차순(작을수록 깊은 수비)
  const line = ds.length >= 2 ? ds[1] : (ds[0] || 0);                  // 세컨드-라스트 수비 라인
  return dBallOwn(oppDir, receiver.position.x) < line - margin;        // 그보다 골문에 더 가까움 → 오프사이드
}

// GK 배급: 안전한 전방 아군에게 빠르게 내보낸다(드리블/슛 금지 — GK가 필드로 돌진하는 걸 막는다).
function gkDistribute(state, carrier, dir) {
  const cfg = state.cfg, A = cfg.action, b = state.ball;
  let best = null, bu = -Infinity;
  for (const mate of Object.values(state.players)) {
    if (mate.teamId !== carrier.teamId || mate.id === carrier.id || mate.sentOff || mate.role === 'GK') continue;
    const d = dist2(carrier.position, mate.position);
    if (d < 5 || d > A.passMaxDist + 18) continue;
    const open = nearestOpp(state, mate.teamId, mate.position)?.d ?? 99;
    const prog = dBallOwn(dir, mate.position.x) - dBallOwn(dir, carrier.position.x);
    const u = Math.min(1, open / 8) * 0.6 + clamp(prog / 30, -0.3, 1) * 0.5 + (state.rng.float() - 0.5) * A.noise;
    if (u > bu) { bu = u; best = mate; }
  }
  if (!best) return;
  const lp = leadPoint(best);
  if (dist2(carrier.position, best.position) > 30) launchCross(b, carrier.position, lp, best.id, carrier.teamId, carrier.id, cfg.ball);
  else launchPass(b, carrier.position, lp, best.id, carrier.teamId, carrier.id, cfg.ball);
  carrier.hasBall = false; log(state, 'PASS', { by: carrier.id, to: best.id });
}

function decideAction(state, carrier, dir) {
  if (carrier.role === 'GK') { gkDistribute(state, carrier, dir); return; }
  const cfg = state.cfg, A = cfg.action, b = state.ball;
  const defTeam = other(carrier.teamId);
  const goal = { x: oppGoalX(dir), z: 0 };
  const dGoal = dist2(carrier.position, goal);
  const pressure = nearestOpp(state, carrier.teamId, carrier.position)?.d ?? 99;
  const noise = () => (state.rng.float() - 0.5) * 2 * A.noise;
  const tac = state.tactics ? state.tactics[carrier.teamId] : null;   // 전술 바이어스
  const shotMul = tac?.tactic === 'attack' ? 1.3 : tac?.tactic === 'park' ? 0.5 : 1;
  const fwdW = A.wForward * (tac?.tactic === 'attack' ? 1.4 : tac?.tactic === 'counter' ? 1.2 : tac?.tactic === 'park' ? 0.5 : 1);
  const throughMul = tac?.tactic === 'counter' ? 0.3 : 0.15;          // 역습은 스루 선호
  const opts = [];

  // 슛
  if (dGoal <= A.shotMaxDist) {
    const u = A.wShot * shotMul * (1 - dGoal / A.shotMaxDist) * shotAngleQuality(carrier.position)
      * (0.55 + 0.45 * clamp(pressure / 5, 0, 1)) + noise();
    opts.push({ kind: 'shot', u });
  }
  // 패스/스루
  for (const mate of Object.values(state.players)) {
    if (mate.teamId !== carrier.teamId || mate.id === carrier.id || mate.sentOff || mate.role === 'GK') continue;
    const d = dist2(carrier.position, mate.position);
    if (d < 4 || d > A.passMaxDist) continue;
    if (isOffside(state, mate, carrier.teamId, 2.5)) continue;                         // 명백한 오프사이드만 회피(아슬아슬은 콜되게)
    const prog = dBallOwn(dir, mate.position.x) - dBallOwn(dir, carrier.position.x);   // 전진>0
    const open = nearestOpp(state, mate.teamId, mate.position)?.d ?? 99;
    const lp = leadPoint(mate);
    const lane = laneMinDist(state, carrier.position, lp, defTeam);
    const turnover = lane < cfg.control.interceptRadius * 1.6 ? 0.7 : 0;
    const through = prog > 12 && open > 6 && d <= A.throughMaxDist;
    const u = A.wPass * (0.3 + fwdW * clamp(prog / 20, -0.4, 1) + Math.min(1, open / 8) * 0.5)
      + (through ? throughMul : 0) - turnover + noise();
    opts.push({ kind: through ? 'through' : 'pass', mate, lp, aerial: d > 28 && through, u });
  }
  // 드리블
  opts.push({ kind: 'dribble', u: A.wDribble * (0.3 + clamp(pressure / 6, 0, 1) * 0.5) + (dGoal > A.shotMaxDist ? 0.2 : 0) + noise() });

  opts.sort((x, y) => y.u - x.u);
  const pick = opts[0];

  if (pick.kind === 'shot') {
    const dg = dist2(carrier.position, goal);
    const wide = FIELD.goalHalfWidth * 0.6 + dg * 0.16;           // 거리 비례 좌우 산포(원거리일수록 빗나감)
    const aimZ = (state.rng.float() - 0.5) * 2 * wide;
    const aimY = 0.25 + state.rng.float() * (0.5 + dg * 0.05);     // 가끔 크로스바 위로
    launchShot(b, carrier.position, { x: goal.x, z: aimZ, y: aimY }, carrier.teamId, carrier.id, cfg.ball);
    carrier.hasBall = false; log(state, 'SHOT', { by: carrier.id, team: carrier.teamId });
    // 슛 블록: 슈터 앞 레인에 수비수(비 GK)가 바짝 있으면 확률적으로 막힘(루즈볼)
    if (laneMinDist(state, carrier.position, { x: goal.x, z: aimZ }, defTeam) < cfg.control.blockRadius && state.rng.chance(cfg.control.blockProb)) {
      b.mode = 'LOOSE';
      b.velocity = { x: -Math.sign(b.velocity.x) * 3 + (state.rng.float() - 0.5) * 5, y: 0, z: (state.rng.float() - 0.5) * 6 };
      log(state, 'BLOCK', { team: defTeam });
    }
  } else if (pick.kind === 'pass' || pick.kind === 'through') {
    if (pick.aerial) launchCross(b, carrier.position, pick.lp, pick.mate.id, carrier.teamId, carrier.id, cfg.ball);
    else launchPass(b, carrier.position, pick.lp, pick.mate.id, carrier.teamId, carrier.id, cfg.ball);
    // 패스 순간 오프사이드 스냅샷(수신자가 실제로 받으면 콜)
    b._offside = isOffside(state, pick.mate, carrier.teamId) ? { team: carrier.teamId, x: pick.mate.position.x, z: pick.mate.position.z } : null;
    carrier.hasBall = false; log(state, pick.kind === 'through' ? 'THROUGH' : 'PASS', { by: carrier.id, to: pick.mate.id });
  } else {
    // 드리블: 상대 골문 쪽 열린 공간. 압박 가까우면 측면으로 회피.
    const gx = goal.x - carrier.position.x, gz = goal.z - carrier.position.z;
    const gl = Math.hypot(gx, gz) || 1e-6;
    let tx = carrier.position.x + (gx / gl) * 12, tz = carrier.position.z + (gz / gl) * 12;
    const opp = nearestOpp(state, carrier.teamId, carrier.position);
    if (opp && opp.d < 5) { const px = -(gz / gl), pz = (gx / gl); const s = carrier.position.z > 0 ? -1 : 1; tx += px * 6 * s; tz += pz * 6 * s; }
    carrier._dribbleTarget = { x: clamp(tx, -FIELD.halfLength + 2, FIELD.halfLength - 2), z: clamp(tz, -FIELD.halfWidth + 2, FIELD.halfWidth - 2) };
  }
}

function carrierAct(state, dt) {
  const cfg = state.cfg, P = cfg.player, A = cfg.action, b = state.ball;
  const carrier = state.players[b.carrierId];
  if (!carrier) return;
  const dir = state.attackDirection[carrier.teamId];
  if (state._carryStart == null) state._carryStart = state.clockSeconds;
  if (state._decideAt == null) state._decideAt = state.clockSeconds + A.minCarry;

  if (state.clockSeconds >= state._decideAt && state.clockSeconds - state._carryStart >= A.minCarry) {
    decideAction(state, carrier, dir);
    state._decideAt = state.clockSeconds + A.decideEvery;
    if (b.mode !== 'CONTROLLED') { state._carryStart = null; return; }  // 공 방출됨
  }

  const tgt = carrier.role === 'GK' ? { x: carrier.position.x, z: carrier.position.z }
    : (carrier._dribbleTarget || { x: oppGoalX(dir), z: carrier.position.z });
  seek(carrier, tgt, P.run, P, dt, P.arrivalRadius);
  const v = carrier.velocity, s = Math.hypot(v.x, v.z);
  const fx = s > 0.3 ? v.x / s : dir, fz = s > 0.3 ? v.z / s : 0;
  b.position = {
    x: clamp(carrier.position.x + fx * cfg.ball.carryAhead, -FIELD.halfLength + 0.3, FIELD.halfLength - 0.3),
    y: 0,
    z: clamp(carrier.position.z + fz * cfg.ball.carryAhead, -FIELD.halfWidth + 0.3, FIELD.halfWidth - 0.3),
  };
  b.velocity = { x: v.x, y: 0, z: v.z };
}

// ── 득점/재개 ──────────────────────────────────────────────
function resetFormation(state) {
  for (const p of Object.values(state.players)) {
    const w = anchorToWorld(p.homeAnchor, state.attackDirection[p.teamId]);
    p.position = { x: w.x, z: w.z }; p.velocity = { x: 0, z: 0 };
    p.hasBall = false; p._shape = null;
  }
  state._press = null;
}

// 재개 공을 team 에게 확정 지급(경합·순서편향 제거). pos 최근접 필드 플레이어가 그 자리에서 소유.
function giveRestart(state, team, pos) {
  let taker = null, bd = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== team || p.role === 'GK' || p.sentOff) continue;
    const d = dist2(p.position, pos); if (d < bd) { bd = d; taker = p; }
  }
  if (!taker) return;
  taker.position = { x: pos.x, z: pos.z }; taker.velocity = { x: 0, z: 0 };
  state.ball.position = { x: pos.x, y: 0, z: pos.z }; state.ball.velocity = { x: 0, y: 0, z: 0 };
  gainControl(state, taker, null);
}
export function placeKickoff(state, team) { giveRestart(state, team, { x: 0, z: 0 }); }

function goalRestart(state, scorer) {
  state.score[scorer] += 1;
  log(state, 'GOAL', { team: scorer, score: { ...state.score } });
  resetFormation(state);
  state._carryStart = null; state._decideAt = null;
  placeKickoff(state, other(scorer));               // 실점팀이 센터에서 킥오프
}

function offsideRestart(state, os) {
  log(state, 'OFFSIDE', { team: os.team });
  giveRestart(state, other(os.team), { x: clamp(os.x, -FIELD.halfLength + 3, FIELD.halfLength - 3), z: clamp(os.z, -FIELD.halfWidth + 2, FIELD.halfWidth - 2) });
  state._carryStart = null; state._decideAt = null;
}

// 정식 재개: 터치라인=스로인, 골라인은 마지막 터치에 따라 골킥/코너 (마스터 §11).
function outRestart(state, ev) {
  const lastTeam = state.ball.lastTouchTeamId;
  let team, type, spot;
  if (ev.edge === 'touch') {
    team = lastTeam ? other(lastTeam) : (state.possessionTeamId || 'A');
    type = 'throw';
    spot = { x: clamp(ev.x, -FIELD.halfLength + 1, FIELD.halfLength - 1), z: ev.z > 0 ? FIELD.halfWidth - 0.5 : -(FIELD.halfWidth - 0.5) };
  } else {
    const side = ev.x > 0 ? 1 : -1;
    const attacker = state.attackDirection.A === side ? 'A' : 'B';   // 그 골문을 향해 공격하는 팀
    if (lastTeam === attacker) {                                       // 공격팀 아웃 → 골킥(수비팀)
      team = other(attacker); type = 'goalkick';
      const gdir = state.attackDirection[team];
      spot = { x: gdir * (9 - FIELD.halfLength), z: 0 };               // 수비팀 골에어리어
    } else {                                                           // 수비팀 아웃(또는 미상) → 코너(공격팀)
      team = attacker; type = 'corner';
      spot = { x: side * (FIELD.halfLength - 1), z: ev.z > 0 ? FIELD.halfWidth - 1 : -(FIELD.halfWidth - 1) };
    }
  }
  state._carryStart = null; state._decideAt = null;
  giveRestart(state, team, spot);
  log(state, 'RESTART', { kind: type, team });   // kind (type 는 이벤트타입과 충돌하므로)
}

// ── 진입점 ─────────────────────────────────────────────────
export function stepPlay(state, dt) {
  const ev = stepBallPhysics(state.ball, dt, state.cfg);
  if (ev) {
    // side(골 방향 x부호) → 그 방향으로 공격하는 팀이 득점(후반 진영 반전 반영)
    if (ev.type === 'GOAL') goalRestart(state, state.attackDirection.A === ev.side ? 'A' : 'B');
    else outRestart(state, ev);
    return;
  }
  updatePossession(state, dt);
  if (state.ball.mode === 'CONTROLLED' && state.ball.carrierId) carrierAct(state, dt);
}
