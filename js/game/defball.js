// 수비 오프-볼 — 실점 위험에서 유도되는 위치 (docs/first_principle.md)
//
// 공격 오프-볼(offball.js)은 신경망인데 수비는 손으로 쓴 형상 앵커였다. 그래서 공이 우리 박스에
// 있어도 앵커에 묶인 수비수들이 포메이션 모양을 지키느라 박스가 비었다(실측: 박스 안 수비 평균
// 2.2명, 실제 축구 4~8명). 그 불균형이 GK 정책을 진자처럼 오가게 만들었다 — GK 혼자
// '나가서 막기'와 '골문 지키기'를 다 감당할 수 없기 때문이다.
//
// 여기서도 같은 원칙이다: "박스에 N명 서라"를 쓰지 않는다. 실점 위험과 관련된 **관측**만 주고
// (위험 공간을 막는가, 위협을 커버하는가, 패스 레인을 끊는가) 무엇이 좋은 수비인지는
// data/policy.json 의 def 계수가 정하며, 그 계수는 sim/selfplay.mjs 의 자기대국이 승패로 찾는다.
//
// 압박 1인·커버·마킹(≤3)은 규칙 계층으로 유지된다 — 이 모듈은 그 밖의 수비수들,
// 예전 같으면 형상 앵커로 가던 선수들의 목표를 정한다. 앵커는 관측의 하나(약한 prior)로만 남는다.

import { FIELD, penaltyBoxOf } from './field.js';
import { forward } from './policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const DEF_FEATURES = [
  'dangerCover',   // 공→내 골문 선분(가장 위험한 통로)을 얼마나 막고 서는가
  'goalDist',      // 내 골문까지 거리
  'ballDist',      // 공까지 거리
  'inBox',         // 우리 페널티 박스 안인가
  'threatCover',   // 가장 가까운 비마크 상대의 골사이드를 막는가
  'laneCut',       // 캐리어→그 상대 패스 레인까지의 거리(끊으면 가치)
  'spread',        // 이미 배정된 아군 지점과의 간격(뭉침의 손익은 학습이 정한다)
  'anchorDist',    // 형상 앵커까지 거리 — 약한 prior
  'travelCost',    // 지금 위치에서 그 지점까지의 이동 거리
  'bias',
];

/** 점 c 에서 선분 a-b 까지의 거리 */
function segDist(c, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const L2 = vx * vx + vz * vz;
  const t = L2 > 1e-9 ? clamp(((c.x - a.x) * vx + (c.z - a.z) * vz) / L2, 0, 1) : 0;
  return Math.hypot(c.x - (a.x + vx * t), c.z - (a.z + vz * t));
}

/** 후보 지점의 관측 벡터. rng 미소비(결정론). */
function defFeatures(state, c, p, ctx) {
  const { ownGoal, ball, threats, claimed, anchor, dir } = ctx;

  // 가장 가까운 비마크 위협(있으면)과 그 골사이드 커버 정도
  let tc = 0, lane = 1;
  if (threats.length) {
    let t = threats[0], bd = Infinity;
    for (const th of threats) { const d = dist2(c, th.position); if (d < bd) { bd = d; t = th; } }
    // 위협-골문 선분 근처 = 골사이드 커버
    tc = 1 - clamp(segDist(c, t.position, ownGoal) / 12, 0, 1);
    lane = clamp(segDist(c, ball, t.position) / 15, 0, 1);   // 0=레인 위(끊음), 1=멀다
  }

  let spread = 30;
  for (const q of claimed) spread = Math.min(spread, dist2(c, q));

  return [
    1 - clamp(segDist(c, ball, ownGoal) / 20, 0, 1),
    clamp(Math.hypot(c.x - ownGoal.x, c.z) / 60, 0, 1),
    clamp(dist2(c, ball) / 50, 0, 1),
    penaltyBoxOf(c.x, c.z, dir) === 'own' ? 1 : 0,
    tc,
    lane,
    clamp(spread / 30, 0, 1),
    clamp(dist2(c, anchor) / 30, 0, 1),
    clamp(dist2(c, p.position) / 40, 0, 1),
    1,
  ];
}

/** 검토 지점: 현재 위치 · 앵커 · 링 · 공→골문 선분 위 · 비마크 위협들의 골사이드 */
function candidates(p, ctx) {
  const { ownGoal, ball, threats } = ctx;
  const out = [{ ...p.position }, { ...ctx.anchor }];
  for (const r of [6, 14]) {
    for (let k = 0; k < 6; k++) {
      const th = (k / 6) * Math.PI * 2;
      out.push({ x: p.position.x + Math.cos(th) * r, z: p.position.z + Math.sin(th) * r });
    }
  }
  for (const t of [0.25, 0.5, 0.75]) {
    out.push({ x: ball.x + (ownGoal.x - ball.x) * t, z: ball.z + (0 - ball.z) * t });
  }
  for (const th of threats.slice(0, 4)) {
    const gx = ownGoal.x - th.position.x, gz = -th.position.z, gl = Math.hypot(gx, gz) || 1;
    out.push({ x: th.position.x + (gx / gl) * 3, z: th.position.z + (gz / gl) * 3 });
  }
  const m = 1;
  return out.filter((c) => Math.abs(c.x) < FIELD.halfLength - m && Math.abs(c.z) < FIELD.halfWidth - m);
}

/**
 * 수비팀 비(압박·커버·마크) 아웃필더의 목표 {id:{x,z}}.
 * offball.js 와 같은 그리디 순차 배정 — 먼저 정한 지점을 '점유'로 등록해 뒤 선수가 겹침을 관측하게 한다.
 * net 이 없으면 빈 객체 — ai.js 가 기존 형상 앵커로 폴백한다(레거시 동작 보존, 게이트 유지).
 */
export function assignDefenceByPolicy(state, defTeam, players, anchorOf, cfg, net, markedIds) {
  if (!net) return {};
  const every = cfg?.policy?.recomputeEverySec ?? 0.4;
  const cache = state._defball || (state._defball = {});
  if (cache.team === defTeam && state.clockSeconds - cache.at < every && cache.targets) return cache.targets;

  const dir = state.attackDirection[defTeam];
  const ownGoal = { x: -dir * FIELD.halfLength, z: 0 };
  const ball = state.ball.position;
  const attackTeam = defTeam === 'A' ? 'B' : 'A';
  const marked = markedIds || new Set();               // 이미 마크된 위협은 여기서 중복 커버하지 않는다
  const threats = Object.values(state.players)
    .filter((q) => q.teamId === attackTeam && q.role !== 'GK' && !q.sentOff && !q.hasBall && !marked.has(q.id))
    .sort((a, b) => dist2(a.position, ownGoal) - dist2(b.position, ownGoal));

  // 골문 가까운 수비수부터 정한다(가장 급한 자리를 먼저 채움)
  const order = [...players].sort((a, b) => dist2(a.position, ownGoal) - dist2(b.position, ownGoal));
  const claimed = [];
  const targets = {};
  for (const p of order) {
    const ctx = { ownGoal, ball, threats, claimed, anchor: anchorOf(p), dir };
    let best = null, bv = -Infinity;
    for (const c of candidates(p, ctx)) {
      const v = forward(defFeatures(state, c, p, ctx), net.arch, net.weights || net);
      if (v > bv) { bv = v; best = c; }
    }
    if (best) { targets[p.id] = best; claimed.push(best); }
  }
  cache.team = defTeam; cache.at = state.clockSeconds; cache.targets = targets;
  return targets;
}
