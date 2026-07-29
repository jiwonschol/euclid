// 오프-볼 목표 = 관측 벡터 · 학습된 계수의 최대값 (docs/first_principle.md)
//
// 좌표 공식도, 내가 고른 가중치도 없다. 각 선수가 갈 수 있는 지점들의 관측을 뽑고,
// `data/policy.json` 의 계수로 점수를 매겨 가장 높은 곳으로 간다.
// 그 계수는 `sim/selfplay.mjs` 의 자기대국이 승패로 찾는다 — 내가 축구를 어떻게 이해했는지는
// 여기 들어가지 않는다.
//
// 폭·간격·라인·침투는 전부 이 최대화의 **결과**다.

import { FIELD, oppGoalX, anchorToWorld } from './field.js';
import { scoreAt } from './value.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 검토할 지점들: 현재 위치 주변 링 + 골문을 향한 직선 + 자기 포메이션 앵커. */
function candidates(p, ball, dir, anchor) {
  const out = [{ ...p.position }, anchor];
  for (const r of [7, 16, 27]) {
    for (let k = 0; k < 8; k++) {
      const th = (k / 8) * Math.PI * 2;
      out.push({ x: p.position.x + Math.cos(th) * r, z: p.position.z + Math.sin(th) * r });
    }
  }
  const toGoal = Math.atan2(-p.position.z, oppGoalX(dir) - p.position.x);
  for (const r of [12, 24, 36]) {
    out.push({ x: p.position.x + Math.cos(toGoal) * r, z: p.position.z + Math.sin(toGoal) * r });
  }
  const m = 2;
  return out.filter((c) => Math.abs(c.x) < FIELD.halfLength - m && Math.abs(c.z) < FIELD.halfWidth - m);
}

/**
 * 소유팀 오프-볼 목표 {id:{x,z}}.
 * 그리디 순차 배정: 먼저 고른 선수의 목표를 '점유'로 등록해 뒤 선수가 그 공간을 피하게 한다.
 * (개인 최대화만 하면 전원이 같은 안전 지점으로 수렴한다 — 실측으로 확인.)
 * 매 틱 재평가하지 않고 `recomputeEverySec` 마다 갱신한다(비용 + 목표 지터 억제).
 */
export function assignByPolicy(state, team, players, restDefence, olX, cfg, net) {
  const every = cfg?.policy?.recomputeEverySec ?? 0.4;
  const cache = state._offball || (state._offball = {});
  if (cache.team === team && state.clockSeconds - cache.at < every && cache.targets) return cache.targets;

  const ball = state.ball.position;
  const dir = state.attackDirection[team];
  const order = players.filter((p) => !restDefence.has(p.id))
    .sort((a, b) => (dir * b.position.x) - (dir * a.position.x));

  const claimed = [];
  const targets = {};
  for (const p of order) {
    const anchor = anchorToWorld(p.homeAnchor, dir);
    const mates = players.filter((m) => m.id !== p.id).map((m) => ({ position: m.position }))
      .concat(claimed.map((c) => ({ position: c })));
    const ctx = { ball, olX, teammates: mates, cfg, self: p };
    let best = null, bv = -Infinity;
    for (const c of candidates(p, ball, dir, anchor)) {
      const v = scoreAt(state, c, team, ctx, net);
      if (v > bv) { bv = v; best = c; }
    }
    if (best) { targets[p.id] = best; claimed.push(best); }
  }
  cache.team = team; cache.at = state.clockSeconds; cache.targets = targets;
  return targets;
}
