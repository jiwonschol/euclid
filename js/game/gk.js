// 골키퍼 — 전용 의사결정과 상태 (마스터 계획서 §9)
//
// 계획서 §9 첫 문장: "골키퍼를 일반 필드 플레이어 AI에 `role: GK`만 붙여 처리하지 마라."
// 그 전까지의 구현이 정확히 그 방식이었다 — ai.js 의 `gkTargetPos` 가 '골문 앞 restDist,
// 박스면 advance 만큼 전진' 이라는 **좌표 상수**로 GK 를 세웠다. 그래서 박스로 걸어 들어오는
// 캐리어를 아무도 막지 않았고, 자기대국이 그 구멍을 찾아 **슛의 91%를 0-6m 에서** 쏘게 됐다
// (세대 40 실측, 골 57.7/경기).
//
// 여기서는 두 가지를 분리한다.
//   ① 위치 — 좌표 상수가 아니라 **각도 기하**에서 나온다. GK 는 공과 골문을 잇는 선 위에 서고,
//      얼마나 나갈지가 곧 '슈터가 볼 수 있는 골문의 각'을 줄이는 양이다. 계획서 §9 위치 원칙 그대로:
//      "공이 박스 안 중앙으로 들어오면 슈터와 골문 사이를 좁힌다."
//   ② 돌진할 것인가 — 이건 **내가 고르지 않는다**(docs/first_principle.md). 관측만 뽑아
//      data/policy.json 의 gk 신경망에 넘기고, 계수는 자기대국이 승패로 찾는다.
//      계획서도 이걸 이분법으로 못 박지 않았다: "1대1 돌진 또는 자세 유지",
//      "돌진은 각도를 줄이지만 칩/드리블에 취약하다" — 즉 트레이드오프이지 정답이 아니다.

import { FIELD, penaltyBoxOf } from './field.js';
import { forward } from './policy.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** GK 관측. 이름은 '무엇을 보는가'이지 '무엇을 해야 하는가'가 아니다. */
export const GK_FEATURES = [
  'ballDistGoal',    // 공이 내 골문에서 얼마나 먼가 (0=골문 위, 1=먼 거리)
  'ballAngle',       // 공의 측면 각도 (0=정면, 1=완전 측면)
  'carrierControl',  // 상대가 공을 통제 중인가(드리블) — 루즈볼/비행과 구분
  'coverNear',       // 내 앞에 수비수가 있는가 (있으면 나갈 이유가 준다)
  'myExposure',      // 내가 이미 골라인에서 얼마나 나와 있는가 (칩 위험)
  'timeToBall',      // 내가 공까지 닿는 데 걸리는 시간(정규화)
  'bias',
];

const ownGoalX = (dir) => -dir * FIELD.halfLength;

/** 관측 벡터. rng 미소비(결정론). */
export function gkFeatures(state, gk) {
  const dir = state.attackDirection[gk.teamId];
  const gx = ownGoalX(dir);
  const b = state.ball.position;
  const dGoal = Math.hypot(b.x - gx, b.z);
  const carrier = state.players[state.ball.carrierId];
  const enemyCarrier = carrier && carrier.teamId !== gk.teamId ? carrier : null;

  // 내 앞(골문과 공 사이)에 아군 수비수가 있는가
  let cover = 0;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== gk.teamId || p.role === 'GK' || p.sentOff) continue;
    const dp = Math.hypot(p.position.x - gx, p.position.z);
    if (dp < dGoal && dist2(p.position, b) < 6) { cover = 1; break; }
  }

  const pace = gk.attributes?.pace ?? 1;
  const reachSec = dist2(gk.position, b) / Math.max(1e-6, (state.cfg?.player?.run ?? 6.5) * pace);
  return [
    clamp(dGoal / 40, 0, 1),
    clamp(Math.abs(b.z) / FIELD.halfWidth, 0, 1),
    enemyCarrier ? 1 : 0,
    cover,
    clamp(Math.abs(gk.position.x - gx) / 16, 0, 1),
    clamp(reachSec / 3, 0, 1),
    1,
  ];
}

/**
 * 얼마나 나갈 것인가(0=골라인, 1=최대 전진). 신경망이 정한다.
 * 정책이 없으면 0 — 예전처럼 골문에 붙어 서고, 그 결과(골 폭주)는 눈금이 잡는다.
 * 여기에 내 손으로 임계값을 넣으면 그게 다시 descriptive 회귀다.
 */
export function advanceRatio(state, gk) {
  const net = state.policy?.[gk.teamId]?.gk || state.policy?.gk || null;
  if (!net) return 0;
  const v = forward(gkFeatures(state, gk), net.arch, net.weights || net);
  return 1 / (1 + Math.exp(-v));            // 0~1
}

/**
 * GK 목표 위치 — 각도 기하.
 * 공과 골 중앙을 잇는 선 위에서, advanceRatio 만큼 공 쪽으로 나간다.
 * 나갈수록 슈터가 보는 골문의 각이 좁아지고(이득), 동시에 등 뒤 공간이 열린다(위험).
 * 그 균형을 내가 상수로 박지 않는다 — ratio 가 학습된 값이다.
 */
export function gkTarget(state, gk) {
  const G = state.cfg.gk;
  const dir = state.attackDirection[gk.teamId];
  const gx = ownGoalX(dir);
  const b = state.ball.position;

  const ratio = advanceRatio(state, gk);
  const maxOut = G.maxAdvance ?? 12;
  const dGoal = Math.max(1e-6, Math.hypot(b.x - gx, b.z));
  const out = Math.min(maxOut, ratio * maxOut, dGoal * 0.8);   // 공을 지나쳐 나가지는 않는다

  // 공-골중앙 선분 위의 점
  const ux = (b.x - gx) / dGoal, uz = b.z / dGoal;
  return {
    x: clamp(gx + ux * out, -FIELD.halfLength + 0.3, FIELD.halfLength - 0.3),
    z: clamp(uz * out, -FIELD.goalHalfWidth - G.trackClampY, FIELD.goalHalfWidth + G.trackClampY),
  };
}

/**
 * 슛 판정 — GK 가 실제로 서 있는 x 평면에서 공의 측면 편차를 본다.
 * 예전에는 **골라인에서의** 교차 z 만 봐서, GK 가 앞으로 나와 있든 골라인에 붙어 있든
 * 선방 확률이 같았다. 그러면 '나가서 각을 좁힌다'가 아무 의미가 없다.
 * 이제 가까이 나갈수록 공이 덜 벌어져 막기 쉽고(각 좁히기의 이득),
 * 대신 등 뒤로 넘어가는 공(칩·로빙)은 못 막는다(돌진의 대가).
 * 반환: 'catch' | 'parry' | null(통과)
 */
export function resolveShot(state, gk, cfg) {
  const b = state.ball;
  const dir = state.attackDirection[gk.teamId];
  const gx = ownGoalX(dir);
  if (Math.abs(b.velocity.x) < 1) return null;

  // GK 평면에서의 공 측면 위치
  const tPlane = (gk.position.x - b.position.x) / b.velocity.x;
  const atGk = tPlane > 0
    ? { z: b.position.z + b.velocity.z * tPlane, y: b.position.y + b.velocity.y * tPlane }
    : { z: b.position.z, y: b.position.y };

  const reach = cfg.gk.diveReach * (gk.attributes?.pace ?? 1);
  const overHead = (cfg.gk.reachHeight ?? 2.4);
  const speed = (cfg.player?.run ?? 6.5) * (gk.attributes?.pace ?? 1);

  // 막는 길은 둘이다. 하나라도 되면 판정 대상.
  //  ① 지금 선 자리에서 몸으로 막는다 — 나가서 각을 좁힌 이득이 여기서 나온다.
  //  ② 골라인까지 물러나 막는다 — 공이 오래 날아올수록 가능하다.
  // 예전 판(내가 처음 쓴 것)은 ①만 봤다. 그래서 나가 있는 GK 는 원거리 슛에 **되돌아갈 시간이
  // 아예 없는** 것으로 처리됐고, 자기대국이 그 구멍을 파고들어 25m+ 슛 성공률이 23.8%가 됐다
  // (실제 1.5%). 공이 1초 날아오는 동안 사람은 6m 넘게 움직인다 — 그걸 빼먹은 것이다.
  const blockHere = Math.abs(gk.position.z - atGk.z) <= reach && atGk.y <= overHead && tPlane > 0;

  const goalLineX = -dir * FIELD.halfLength;
  const tGoal = (goalLineX - b.position.x) / b.velocity.x;
  let onLine = false, lateralLine = Infinity;
  if (tGoal > 0) {
    const crossZ = b.position.z + b.velocity.z * tGoal;
    const crossY = b.position.y + b.velocity.y * tGoal;
    const retreat = Math.abs(gk.position.x - goalLineX);
    const need = Math.hypot(gk.position.z - crossZ, retreat);   // 교차점까지 실제로 가야 할 거리
    lateralLine = need;
    onLine = need <= reach + speed * tGoal && crossY <= overHead;
  }
  if (!blockHere && !onLine) return null;

  // 여유가 클수록 쉽다. 몸으로 막는 쪽은 거리가, 물러나 막는 쪽은 시간이 여유다.
  const easeHere = blockHere ? 1 - clamp(Math.abs(gk.position.z - atGk.z) / Math.max(1e-6, reach), 0, 1) : 0;
  const easeLine = onLine ? 1 - clamp(lateralLine / Math.max(1e-6, reach + speed * tGoal), 0, 1) : 0;
  const ease = Math.max(easeHere, easeLine);
  const p = clamp(cfg.gk.saveProb * (0.35 + 0.65 * ease), 0, 0.98);
  if (!state.rng.chance(p)) return null;
  return state.rng.chance(cfg.gk.catchRatio) ? 'catch' : 'parry';
}

/** GK 가 지금 1대1 로 캐리어에게 달려드는 중인가 — 태클 경합 참가 판정에 쓴다. */
export function isEngaging(state, gk) {
  const dir = state.attackDirection[gk.teamId];
  const carrier = state.players[state.ball.carrierId];
  if (!carrier || carrier.teamId === gk.teamId) return false;
  if (penaltyBoxOf(carrier.position.x, carrier.position.z, dir) !== 'own') return false;
  return Math.abs(gk.position.x - ownGoalX(dir)) > (state.cfg.gk.restDist ?? 5) * 0.8;
}
