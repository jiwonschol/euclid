// 공격 오프-볼 움직임 (마스터 §5·§6 지원 삼각형·침투). 소유팀 비-캐리어 선수에게 역할·목표를 준다.
// 핵심(디자이너 2026-07-15): "패스→슛"이 아니라 러너 침투·서포트 콤비·오버랩·레이트런이 보여야 하고,
// 공격수는 실제 세컨드-라스트 수비(오프사이드 라인)를 절대 넘어 캠핑하지 않는다. zone=측면/중앙으로 방향 결정.

import { dBallOwn } from './shape.js';
import { FIELD, oppGoalX, anchorToWorld } from './field.js';
import { resolvedFor } from './effects.js';

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 오프사이드 라인 world x = 세컨드-라스트 수비수 위치. 러너는 이 라인 안쪽(온사이드)에 묶인다. */
export function offsideLineX(state, team) {
  const dir = state.attackDirection[team];
  const xs = [];
  for (const p of Object.values(state.players)) if (p.teamId !== team && !p.sentOff) xs.push(p.position.x);
  if (xs.length < 2) return oppGoalX(dir);
  xs.sort((a, b) => dir * (b - a));   // 골문 쪽(전방)부터: dir+1 내림차순, dir-1 오름차순
  return xs[1];                        // [0]=최후방(보통 GK) 다음, 세컨드-라스트 수비
}
// x 를 오프사이드 라인 안쪽으로 (margin 만큼 라인보다 뒤)
const onside = (dir, x, olX, margin = 1) => (dir > 0 ? Math.min(x, olX - margin) : Math.max(x, olX + margin));

/**
 * 소유팀 비-캐리어 아웃필더의 공격 목표 {id:{x,z}} 반환(밸런스 2명은 shape 유지 위해 미포함).
 * 역할: 러너(오프사이드 라인 침투)·서포트(콤비네이션)·오버랩(측면 풀백)·레이트런(박스 침투)·밸런스(역습 대비).
 */
export function assignAttackTargets(state, team) {
  const dir = state.attackDirection[team];
  const ball = state.ball.position;
  const carrierId = state.ball.carrierId;
  const carrier = carrierId ? state.players[carrierId] : null;
  const olX = offsideLineX(state, team);
  const R = resolvedFor(state, team);
  const zone = R.attackZone || 'central';
  const commit = R.commitForward || 0;                 // 전원 공격: 박스 침투(레이트런) 인원 가산
  const finalThird = dBallOwn(dir, ball.x) > 62;
  const goalX = oppGoalX(dir);
  // 측면=공 있는 쪽으로 전개(동적), 중앙=0. (명시적 wing_left/right 도 허용)
  const wingSide = zone === 'wing' ? (ball.z < 0 ? -1 : 1)
    : zone === 'wing_left' ? -1 : zone === 'wing_right' ? 1 : 0;

  const players = Object.values(state.players).filter(
    (p) => p.teamId === team && p.role !== 'GK' && !p.sentOff && p.id !== carrierId);

  // 밸런스: 가장 후방 2명은 역습 대비로 남긴다(§5) → 공격 목표 안 줌(shape 유지)
  const balance = new Set([...players].sort((a, b) => a.homeAnchor.ax - b.homeAnchor.ax).slice(0, 2).map((p) => p.id));
  // 서포트: 캐리어 최근접 2명(밸런스 제외) → 콤비네이션 각
  const supportArr = carrier
    ? players.filter((p) => !balance.has(p.id)).sort((a, b) => dist2(a.position, carrier.position) - dist2(b.position, carrier.position)).slice(0, 2)
    : [];
  const support = new Set(supportArr.map((p) => p.id));
  // 지원 삼각형(§5·§6): 두 서포트를 캐리어 기준 '반대쪽'에 세워 패스 각을 최소 2개 만든다.
  // 정적 포메이션 az 로 side 를 잡으면 둘이 같은 쪽에 겹쳐(실측 67.7%) 각이 하나뿐이었다.
  const supportSide = {};
  if (supportArr.length) {
    const sideOf = (p) => (p.position.z >= carrier.position.z ? 1 : -1);
    supportSide[supportArr[0].id] = sideOf(supportArr[0]);
    if (supportArr[1]) {
      const s1 = sideOf(supportArr[1]);
      supportSide[supportArr[1].id] = s1 === supportSide[supportArr[0].id] ? -s1 : s1;   // 겹치면 반대쪽으로
    }
  }
  // 서포트 외 오프-볼 선수가 공에서 최소 이만큼 떨어진 곳을 목표로 잡는다(m).
  // 크게 잡을수록 뭉침은 줄지만 압박 접점이 줄어 소유가 길어진다(sim:seq 와 트레이드오프) → 튜너블.
  const OFFBALL_MIN_BALL_DIST = state.cfg?.shape?.offBallMinBallDist ?? 16;
  let lateCount = 0;
  const maxLate = 1 + (commit >= 1 ? Math.min(2, Math.round(commit)) : 0);
  const targets = {};

  for (const p of players) {
    if (balance.has(p.id)) continue;
    const ax = p.homeAnchor.ax, side = p.homeAnchor.az < 0.5 ? -1 : 1;
    let tx, tz;

    if (support.has(p.id) && carrier) {
      tx = carrier.position.x + dir * 6;                 // 캐리어 앞·옆 → 짧은 패스 삼각형
      tz = carrier.position.z + (supportSide[p.id] ?? side) * 14;   // 캐리어에서 10.8m→15.2m (실축 서포트 거리). 인원은 2명 그대로라 패스 각 2개는 유지된다
    } else if (p.role === 'FB' && wingSide !== 0 && side === wingSide) {
      tx = onside(dir, ball.x + dir * 14, olX, 2);        // 측면 존 오버랩(풀백 전진)
      tz = side * 26;
    } else if (p.role === 'W') {                          // 윙어: 폭 유지·측면 전개, 반대쪽 윙어는 박스 침투
      tx = onside(dir, olX, olX, 1.2);
      if (wingSide !== 0 && side === wingSide) tz = side * 27;          // 존 사이드: 넓게(크로스 올림)
      else if (wingSide !== 0) tz = wingSide * -10;                     // 반대쪽 윙어: 파포스트로 침투(크로스 타깃)
      else tz = side * 21;                                              // 중앙 공격: 폭 유지
    } else if (ax >= 0.62) {                              // 스트라이커: 중앙(또는 존 쪽) 라인 침투
      tx = onside(dir, olX, olX, 1.2);
      tz = wingSide === 0 ? side * 6 : wingSide * 9;
    } else if (finalThird && lateCount < maxLate) {      // 레이트런(박스 침투) — 전원 공격 시 인원↑
      lateCount++;
      tx = onside(dir, goalX - dir * 13, olX, 1.5);
      tz = side * (lateCount % 2 ? 8 : -8);
    } else {                                             // 나머지 미드: 전진하되 자기 레인을 지킨다
      // 예전엔 tz = ball.z + side*12 로 z 를 공에 직접 묶었다. 기본(중앙) 전술에서 FB×2·DM·CM×2 가
      // 전부 이 분기에 떨어져 오프-볼 6~7명이 공 반경 10~14m 링에 목표를 잡았고, 그게 뭉침의 지배 원인이었다
      // (반사실: 이 분기만 꺼도 공 10m 안 11명→9명, 폭 33m→37m). 이제 공은 살짝만 참조하고 레인이 주다.
      tx = onside(dir, ball.x + dir * 6, olX, 1.5);
      const laneZ = anchorToWorld(p.homeAnchor, dir).z;
      tz = clamp(ball.z * 0.25 + laneZ * 0.95, -31, 31);
    }

    // 공 주위를 비운다 — 패스할 공간이 있어야 전개가 이어진다. 서포트 2명은 예외(짧은 패스 각 담당).
    if (!support.has(p.id)) {
      let dx = tx - ball.x, dz = tz - ball.z;
      const d = Math.hypot(dx, dz);
      if (d < OFFBALL_MIN_BALL_DIST) {
        if (d < 0.01) { const a = anchorToWorld(p.homeAnchor, dir); dx = a.x - ball.x; dz = a.z - ball.z; }
        const n = Math.hypot(dx, dz) || 1;
        tx = ball.x + (dx / n) * OFFBALL_MIN_BALL_DIST;
        tz = ball.z + (dz / n) * OFFBALL_MIN_BALL_DIST;
        // 반경 방향으로 밀면 공과 상대 골문 사이에 있던 선수가 골문 쪽으로 밀려 오프사이드가 는다
        // (실측: 배제 반경을 키울 때 오프사이드 +20%). 밀어낸 뒤 반드시 온사이드로 되당긴다.
        tx = onside(dir, tx, olX, 1.5);
      }
    }

    targets[p.id] = {
      x: clamp(tx, -FIELD.halfLength + 3, FIELD.halfLength - 3),
      z: clamp(tz, -FIELD.halfWidth + 2, FIELD.halfWidth - 2),
    };
  }
  return targets;
}
