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

/** 전술→라인 이동(m). lineHeight low/mid/high = ∓lineHeight, tactic attack+/counter−/park−. */
export function cardBackShift(tac, S) {
  if (!tac) return 0;
  const lh = tac.lineHeight === 'low' ? -S.lineHeight : tac.lineHeight === 'high' ? S.lineHeight : 0;
  const T = S.tactic || {};
  const tb = tac.tactic === 'attack' ? (T.attackBack || 0)
    : tac.tactic === 'counter' ? -(T.counterBack || 0)
    : tac.tactic === 'park' ? -(T.parkBack || 0) : 0;
  return lh + tb;
}

// ── 수비 블록 상태 (high / mid / low) ────────────────────────
// 예전에는 backLine 이 clamp(공까지거리 − buffer) 로 공 x 의 기울기 1 순함수였다. 그래서 팀 전체가
// 공에 강체처럼 묶여 평행이동했고(수비중심 x ↔ 공 x 상관 r=0.98, 실축 0.7~0.85), 게인·이징·속도캡·
// 존 계단 등 튜닝을 전부 시도해도 0.96 아래로 안 내려갔다 — 단조 함수인 한 구조적으로 불가능하다.
// 실제 축구의 라인은 팀이 '지금 어떤 블록을 쓰는가'라는 자체 상태를 갖고, 그 상태는 공 위치와
// 다른 시간 척도로 바뀐다. 같은 공 위치에서 여러 라인 값이 나올 수 있어야 한다.
const BLOCK_BASE = { high: 40, mid: 27, low: 14 };   // 모드별 기준 backLine(자기 골문 거리 m)

/** 매 틱 팀별 블록 모드를 갱신한다. 최소 유지 시간이 있어 공 위치에 즉시 반응하지 않는다. */
export function stepBlockStates(state) {
  const S = state.cfg.shape;
  const dwell = S.blockMinDwellSec ?? 7;
  if (!state.block) state.block = { A: { mode: 'mid', since: 0 }, B: { mode: 'mid', since: 0 } };
  for (const team of ['A', 'B']) {
    const b = state.block[team];
    if (state.clockSeconds - b.since < dwell) continue;          // 아직 유지 구간
    const dir = state.attackDirection[team];
    const d = dBallOwn(dir, state.ball.position.x);              // 자기 골문에서 공까지(m)
    const tac = state.tactics?.[team] || {};
    const hasBall = state.possessionTeamId === team;
    // 트리거를 공 위치로 잡으면 모드가 공 x 의 계단 함수가 되어 결국 단조다(실측: 그래도 r 0.95).
    // 실제 축구의 블록은 '공이 어디 있나'보다 '지금 누가 공을 갖고 얼마나 됐나'로 정해진다.
    const sinceTurnover = state.clockSeconds - (state._possChangedAt ?? -99);
    let want;
    if (hasBall) want = 'high';                                  // 우리 공 → 밀어올린다
    else if (sinceTurnover < (S.counterPressSec ?? 6)) want = 'high';  // 방금 잃음 → 즉시 되뺏기
    else if (d < 22) want = 'low';                               // 골문 코앞에서만 위치가 개입한다
    else want = sinceTurnover > (S.settleSec ?? 14) ? 'low' : 'mid';   // 오래 내주면 내려앉는다
    if (tac.press === 'high' && want === 'mid') want = 'high';    // 스탠스 반영
    if (tac.lineHeight === 'low' && want === 'high') want = 'mid';
    if (want !== b.mode) { b.mode = want; b.since = state.clockSeconds; }
  }
}

/** 팀 backLine(자기 골문 거리 m). 오프사이드 참조로 분리 — 공격 front가 상대 back을 읽는다. tac=팀 전술 상태. */
export function teamBackDist(team, dir, ballX, possTeam, cfg, tac, blockMode) {
  const S = cfg.shape;
  const C = S[roleOf(team, possTeam)];
  const d = dBallOwn(dir, ballX);
  if (blockMode) {
    // 블록 기준선 + 공 위치 부분 추종(기울기 1 이 아니라 gain). 이 gain 이 상관계수의 상한을 정한다.
    const gain = S.blockBallGain ?? 0.4;
    const base = BLOCK_BASE[blockMode] ?? BLOCK_BASE.mid;
    return clamp(base + gain * (d - 50), C.backClampLo, C.backClampHi) + cardBackShift(tac, S);
  }
  return clamp(d - C.buffer, C.backClampLo, C.backClampHi) + cardBackShift(tac, S);
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
export function teamShape(team, dir, ballX, ballZ, possTeam, cfg, oppBackDist, tac, blockMode) {
  const S = cfg.shape, T = S.tactic || {};
  const role = roleOf(team, possTeam);
  const d = dBallOwn(dir, ballX);
  const back = teamBackDist(team, dir, ballX, possTeam, cfg, tac, blockMode);
  const wMod = (tac && tac.tactic === 'attack') ? (T.attackWidth || 0) : 0;       // 공격 시 폭 확대
  const lenMod = (tac && tac.tactic === 'park') ? -(T.parkLength || 0) : 0;       // 잠그기 시 세로 압축

  let front, width, yGain;
  if (role === 'defend') {
    // 예전엔 front 를 d + defendFrontAhead 로 캡했다 — back 을 블록 상태로 끊어도 이 캡이 기울기 1 이라
    // 팀 무게중심이 여전히 공 x 에 강체로 붙었다(r 0.97). 실제 축구의 최전방(스트라이커)은 수비 시에도
    // 공까지 따라 내려오지 않고 역습 기점으로 남는다. 블록 상태가 있으면 front = back + length 로 둔다.
    front = blockMode ? back + S.defend.length + lenMod
      : Math.min(back + S.defend.length + lenMod, d + S.defendFrontAhead);
    width = S.defend.width + wMod; yGain = S.defend.yGain;
  } else if (role === 'attack') {
    // front = 상대 backLine 앞 offsideGap(오프사이드 라인), 최소 back+minLength 보장
    front = Math.max(FIELD.length - oppBackDist - S.attack.offsideGap, back + S.attack.minLength);
    width = (d > S.attack.finalThirdDist ? S.attack.widthFinalThird : S.attack.width) + wMod;
    yGain = S.attack.yGain;
  } else {
    front = back + S.neutral.length + lenMod; width = S.neutral.width + wMod; yGain = S.neutral.yGain;
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
