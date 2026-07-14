// 공격 오프-볼 움직임 (마스터 §5·§6 지원 삼각형·침투). 소유팀 비-캐리어 선수에게 역할·목표를 준다.
// 핵심(디자이너 2026-07-15): "패스→슛"이 아니라 러너 침투·서포트 콤비·오버랩·레이트런이 보여야 하고,
// 공격수는 실제 세컨드-라스트 수비(오프사이드 라인)를 절대 넘어 캠핑하지 않는다. zone=측면/중앙으로 방향 결정.

import { dBallOwn } from './shape.js';
import { FIELD, oppGoalX } from './field.js';
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
  const zone = resolvedFor(state, team).attackZone || 'central';
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
  const support = new Set(carrier
    ? players.filter((p) => !balance.has(p.id)).sort((a, b) => dist2(a.position, carrier.position) - dist2(b.position, carrier.position)).slice(0, 2).map((p) => p.id)
    : []);
  let lateUsed = false;
  const targets = {};

  for (const p of players) {
    if (balance.has(p.id)) continue;
    const ax = p.homeAnchor.ax, side = p.homeAnchor.az < 0.5 ? -1 : 1;
    let tx, tz;

    if (support.has(p.id) && carrier) {
      tx = carrier.position.x + dir * 6;                 // 캐리어 앞·옆 → 짧은 패스 삼각형
      tz = carrier.position.z + side * 9;
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
    } else if (finalThird && !lateUsed) {                // 미드 1명 레이트런(박스 침투)
      lateUsed = true;
      tx = onside(dir, goalX - dir * 13, olX, 1.5);
      tz = side * 8;
    } else {                                             // 나머지 미드: 볼 쪽 전진 지원
      tx = onside(dir, ball.x + dir * 6, olX, 1.5);
      tz = clamp(ball.z + side * 12, -30, 30);
    }
    targets[p.id] = {
      x: clamp(tx, -FIELD.halfLength + 3, FIELD.halfLength - 3),
      z: clamp(tz, -FIELD.halfWidth + 2, FIELD.halfWidth - 2),
    };
  }
  return targets;
}
