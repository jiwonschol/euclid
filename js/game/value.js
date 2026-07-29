// 정책의 관측(feature)과 그 선형 결합 — 계수는 **사람이 고르지 않는다** (docs/first_principle.md)
//
// 여기 있는 함수들은 전부 '관측'이다: 골까지 거리, 골문이 벌어진 각, 골키퍼가 덮는 폭, 레인 차단,
// 가장 가까운 상대, 아군 밀집도, 공까지 거리, 오프사이드 여유. 무엇이 좋은지는 말하지 않는다.
//
// "그래서 어디에 서야 하는가"는 계수 w 가 정하고, w 는 `sim/selfplay.mjs` 의 자기대국이 찾는다.
// 내가 w 를 손으로 고르면 그건 내가 이해한 축구를 인코딩하는 것이고, 내 이해가 그대로 상한이 된다.
//
// 오프사이드만은 계수가 아니라 **규칙**이다 — 규칙은 취향이 아니므로 하드 제약으로 둔다.
//
// rng 를 소비하지 않는다(결정론). 순수 함수만 둔다.

import { FIELD, oppGoalX } from './field.js';
import { forward } from './policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** 골문이 그 지점에서 벌어져 보이는 각(라디안). */
export function goalAngle(pos, dir) {
  const gx = oppGoalX(dir);
  const dx = Math.abs(gx - pos.x);
  const a = Math.atan2(FIELD.goalHalfWidth - pos.z, dx);
  const b = Math.atan2(-FIELD.goalHalfWidth - pos.z, dx);
  return Math.abs(a - b);
}

/**
 * 방해 없는 슛의 득점 확률(≈xG). 실제 축구 xG 분포에 맞춘 폐형식이며 **관측**이다
 * (정면 6m 0.46 · 12m 0.15 · 18m 0.06 · 25m 0.02 — docs/reference/match_stats.json 검증됨).
 * 이건 물리·통계적 사실이지 전술적 선호가 아니므로 학습 대상이 아니다.
 */
export function shotXG(pos, dir) {
  const gx = oppGoalX(dir);
  const d = Math.hypot(gx - pos.x, pos.z);
  if (d < 0.5) return 0.9;
  const angMax = 2 * Math.atan2(FIELD.goalHalfWidth, 6);
  const angF = clamp(goalAngle(pos, dir) / angMax, 0, 1) ** 0.7;
  return clamp(0.9 * Math.exp(-d / 9) * angF, 0.004, 0.9);
}

/** 골키퍼가 그 슛을 덮는 비율(0~1). 공 비행 시간에 다이빙으로 닿는 폭. */
export function gkCoverage(state, pos, dir, defTeam, cfg) {
  const gk = Object.values(state.players).find((p) => p.teamId === defTeam && p.role === 'GK' && !p.sentOff);
  if (!gk) return 0;
  const d = Math.hypot(oppGoalX(dir) - pos.x, pos.z);
  const flightT = d / (cfg?.ball?.shotMax || 27);
  const reach = (cfg?.action?.gkReachBase ?? 0.6) + (cfg?.action?.gkReachGain ?? 5.2) * flightT;
  const lo = Math.max(-FIELD.goalHalfWidth, gk.position.z - reach);
  const hi = Math.min(FIELD.goalHalfWidth, gk.position.z + reach);
  return clamp(Math.max(0, hi - lo) / (FIELD.goalHalfWidth * 2), 0, 1);
}

/** 선분 from→to 에 가장 가까운 수비수까지 거리로 본 차단 정도(0~1). */
export function segBlocked(state, from, to, defTeam, radius = 2.2) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const L2 = dx * dx + dz * dz || 1e-6;
  let nearest = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== defTeam || p.sentOff || p.role === 'GK') continue;
    const t = clamp(((p.position.x - from.x) * dx + (p.position.z - from.z) * dz) / L2, 0, 1);
    const d = Math.hypot(p.position.x - (from.x + t * dx), p.position.z - (from.z + t * dz));
    if (d < nearest) nearest = d;
  }
  return clamp(1 - nearest / (radius * 2.5), 0, 1);
}

/** 그 지점에서 지금 슛했을 때의 득점 기대값(관측). */
export function shotValue(state, pos, team, cfg) {
  const dir = state.attackDirection[team];
  const defTeam = team === 'A' ? 'B' : 'A';
  const cov = gkCoverage(state, pos, dir, defTeam, cfg);
  const blk = segBlocked(state, pos, { x: oppGoalX(dir), z: 0 }, defTeam);
  return shotXG(pos, dir) * (1 - 0.75 * cov) * (1 - 0.8 * blk);
}

/** 특징 이름 — 계수 벡터의 순서 정의. 여기 추가하면 정책의 표현력이 늘어난다. */
export const FEATURES = [
  'shotValue',      // 그 지점의 득점 기대값
  'goalProximity',  // 상대 골문에 얼마나 가까운가
  'progression',    // 피치를 얼마나 전진했는가
  'freeSpace',      // 가장 가까운 상대까지 거리
  'teamSpread',     // 아군이 안 몰려 있는가
  'ballReach',      // 공에서 그 지점까지 패스가 갈 만한 거리인가
  'passLaneOpen',   // 공→그 지점 레인이 열렸는가
  'onsideRoom',     // 오프사이드 라인까지 여유
  'width',          // 측면으로 벌어진 정도
  'behindBall',     // 공보다 뒤인가(수비 안정)
  'selfPace',       // 이 선수가 빠른가(역할별 능력치)
  'bias',
];

/**
 * 한 지점의 관측 벡터. **무엇이 좋은지 말하지 않는다** — 계수가 정한다.
 * 오프사이드 위치면 null 을 돌려준다(규칙이므로 하드 제약).
 */
export function featuresAt(state, pos, team, ctx) {
  const { ball, olX, teammates, cfg, self } = ctx;
  const dir = state.attackDirection[team];
  const defTeam = team === 'A' ? 'B' : 'A';

  if (olX !== undefined) {
    const beyond = dir > 0 ? pos.x - olX : olX - pos.x;
    if (beyond > 0) return null;                                  // 오프사이드 = 규칙 위반
  }

  const dGoal = Math.hypot(oppGoalX(dir) - pos.x, pos.z);
  const dBall = Math.hypot(pos.x - ball.x, pos.z - ball.z);
  let nearOpp = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId === team || p.sentOff) continue;
    const d = dist2(p.position, pos); if (d < nearOpp) nearOpp = d;
  }
  let crowd = 0;
  for (const m of teammates) { const d = dist2(m.position, pos); if (d < 14) crowd += 1 - d / 14; }

  return [
    shotValue(state, pos, team, cfg),
    clamp(1 - dGoal / FIELD.length, 0, 1),
    clamp((dir * pos.x + FIELD.halfLength) / FIELD.length, 0, 1),
    clamp(nearOpp / 15, 0, 1),
    1 / (1 + crowd),
    clamp(1 - dBall / 45, 0, 1),
    1 - segBlocked(state, ball, pos, defTeam, 2.0),
    olX === undefined ? 1 : clamp(Math.abs(olX - pos.x) / 25, 0, 1),
    clamp(Math.abs(pos.z) / FIELD.halfWidth, 0, 1),
    dir * (pos.x - ball.x) < 0 ? 1 : 0,
    clamp(((self?.attributes?.pace ?? 1) - 0.85) / 0.35, 0, 1),
    1,
  ];
}

/**
 * 관측 → 점수. 정책은 신경망이고 파라미터는 data/policy.json 이 갖는다(자기대국이 갱신).
 * net = { arch, weights }. arch 가 없으면 선형(구 형식)으로 취급한다.
 */
export function scoreAt(state, pos, team, ctx, net) {
  const f = featuresAt(state, pos, team, ctx);
  if (!f) return -Infinity;
  if (!net) return 0;
  const w = net.weights || net;
  if (!net.arch) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * (w[i] ?? 0); return s; }
  return forward(f, net.arch, w);
}
