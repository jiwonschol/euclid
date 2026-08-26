// 1대1 경합 — 태클은 주사위가 아니라 **선택**이다 (docs/first_principle.md)
//
// 발견(2026-08-26 실측). 첫 수비수(presser)의 목표는 `press.standoff = 2.2m` 로 고정돼 있었고,
// 태클이 발동하는 거리는 `control.controlRadius = 1.5m` 였다. 즉 **압박 규칙이 첫 수비수를
// 태클이 절대 일어나지 않는 거리에 세워두고 있었다.** 추적 결과가 정확히 그 모양이었다 —
// 한 수비수가 캐리어를 1.7~2.0m 에 붙어 40m 를 따라가는 동안 태클 시도가 0회.
// 그래서 캐리어가 공을 잡고 **중앙값 11.7초 · 49.9m 를 몰고** 골 에어리어까지 걸어 들어갔고,
// 경기당 슛 208 중 199(96%)가 0-6m 였다. 자기대국은 옳았다. 환경에 1대1이라는 사건이 없었을 뿐이다.
//
// 여기서도 원칙은 같다: **언제 달려들지를 내가 쓰지 않는다.** 태클에 진짜 값을 매겨 두고
// (성공하면 공, 실패하면 제쳐져서 그 장면에서 사라진다) 관측만 주면, 무엇이 좋은 수비인지는
// data/policy.json 의 duel 계수가 정하고 그 계수는 sim/selfplay.mjs 의 승패가 찾는다.
//
// 실패의 대가가 진짜여야 '따라붙기(jockey)'가 비로소 의미를 갖는다. 대가가 없으면 매 틱 달려드는
// 것이 언제나 이득이고, 그러면 이건 다시 주사위다.
//
// 의존성: policy.js 뿐. rng 는 호출부(decide.js)가 소비한다 — 이 모듈은 확률만 돌려준다.

import { FIELD, penaltyBoxOf } from './field.js';
import { forward } from './policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const DUEL_FEATURES = [
  'gap',           // 캐리어까지 거리 / 닿는 거리 — 1 이면 겨우 닿는다
  'closing',       // 서로 붙는 중인가 벌어지는 중인가(상대속도의 시선 성분)
  'goalSide',      // 내가 캐리어와 우리 골문 사이에 있는가 (제쳐져도 되는 자리인가)
  'danger',        // 캐리어가 우리 골문에 얼마나 가까운가
  'cover',         // 내 뒤를 받쳐줄 아군이 있는가 (실패의 대가가 얼마나 큰가)
  'strengthEdge',  // 힘 우위
  'inBox',         // 우리 박스 안인가 (반칙이면 PK)
  'carrierSpeed',  // 캐리어 속도 — 전속으로 달리는 상대에게 달려드는 값
  'lateral',       // 캐리어의 측면 정도 (측면은 실점 위험이 낮다)
  'toGoal',        // 캐리어가 우리 골문 쪽으로 전진 중인가
  'bias',
];

/** 관측 벡터. rng 미소비(결정론). */
function duelFeatures(state, def, carrier, reach) {
  const dir = state.attackDirection[def.teamId];
  const ownGoal = { x: -dir * FIELD.halfLength, z: 0 };
  const dx = carrier.position.x - def.position.x, dz = carrier.position.z - def.position.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  const ux = dx / d, uz = dz / d;
  const rvx = carrier.velocity.x - def.velocity.x, rvz = carrier.velocity.z - def.velocity.z;

  // 뒤를 받치는 아군: 나보다 골문 쪽에 있는 최근접 동료
  let cover = 40;
  for (const q of Object.values(state.players)) {
    if (q.teamId !== def.teamId || q.id === def.id || q.sentOff || q.role === 'GK') continue;
    if ((q.position.x - def.position.x) * -dir <= 0) continue;      // 내 뒤(골문 쪽)가 아니면 커버가 아니다
    cover = Math.min(cover, Math.hypot(q.position.x - def.position.x, q.position.z - def.position.z));
  }

  return [
    clamp(d / reach, 0, 1.5),
    clamp(-(rvx * ux + rvz * uz) / 8, -1, 1),                        // + = 붙는 중
    clamp(((def.position.x - carrier.position.x) * -dir) / 4, -1, 1),
    1 - clamp(Math.hypot(carrier.position.x - ownGoal.x, carrier.position.z) / 60, 0, 1),
    1 - clamp(cover / 25, 0, 1),
    (def.attributes?.strength ?? 1) / (carrier.attributes?.strength ?? 1) - 1,
    penaltyBoxOf(def.position.x, def.position.z, dir) === 'own' ? 1 : 0,
    clamp(Math.hypot(carrier.velocity.x, carrier.velocity.z) / 8, 0, 1),
    clamp(Math.abs(carrier.position.z) / FIELD.halfWidth, 0, 1),
    clamp((-dir * carrier.velocity.x) / 8, -1, 1),
    1,
  ];
}

/**
 * 이 틱에 달려들 확률. net 이 없으면 null → 호출부가 레거시(turnoverBase 주사위)로 폴백한다.
 * 출력은 '초당 시도율'을 지수 분포로 이 dt 에 환산한 값이라 틱 레이트에 의존하지 않는다.
 */
export function duelCommitProb(state, def, carrier, cfg, net, dt) {
  if (!net) return null;
  const D = cfg.duel || {};
  const reach = D.reach ?? 2.4;
  const d = Math.hypot(carrier.position.x - def.position.x, carrier.position.z - def.position.z);
  if (d > reach) return 0;
  const s = forward(duelFeatures(state, def, carrier, reach), net.arch, net.weights || net);
  const p = 1 / (1 + Math.exp(-s));                       // 0..1 — 얼마나 달려들고 싶은가
  const rate = (D.maxRate ?? 2.2) * p;                    // 초당 시도율
  return 1 - Math.exp(-rate * dt);
}

/** 제쳐진 상태인가 — 압박·커버 배정에서 빠지고 잠깐 느리다. */
export function isBeaten(state, p) {
  return p._beatenUntil != null && state.clockSeconds < p._beatenUntil;
}

/** 태클 실패의 대가: 그 장면에서 사라진다. 이게 없으면 매 틱 달려드는 것이 언제나 이득이다. */
export function markBeaten(state, p, cfg) {
  p._beatenUntil = state.clockSeconds + (cfg.duel?.beatenSec ?? 1.4);
}
