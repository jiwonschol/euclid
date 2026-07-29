// 공격 오프-볼 움직임 (마스터 §5·§6 지원 삼각형·침투). 소유팀 비-캐리어 선수에게 역할·목표를 준다.
// 핵심(디자이너 2026-07-15): "패스→슛"이 아니라 러너 침투·서포트 콤비·오버랩·레이트런이 보여야 하고,
// 공격수는 실제 세컨드-라스트 수비(오프사이드 라인)를 절대 넘어 캠핑하지 않는다. zone=측면/중앙으로 방향 결정.

import { dBallOwn } from './shape.js';
import { FIELD, oppGoalX, anchorToWorld } from './field.js';
import { resolvedFor } from './effects.js';
import { assignByPolicy } from './offball.js';

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
  // 역습 대비(rest-defence)로 뒤에 남기는 인원. 2명이면 공격 시 자기 진영에 팀의 14% 밖에 안 남아
  // (실축 ~25%) 골키퍼 앞 40m 가 텅 빈다. 실제 팀은 백4 + 홀딩 미드를 남긴다.
  const restDefence = state.cfg?.shape?.restDefence ?? 3;
  const balance = new Set([...players].sort((a, b) => a.homeAnchor.ax - b.homeAnchor.ax)
    .slice(0, finalThird ? restDefence + 1 : restDefence).map((p) => p.id));
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
  // 러너가 오프사이드 라인에 1.2m 까지 붙어 서 있으면 라인이 조금만 움직여도 넘어간다
  // (실측 오프사이드 10.3회/경기, 실축 4.0). 실제 공격수는 몇 미터 여유를 두고 타이밍을 잡는다.
  // 오프사이드 라인에 붙을 수 있는 인원 상한. 예전엔 윙어 2 + 스트라이커 + 레이트런이 모두 라인을
  // 목표로 잡아, 수비가 내려앉으면 6명이 동시에 박스 앞에 붙어 스크럼이 됐다(실측 박스 안 p95 7명,
  // 라인 ±4m 에 p95 6명. 실축은 각각 4~6명·1~3명). 나머지는 공 기준 깊이를 지킨다.
  // 라인에 안 붙는 선수는 공보다 **뒤**에 선다 — 세컨드볼을 잡는 위치이고, 공 뒤는 정의상 온사이드다.
  // 앞(ball.x + dir*10)에 두면 온사이드 클램프에 걸려 결국 라인에 다시 붙어 오프사이드가 는다(실측 11.17회).

  // ── 가치 기반 배정 (docs/first_principle.md) ────────────────────────────
  // 예전에는 여기서 역할별 좌표 공식(윙어 tz=side*27, 스트라이커 tz=side*6 …)으로 목표를 찍었다.
  // 그건 축구를 밖에서 본 모양을 흉내 낸 것이라 "왜 저기 서는가"에 답이 없었다.
  // 이제 각 지점의 득점 기대값으로 고르고, 폭·간격·라인은 그 결과로 창발한다.
  // 팀별 정책망(자기대국) → 없으면 단일 정책
  const NET = state.policy?.[team] || state.policy || null;
  const targets = assignByPolicy(state, team, players, balance, olX, state.cfg, NET);
  return targets;
}
