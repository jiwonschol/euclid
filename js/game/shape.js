// 축구 형상 모델 (마스터 §5 "포메이션은 움직이는 팀 구조" + 계획서 §2.3-B).
// js/engine/motion.js:teamRawShape 를 미터/attackDir 네이티브로 이식.
// 경기의 지리는 볼과 점유가 정한다: 팀별 back/front 라인(자기 골문 거리 m)을 공·역할로 계산하고
// 필드 플레이어를 depthRank로 그 사이에 사상. 라인 값은 ai.js 에서 τ로 이징한다.

import { FIELD } from './field.js';
import { anchorToWorld } from './field.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** attackDir 팀의 자기 골문에서 공까지 x거리(m) ∈ [0,105] */
export function dBallOwn(dir, ballX) {
  return clamp(dir * ballX + FIELD.halfLength, 0, FIELD.length);
}

/** 자기 골문 거리(m) → 월드 x */
export function distToWorldX(dir, dist) {
  return dir * (dist - FIELD.halfLength);
}

/** 팀 시점 역할: 'attack' | 'defend' | 'neutral' */
export function roleOf(team, possTeam) {
  if (possTeam == null) return 'neutral';
  return team === possTeam ? 'attack' : 'defend';
}

/** 팀 backLine(자기 골문 거리 m). 오프사이드 참조로 분리 — 공격 front가 상대 back을 읽는다. */
export function teamBackDist(team, dir, ballX, possTeam, cfg) {
  const S = cfg.shape;
  const C = S[roleOf(team, possTeam)];
  const d = dBallOwn(dir, ballX);
  // 카드 연동(cardBackShift)은 Stage 6 — 지금은 0.
  return clamp(d - C.buffer, C.backClampLo, C.backClampHi);
}

/**
 * depthRank: 팀 내 전방 순위 0(최후방)~1(최전방). 포메이션 앵커 ax 정규화(GK 제외). 1회 계산해 캐시.
 * @returns {Record<string,number>}
 */
export function depthRanks(players) {
  const ranks = {};
  for (const team of ['A', 'B']) {
    const outs = Object.values(players).filter((p) => p.teamId === team && p.role !== 'GK');
    let lo = Infinity, hi = -Infinity;
    for (const p of outs) { lo = Math.min(lo, p.homeAnchor.ax); hi = Math.max(hi, p.homeAnchor.ax); }
    const span = (hi - lo) || 1;
    for (const p of outs) ranks[p.id] = (p.homeAnchor.ax - lo) / span;
  }
  return ranks;
}

/**
 * 팀 라인/폭/중심 원시 목표(미스무딩). back/front=자기 골문 거리(m), cy=측면 중심 z(m), width=폭계수.
 * @param {number} oppBackDist 상대 팀 backLine 거리(공격 front 오프사이드 계산용)
 */
export function teamShape(team, dir, ballX, ballZ, possTeam, cfg, oppBackDist) {
  const S = cfg.shape;
  const role = roleOf(team, possTeam);
  const d = dBallOwn(dir, ballX);
  const back = teamBackDist(team, dir, ballX, possTeam, cfg);

  let front, width, yGain;
  if (role === 'defend') {
    front = Math.min(back + S.defend.length, d + S.defendFrontAhead);
    width = S.defend.width; yGain = S.defend.yGain;
  } else if (role === 'attack') {
    // front = 상대 backLine 앞 offsideGap(오프사이드 라인), 최소 back+minLength 보장
    front = Math.max(FIELD.length - oppBackDist - S.attack.offsideGap, back + S.attack.minLength);
    width = (d > S.attack.finalThirdDist ? S.attack.widthFinalThird : S.attack.width);
    yGain = S.attack.yGain;
  } else {
    front = back + S.neutral.length; width = S.neutral.width; yGain = S.neutral.yGain;
  }
  return { back, front, cy: ballZ * yGain, width };
}

/**
 * 선수 앵커(월드 {x,z}). back~front를 depthRank로 lerp, z=cy + 포메이션 측면×width, 경계 클램프.
 */
export function anchorFor(player, shape, dir, rank) {
  const backX = distToWorldX(dir, shape.back);
  const frontX = distToWorldX(dir, shape.front);
  const x = backX + (frontX - backX) * rank;
  const baseZ = anchorToWorld(player.homeAnchor, dir).z;   // 포메이션 측면 위치(부호 dir 반영)
  const z = shape.cy + baseZ * shape.width;
  const m = 2;
  return {
    x: clamp(x, -FIELD.halfLength + m, FIELD.halfLength - m),
    z: clamp(z, -FIELD.halfWidth + m, FIELD.halfWidth - m),
  };
}

/** 형상 라인 값 프레임률 독립 이징 (τ) */
export function easeShape(cur, tgt, dt, tau) {
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return {
    back: cur.back + (tgt.back - cur.back) * k,
    front: cur.front + (tgt.front - cur.front) * k,
    cy: cur.cy + (tgt.cy - cur.cy) * k,
    width: cur.width + (tgt.width - cur.width) * k,
  };
}
