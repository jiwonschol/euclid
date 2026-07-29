// 캐리어 결정의 관측 — 슛/패스/드리블 중 무엇을 할지는 **신경망이 정한다**
// (docs/first_principle.md). 여기서는 각 선택지를 관측 벡터로만 바꾼다.
//
// 예전에는 decide.js 가 효용을 곱셈식으로 직접 썼다(wShot·buildMul·distFactor·openness·pressure…).
// 그건 내가 이해한 축구를 인코딩한 것이고, 실제로 '빌드업 할당량이 골보다 우선'하는 결과를 낳았다.
// 이제 관측만 주고 계수는 자기대국이 찾는다.

import { FIELD, oppGoalX } from './field.js';
import { shotValue, segBlocked } from './value.js';
import { forward } from './policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const CARRIER_FEATURES = [
  'isShot', 'isPass', 'isDribble',   // 무엇을 하려는가(원-핫)
  'valueAfter',                      // 그 행동 뒤 지점의 득점 기대값
  'valueGain',                       // 지금 위치 대비 얼마나 오르는가
  'goalProximityAfter',              // 그 뒤 골문에 얼마나 가까운가
  'actionLength',                    // 패스·드리블 거리(길수록 위험)
  'laneOpen',                        // 그 경로가 열렸는가
  'targetFree',                      // 도착 지점에 상대가 없는가
  'carrierPressure',                 // 지금 내가 압박받는가
  'legal',                           // 오프사이드가 아닌가
  'bias',
];

/**
 * 한 선택지의 관측. opt = {kind:'shot'|'pass'|'through'|'dribble', mate?, lp?}
 * ctx = { carrier, dir, defTeam, cfg, pressure, olX }
 */
export function carrierFeatures(state, opt, ctx) {
  const { carrier, dir, defTeam, cfg, pressure, olX } = ctx;
  const here = carrier.position;
  const goalX = oppGoalX(dir);

  let after = here, len = 0, legal = 1;
  if (opt.kind === 'shot') {
    after = here;
  } else if (opt.kind === 'dribble') {
    const th = Math.atan2(-here.z, goalX - here.x);
    after = { x: here.x + Math.cos(th) * 12, z: here.z + Math.sin(th) * 12 };
    len = 12;
  } else {
    after = opt.lp || opt.mate.position;
    len = Math.hypot(after.x - here.x, after.z - here.z);
    if (olX !== undefined) legal = (dir > 0 ? after.x <= olX : after.x >= olX) ? 1 : 0;
  }

  const vHere = shotValue(state, here, carrier.teamId, cfg);
  const vAfter = shotValue(state, after, carrier.teamId, cfg);
  const dGoalAfter = Math.hypot(goalX - after.x, after.z);

  let nearOpp = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId === carrier.teamId || p.sentOff) continue;
    const d = Math.hypot(p.position.x - after.x, p.position.z - after.z);
    if (d < nearOpp) nearOpp = d;
  }

  return [
    opt.kind === 'shot' ? 1 : 0,
    (opt.kind === 'pass' || opt.kind === 'through') ? 1 : 0,
    opt.kind === 'dribble' ? 1 : 0,
    vAfter,
    clamp((vAfter - vHere) * 2 + 0.5, 0, 1),
    clamp(1 - dGoalAfter / FIELD.length, 0, 1),
    clamp(len / 45, 0, 1),
    1 - segBlocked(state, here, after, defTeam, 2.0),
    clamp(nearOpp / 15, 0, 1),
    clamp(pressure / 8, 0, 1),
    legal,
    1,
  ];
}

/** 관측 → 효용. net 이 없으면 null 을 돌려 호출부가 기존 공식을 쓰게 한다. */
export function carrierScore(state, opt, ctx, net) {
  if (!net || !net.arch) return null;
  return forward(carrierFeatures(state, opt, ctx), net.arch, net.weights);
}
