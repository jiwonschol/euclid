// 창발 경기 구동 (마스터 §6 선수 행동 AI + §7 소유/컨트롤 + §11 득점/재개).
// Stage 2 placeholder 를 대체한다. 매 틱: 공 물리 → 소유/컨트롤 갱신 → 캐리어 utility 의사결정.
// 결과는 시뮬에서 창발한다(스크립트 아님). state.rng 만 판정에 소비 → 시드 재현성 유지.

import { seek } from './movement.js';
import { stepBallPhysics, launchPass, launchCross, launchShot } from './ball.js';
import { FIELD, oppGoalX, anchorToWorld, penaltyBoxOf } from './field.js';
import { dBallOwn } from './shape.js';
import { resolvedFor, consumeNextAction } from './effects.js';
import { threatMul } from './stance.js';

const other = (t) => (t === 'A' ? 'B' : 'A');
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 시퀀스 목표 패스 수(디자이너 목표 분포: 1패스 10% · 3-5 40% · 6-8 30% · 나머지 20%).
// 소유 획득 시 뽑아, 이 수만큼 빌드업한 뒤 마무리(슛/크로스)하도록 캐리어 결정을 편향한다.
function drawSeqTarget(rng) {
  // draw%는 측정%와 1:1이 아니다(긴 시퀀스가 턴오버로 잘려 하향) → 6-8을 과공급해 측정치를 목표(10/40/30)에 맞춤.
  const r = rng.float();
  if (r < 0.11) return 1;
  if (r < 0.18) return 2;
  if (r < 0.55) return 3 + Math.floor(rng.float() * 3);   // 3-5 (draw 37% → 측정 ~42)
  if (r < 0.94) return 6 + Math.floor(rng.float() * 3);   // 6-8 (draw 39% → 측정 ~31, 턴오버 보정)
  return 9 + Math.floor(rng.float() * 4);                 // 9-12
}

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
  if (b._cross && penaltyBoxOf(p.position.x, p.position.z, state.attackDirection[p.teamId]) === 'opp') p._crossFinish = true;  // 박스서 크로스 받음 → 원터치
  b._cross = false;
  b.lastTouchPlayerId = p.id; b.lastTouchTeamId = p.teamId;
  const changed = state.possessionTeamId !== p.teamId;
  if (changed) { state._seqPasses = 0; state._seqTarget = drawSeqTarget(state.rng); state._possChangedAt = state.clockSeconds; }   // 새 시퀀스 → 목표 패스 수 + 전환 타이밍 기록
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
    const mf = carrier.teamId === 'A' ? (state.subBoost?.A?.mf || 0) : 0;
    // 읽고 대응: 수비팀의 '수비 방향' 스탠스가 상대의 실제 공격 방향과 맞으면 탈취 확률↑, 반대로 읽었으면↓
    const tm = state.stanceCfg ? threatMul(state, other(carrier.teamId), state.stanceCfg) : 1;
    if (opp && opp.d <= ctl.controlRadius && state.rng.chance(cfg.action.turnoverBase * tm * dt * (1 - 0.18 * mf))) {  // mf 교체=볼 지키기↑
      // 태클 접촉 → resolver(§11): 합법이면 아래 루즈볼, 반칙이면 프리킥/PK(+경고/퇴장)
      const res = cfg.foul ? resolveTackle(state, opp.p, carrier, cfg.foul) : { foul: false };
      if (res.foul) { foulRestart(state, opp.p, carrier, res); return; }
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
        const df = defTeam === 'A' ? (state.subBoost?.A?.df || 0) : 0;
        if (gk && Math.abs(gk.position.z - crossZ) <= cfg.gk.diveReach && state.rng.chance(Math.min(0.98, cfg.gk.saveProb + 0.03 * df))) {
          if (state.rng.chance(cfg.gk.catchRatio)) { gainControl(state, gk, 'SAVE'); return; }  // 캐치
          b.mode = 'LOOSE';                                                                      // 파리: 골문서 멀리 걷어냄
          // 공을 GK 좌표로 덮어쓰지 않는다(§18 "패스가 순간이동함" 금지 — 실측 1틱 9.53m 점프).
          // 공은 현재 지점에 두고 높이만 접지, 속도만 걷어내는 방향으로 준다.
          b.position = { x: b.position.x, y: 0, z: b.position.z };
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
  const tac = resolvedFor(state, carrier.teamId);   // 전술 바이어스(스탠스+활성 카드 효과)
  let shotMul = (tac.tactic === 'attack' ? 1.3 : tac.tactic === 'park' ? 0.5 : 1) * tac.shotBias;
  if (carrier._crossFinish) { shotMul *= 2.5; carrier._crossFinish = false; }   // 크로스 원터치 마무리

  const fwdW = A.wForward * (tac.tactic === 'attack' ? 1.4 : tac.tactic === 'counter' ? 1.2 : tac.tactic === 'park' ? 0.5 : 1) * tac.tempo;   // 템포 낮추기 → 전진 성향↓(안전 지향)
  const throughMul = (tac.tactic === 'counter' ? 0.3 : 0.15) * tac.throughBias;          // 역습은 스루 선호
  const zone = tac ? tac.attackZone : null;                           // 측면/중앙 전개 편향
  const wingSide = zone === 'wing' ? (carrier.position.z < 0 ? -1 : 1) : zone === 'wing_left' ? -1 : zone === 'wing_right' ? 1 : 0;
  const carrierFinal = dBallOwn(dir, carrier.position.x) > 62;
  // 시퀀스 마무리 게이팅(목표 패스 분포): 목표 패스 전엔 슛/크로스 억제(빌드업), 후엔 부추김
  const seqTarget = state._seqTarget || 4;
  const culmReady = (state._seqPasses || 0) >= seqTarget;
  const quick = seqTarget <= 1;                                    // 빠른 공격(1패스): 원거리라도 즉시 마무리
  const buildMul = culmReady ? (A.culmBoost || 1.0) * (quick ? 1.3 : 1) : (A.buildSuppress || 0.18);
  const opts = [];

  // 슛 — 박스라고 무조건 쏘지 않는다. GK가 못 막는 '빈 곳'이 있을 때만. 마무리 단계엔 사거리 확장(빠른 공격은 더).
  const shotRange = A.shotMaxDist + (culmReady ? (quick ? 6 : 2) : 0);
  if (dGoal <= shotRange) {
    const dgk = Object.values(state.players).find((p) => p.teamId === defTeam && p.role === 'GK' && !p.sentOff);
    const gkZ = dgk ? dgk.position.z : 0;
    const cornerZ = gkZ >= 0 ? -FIELD.goalHalfWidth : FIELD.goalHalfWidth;       // GK 반대쪽 먼 코너
    const openness = clamp((Math.abs(cornerZ - gkZ) - 3.4) / 6, 0.04, 1);        // GK가 커버 못 하는 여유(가팔라야 막힌슛 안 쏨)
    const u = A.wShot * shotMul * buildMul * (1 - dGoal / shotRange) * shotAngleQuality(carrier.position)
      * openness * (0.55 + 0.45 * clamp(pressure / 5, 0, 1)) + noise();
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
    // 크로스: 측면 깊은 위치 → 중앙 박스 아군 공중 배달(측면 공격 마무리)
    const isCross = wingSide !== 0 && Math.abs(carrier.position.z) > 15 && carrierFinal
      && Math.abs(mate.position.z) < 14 && dBallOwn(dir, mate.position.x) > 70;
    // 존 편향: 크로스 > 측면 전개 > 중앙 전진. 크로스도 마무리라 시퀀스 게이팅 적용.
    let zoneBonus = 0;
    if (isCross) zoneBonus = 0.7 * (culmReady ? 1.3 : (tac.crossEarly ? 1.0 : 0.22));   // 빠른 크로스 → 마무리 전에도 크로스 우선
    else if (wingSide !== 0 && Math.sign(mate.position.z) === wingSide && Math.abs(mate.position.z) > 16) zoneBonus = 0.5;
    else if (zone === 'central' && Math.abs(mate.position.z) < 12 && prog > 4) zoneBonus = 0.22;
    const u = A.wPass * tac.passBias * (0.3 + fwdW * clamp(prog / 20, -0.4, 1) + Math.min(1, open / 8) * 0.5)
      + (through ? throughMul : 0) + zoneBonus - turnover + noise();
    opts.push({ kind: through ? 'through' : 'pass', mate, lp, aerial: (d > 28 && through) || isCross, u });
  }
  // 드리블
  opts.push({ kind: 'dribble', u: A.wDribble * tac.dribbleBias * (0.3 + clamp(pressure / 6, 0, 1) * 0.5) + (dGoal > A.shotMaxDist ? 0.2 : 0) + noise() });

  // NEXT_ACTION 카드(측면 전환·맥락 카드): 다음 소유 행동 효용을 편향하고 1회 소비.
  if (tac.nextAction || tac.switchNext) {
    for (const o of opts) {
      if (tac.nextAction === 'shot' && o.kind === 'shot') o.u *= 3;
      else if (tac.nextAction === 'through' && o.kind === 'through') o.u *= 3;
      else if (tac.nextAction === 'dribble' && o.kind === 'dribble') o.u *= 3;
      else if (tac.nextAction === 'safe') { if (o.kind === 'shot') o.u *= 0.2; else if (o.kind === 'pass') o.u *= 2; }
      else if (tac.nextAction === 'oneTwo' && o.kind === 'pass' && o.mate && dist2(carrier.position, o.mate.position) < 14) o.u *= 2.5;
      if (tac.switchNext && o.mate && Math.abs(o.mate.position.z - carrier.position.z) > 22) o.u *= 2.5;   // 측면 전환: 반대쪽 롱패스
    }
    consumeNextAction(state, carrier.teamId);
  }

  opts.sort((x, y) => y.u - x.u);
  const pick = opts[0];

  if (pick.kind === 'shot') {
    const dg = dist2(carrier.position, goal);
    const fw = carrier.teamId === 'A' ? (state.subBoost?.A?.fw || 0) : 0;
    const wide = (FIELD.goalHalfWidth * 0.6 + dg * 0.16) * Math.max(0.5, 1 - 0.12 * fw);   // fw 교체=슛 정확도↑
    const aimZ = (state.rng.float() - 0.5) * 2 * wide;
    const aimY = 0.25 + state.rng.float() * (0.5 + dg * 0.05);     // 가끔 크로스바 위로
    launchShot(b, carrier.position, { x: goal.x, z: aimZ, y: aimY }, carrier.teamId, carrier.id, cfg.ball);
    carrier.hasBall = false; log(state, 'SHOT', { by: carrier.id, team: carrier.teamId, seq: state._seqPasses || 0 });
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
    carrier.hasBall = false;
    state._seqPasses = (state._seqPasses || 0) + 1;
    log(state, pick.aerial ? 'CROSS' : (pick.kind === 'through' ? 'THROUGH' : 'PASS'), { by: carrier.id, to: pick.mate.id, team: carrier.teamId });
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
    if (p.sentOff) continue;   // 퇴장 선수는 재배치하지 않는다(§4 불변조건)
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

// ── 반칙·프리킥·PK·경고/퇴장 (마스터 §11) ──────────────────
// 태클 접촉의 방향(등 뒤 진입)·강도(태클러 속도)·시드난수로 판정한다. 계획서: "무조건 100% 실패시키지
// 말라. 통계와 상황에 큰 보정만 준다." → 합법 / careless(프리킥) / reckless(옐로) / excessive(레드).
function resolveTackle(state, tackler, carrier, F) {
  const cv = carrier.velocity, csp = Math.hypot(cv.x, cv.z);
  let behind = 0;
  if (csp > 0.5) {                                                  // 캐리어 진행 방향 기준 등 뒤에서 들어왔나
    const ux = cv.x / csp, uz = cv.z / csp;
    const rx = tackler.position.x - carrier.position.x, rz = tackler.position.z - carrier.position.z;
    const rl = Math.hypot(rx, rz) || 1;
    behind = clamp(-((rx / rl) * ux + (rz / rl) * uz), 0, 1);       // 1 = 정확히 등 뒤
  }
  const tv = tackler.velocity;
  const intensity = clamp(Math.hypot(tv.x, tv.z) / F.speedRef, 0, 1);   // 접촉 강도
  // 자기 박스 안에서는 극도로 조심한다(반칙=PK) → 반칙 확률 급감
  const inOwnBox = penaltyBoxOf(carrier.position.x, carrier.position.z, state.attackDirection[tackler.teamId]) === 'own';
  const prob = (F.baseProb + F.behindBonus * behind) * (inOwnBox ? (F.boxCaution ?? 1) : 1);
  if (!state.rng.chance(clamp(prob, 0, 0.95))) return { foul: false };
  const severity = clamp(0.35 * intensity + 0.35 * behind + 0.3 * state.rng.float(), 0, 1);
  return { foul: true, severity, card: severity >= F.excessiveAt ? 'red' : severity >= F.recklessAt ? 'yellow' : null };
}

/** 퇴장: §4 불변조건 "퇴장 선수는 경기장에 존재하지 않는다" → 피치 밖으로 내보낸다(clamp/reset 이 건너뜀). */
function sendOff(state, p, reason) {
  p.sentOff = true; p.hasBall = false;
  if (state.ball.carrierId === p.id) { state.ball.carrierId = null; state.ball.ownerId = null; state.ball.mode = 'LOOSE'; }
  p.position = { x: 0, z: -(FIELD.halfWidth + 6) };
  p.velocity = { x: 0, z: 0 };
  log(state, 'SENT_OFF', { by: p.id, team: p.teamId, reason });
}

/** 경고 누적. 옐로 2장 = 레드(§11). */
function bookPlayer(state, p, card) {
  if (card === 'yellow') {
    p.yellowCards = (p.yellowCards || 0) + 1;
    const second = p.yellowCards >= 2;
    log(state, 'CARD', { by: p.id, team: p.teamId, card: 'yellow', second });
    if (second) sendOff(state, p, 'second_yellow');
  } else if (card === 'red') {
    log(state, 'CARD', { by: p.id, team: p.teamId, card: 'red' });
    sendOff(state, p, 'red');
  }
}

// 상대를 공에서 dist(m) 밖으로 물린다(§11 9.15m). rng 미소비 — 겹치면 고정 방향 폴백(결정론).
function pushBack(state, team, spot, dist, exceptId) {
  for (const p of Object.values(state.players)) {
    if (p.teamId !== team || p.sentOff || p.id === exceptId) continue;
    const dx = p.position.x - spot.x, dz = p.position.z - spot.z;
    const d = Math.hypot(dx, dz);
    if (d >= dist) continue;
    const ux = d > 0.01 ? dx / d : 1, uz = d > 0.01 ? dz / d : 0;
    p.position = {
      x: clamp(spot.x + ux * dist, -FIELD.halfLength + 1, FIELD.halfLength - 1),
      z: clamp(spot.z + uz * dist, -FIELD.halfWidth + 1, FIELD.halfWidth - 1),
    };
    p.velocity = { x: 0, z: 0 };
  }
}

/** 페널티킥 배치(§11): 키커=페널티 마크, 수비 GK=골라인, 나머지=박스 밖·마크 뒤·공에서 9.15m. */
function penaltyRestart(state, attTeam, defTeam, F) {
  const dir = state.attackDirection[attTeam];
  const spot = { x: dir * (FIELD.halfLength - FIELD.penaltySpot), z: 0 };
  giveRestart(state, attTeam, spot);                       // 마크 최근접 필드 플레이어가 키커
  const kickerId = state.ball.carrierId;
  const gk = Object.values(state.players).find((p) => p.teamId === defTeam && p.role === 'GK' && !p.sentOff);
  if (gk) { gk.position = { x: dir * (FIELD.halfLength - 0.4), z: 0 }; gk.velocity = { x: 0, z: 0 }; }
  const backX = spot.x - dir * F.pkClearBack;              // 마크 뒤 & 박스 밖(11+10=21m > 16.5m)
  for (const p of Object.values(state.players)) {
    if (p.sentOff || p.id === kickerId || (gk && p.id === gk.id)) continue;
    const inBox = penaltyBoxOf(p.position.x, p.position.z, state.attackDirection[defTeam]) === 'own';
    if (inBox || dist2(p.position, spot) < F.wallDist) {
      p.position = { x: backX, z: clamp(p.position.z, -FIELD.halfWidth + 2, FIELD.halfWidth - 2) };
      p.velocity = { x: 0, z: 0 };
    }
  }
  log(state, 'RESTART', { kind: 'penalty', team: attTeam });
}

/** 반칙 → 직접 프리킥. 반칙한 팀의 자기 페널티 박스 안이면 페널티킥(§11). */
function foulRestart(state, offender, victim, res) {
  const F = state.cfg.foul;
  const defTeam = offender.teamId, attTeam = victim.teamId;
  const spot = {
    x: clamp(victim.position.x, -FIELD.halfLength + 2, FIELD.halfLength - 2),
    z: clamp(victim.position.z, -FIELD.halfWidth + 2, FIELD.halfWidth - 2),
  };
  const isPk = penaltyBoxOf(spot.x, spot.z, state.attackDirection[defTeam]) === 'own';
  log(state, 'FOUL', { by: offender.id, team: defTeam, on: victim.id, sev: Math.round(res.severity * 100) / 100, pk: isPk, card: res.card || null });
  if (res.card) bookPlayer(state, offender, res.card);
  state._carryStart = null; state._decideAt = null;
  state.ball.mode = 'DEAD_BALL'; state.ball.velocity = { x: 0, y: 0, z: 0 }; state.ball._offside = null;
  if (isPk) { penaltyRestart(state, attTeam, defTeam, F); return; }
  giveRestart(state, attTeam, spot);
  pushBack(state, defTeam, spot, F.wallDist, null);
  log(state, 'RESTART', { kind: 'freekick', team: attTeam });
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
