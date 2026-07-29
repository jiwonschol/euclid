// 공 물리 (마스터 §7, 계획서 §2.4). 미터/ m·s⁻¹. 공은 순간이동하지 않는다.
// 지상 패스·슛 = 마찰 감속, 공중 패스·크로스 = 중력 포물선, 착지 후 루즈볼. rng 소비 금지.
//   launchPass / launchCross / launchShot : 공을 발사(속도 부여)
//   stepBallPhysics(ball, dt, cfg) : 한 틱 적분 + 경계/득점 이벤트 반환

import { FIELD } from './field.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const CROSSBAR = 2.44;

/** 거리(m) 비례 비행 속도 (계획서 §2.4 표) */
export function ballSpeedFor(dM, B, kind) {
  if (kind === 'shot') return clamp(B.shotMin + (B.shotMax - B.shotMin) * (dM / B.shotDistRef), B.shotMin, B.shotMax);
  if (kind === 'cross') return clamp(B.loftMin + (B.loftMax - B.loftMin) * (dM / B.loftDistRef), B.loftMin, B.loftMax);
  return clamp(B.passMin + (B.passMax - B.passMin) * (dM / B.passDistRef), B.passMin, B.passMax);
}

function setFlat(ball, from, toX, toZ, speed, mode, kind) {
  const dx = toX - from.x, dz = toZ - from.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  ball.position = { x: from.x, y: 0, z: from.z };
  ball.velocity = { x: (dx / d) * speed, y: 0, z: (dz / d) * speed };
  ball.mode = mode;
  ball.ownerId = null;
  // 공이 발을 떠나면 캐리어도 해제한다. 안 하면 stale carrierId 때문에 ai.stepPositioning 이
  // 패서를 "캐리어라서 decide 가 옮긴다"고 건너뛰는데 decide 는 CONTROLLED 일 때만 옮겨서
  // 비행 내내 아무도 그를 안 옮긴다 = 패스 후 제자리 동결(경기당 232회·최장 5.7초).
  ball.carrierId = null;
  ball.flightKind = kind;
}

/** 지상 패스: targetPt 로 굴림(마찰 감속). receiverId 는 도착 예정 수신자(가로채기 판정과 별개). */
export function launchPass(ball, from, targetPt, receiverId, teamId, touchId, B) {
  const d = Math.hypot(targetPt.x - from.x, targetPt.z - from.z);
  // 마찰로 도착쯤 감속하도록 속도를 거리 기반으로 잡되 최소/최대 캡
  setFlat(ball, from, targetPt.x, targetPt.z, ballSpeedFor(d, B, 'pass'), 'GROUND_PASS', 'pass');
  ball._cross = false;
  ball.intendedTargetPlayerId = receiverId;
  ball.intendedTargetPoint = { x: targetPt.x, z: targetPt.z };
  ball.lastTouchPlayerId = touchId; ball.lastTouchTeamId = teamId;
}

/** 공중 크로스/로빙 패스: 포물선. */
export function launchCross(ball, from, targetPt, receiverId, teamId, touchId, B) {
  const d = Math.hypot(targetPt.x - from.x, targetPt.z - from.z);
  const sp = ballSpeedFor(d, B, 'cross');
  const t = d / sp;                                   // 수평 비행시간
  setFlat(ball, from, targetPt.x, targetPt.z, sp, 'AERIAL_PASS', 'cross');
  ball.velocity.y = 0.5 * B.gravity * t;              // 착지 시각 t 에 y=0 되도록 초기 상승
  ball._cross = true;                                 // 크로스: 박스 리시버 원터치 마무리 유도
  ball.intendedTargetPlayerId = receiverId;
  ball.intendedTargetPoint = { x: targetPt.x, z: targetPt.z };
  ball.lastTouchPlayerId = touchId; ball.lastTouchTeamId = teamId;
}

/** 슛: 조준점으로 강하게. aim.y 로 낮은/높은 슛. */
export function launchShot(ball, from, aim, teamId, touchId, B) {
  const d = Math.hypot(aim.x - from.x, aim.z - from.z);
  const sp = ballSpeedFor(d, B, 'shot');
  setFlat(ball, from, aim.x, aim.z, sp, 'SHOT', 'shot');
  // t 하한(0.25s): 초근접 슛에서 aim.y/t 가 폭발하지 않도록(공 속도 순간이동 방지)
  if (aim.y && aim.y > 0) { const t = Math.max(d / sp, 0.25); ball.velocity.y = aim.y / t + 0.5 * B.gravity * t; }
  ball._shotChecked = false;              // GK 선방 1회 판정 플래그(decide.js)
  ball.intendedTargetPlayerId = null;
  ball.intendedTargetPoint = { x: aim.x, z: aim.z };
  ball.lastTouchPlayerId = touchId; ball.lastTouchTeamId = teamId;
}

/**
 * 공 물리 한 틱. CONTROLLED/DEAD_BALL 은 소유 로직이 위치를 정하므로 건너뛴다.
 * @returns {null | {type:'GOAL', scorer:'A'|'B'} | {type:'OUT', edge:'goalline'|'touch', x:number, z:number}}
 */
export function stepBallPhysics(ball, dt, cfg) {
  const B = cfg.ball;
  if (ball.mode === 'CONTROLLED' || ball.mode === 'DEAD_BALL' || ball.mode === 'OUT_OF_PLAY') return null;

  ball.position.x += ball.velocity.x * dt;
  ball.position.z += ball.velocity.z * dt;

  // 공중: 포물선 + 착지
  if (ball.position.y > 0 || ball.velocity.y !== 0) {
    ball.velocity.y -= B.gravity * dt;
    ball.position.y += ball.velocity.y * dt;
    if (ball.position.y <= 0) {
      ball.position.y = 0;
      ball.velocity.y = -ball.velocity.y * B.restitution;
      ball.velocity.x *= 0.7; ball.velocity.z *= 0.7;
      if (ball.velocity.y < 1.5) ball.velocity.y = 0;
      ball.mode = 'LOOSE';
    }
  }

  // 지상 마찰
  if (ball.position.y <= 0.01) {
    const sp = Math.hypot(ball.velocity.x, ball.velocity.z);
    if (sp > 0) {
      const ns = Math.max(0, sp - B.friction * dt);
      ball.velocity.x *= ns / sp; ball.velocity.z *= ns / sp;
      if (ns < B.settleSpeed && (ball.mode === 'GROUND_PASS' || ball.mode === 'SHOT')) ball.mode = 'LOOSE';
    }
  }

  // 골라인 통과 판정(현재 위치가 라인 밖이면 무조건 — 재개는 늘 안쪽에 두므로 재발동 없음)
  if (Math.abs(ball.position.x) >= FIELD.halfLength) {
    const betweenPosts = Math.abs(ball.position.z) <= FIELD.goalHalfWidth && ball.position.y <= CROSSBAR;
    // 득점팀은 골 방향(side)으로만 알려주고, attackDirection 기준 판정은 호출측(decide)이 한다
    // — 후반 진영 반전 때문에 x부호로 팀을 하드코딩하면 안 된다.
    if (betweenPosts) return { type: 'GOAL', side: ball.position.x > 0 ? 1 : -1 };
    return { type: 'OUT', edge: 'goalline', x: ball.position.x, z: ball.position.z };
  }
  if (Math.abs(ball.position.z) >= FIELD.halfWidth) {
    return { type: 'OUT', edge: 'touch', x: ball.position.x, z: ball.position.z };
  }
  return null;
}
