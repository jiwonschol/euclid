// 자기대국 평가 한 판 — 메인 프로세스와 워커가 **같은 코드**를 쓴다.
//
// sim/selfplay.mjs 에서 떼어냈다. 한 세대의 도전자 평가는 서로 완전히 독립이고 시드가 고정이라
// 병렬로 돌려도 결과가 한 톨도 안 바뀐다(검증: 순차 == 병렬). 1코어로 4.7분 걸리던 세대가
// 8워커에서 40초대로 떨어진다 — 하룻밤에 도는 세대 수가 그만큼 늘어난다.

import { createMatch, tick } from '../js/game/match.js';
import { FIELD } from '../js/game/field.js';

export const MODULES = ['off', 'car', 'gk', 'def', 'duel'];

/** 경기가 **성립했는가**만 본다. 축구다운가는 여기서 판정하지 않는다.
 *
 * 2026-07-29 디자이너: *"수비가 촘촘해서 슛이 없고 골이 없는 것도 축구다.
 * 지금처럼 폐기해 버리면 거기 도달을 못 한다."* 옳다. 예전의 패스 하한·슛 상한·골 상한은
 * "축구는 슛이 많다"는 내 가정을 규칙인 척 박아둔 것이었고, 실제로 탐색을 멈춰 세웠다
 * (세대 17~24 에서 도전자 8/8 이 승패를 보기도 전에 탈락 — 챔피언 자신이 그 제약을 위반했다).
 *
 * 그래서 남기는 것은 넷뿐이고, 전부 '이건 경기가 아니다'만 잡는다.
 * 0-0 수비전은 이 넷을 전부 통과한다 — 통과해야 한다.
 *
 * ⚠️ 알고 있는 한계: 슛 남발은 이 필터를 통과한다. 그건 의도한 것이다. 슛 남발이 이득이면
 * 그건 정책의 잘못이 아니라 **규칙이 무르다**는 뜻이고, 필터에 "슛 상한"을 다시 넣는 것은
 * 규칙의 구멍을 필터로 가리는 짓이다(= descriptive 회귀). docs/first_principle.md 참조. */
export const VIABLE = {
  turnoversPer90: 10,   // 소유권이 이보다 적게 바뀌면 경합 자체가 없는 것
  ballXStd: 8,          // 공 x 표준편차(m). 이보다 작으면 공이 한 곳에 고여 있다
  possMin: 0.05,        // 한 팀이 공을 사실상 놓지 않음. 극단 점유 축구는 허용하려 넓게 둔다
  possMax: 0.95,
};

/** 평가기 하나. cfg·아키텍처·경기 길이를 묶어 두고 duel(도전자, 챔피언) 만 부르면 된다. */
export function makeEvaluator({ cfg, com, arch, matches, half }) {
  const { off: ARCH, car: CARCH, gk: GARCH, def: DARCH, duel: UARCH } = arch;

  const mk = (v) => ({
    arch: ARCH, weights: v.off,
    carrier: { arch: CARCH, weights: v.car },
    ...(GARCH ? { gk: { arch: GARCH, weights: v.gk } } : {}),
    ...(DARCH ? { def: { arch: DARCH, weights: v.def } } : {}),
    ...(UARCH ? { duel: { arch: UARCH, weights: v.duel } } : {}),
  });

  function play(seed, wA, wB) {
    const s = createMatch(seed, cfg, com, null, { A: mk(wA), B: mk(wB) });
    s.halfSeconds = half;

    const ballXs = [];
    let turnovers = 0, prevPoss = null, diverged = false, ticks = 0;
    const LIM = FIELD.halfLength + 12, LIMZ = FIELD.halfWidth + 12;
    while (s.phase !== 'FULLTIME') {
      tick(s); ticks++;
      if (s.possessionTeamId && s.possessionTeamId !== prevPoss) {
        if (prevPoss !== null) turnovers++;
        prevPoss = s.possessionTeamId;
      }
      if (ticks % 15 === 0) {                         // 1초마다
        const b = s.ball.position;
        ballXs.push(b.x);
        if (!Number.isFinite(b.x) || !Number.isFinite(b.z) || Math.abs(b.x) > LIM || Math.abs(b.z) > LIMZ) diverged = true;
        if (!diverged) for (const p of Object.values(s.players)) {
          const q = p.position;
          if (!Number.isFinite(q.x) || !Number.isFinite(q.z) || Math.abs(q.x) > LIM || Math.abs(q.z) > LIMZ) { diverged = true; break; }
        }
      }
    }

    const xg = s.stats ? s.stats.xg : { A: 0, B: 0 };
    const possA = s.stats ? s.stats.possTicks.A / Math.max(1, s.stats.possTicks.A + s.stats.possTicks.B) : 0.5;
    const mx = ballXs.reduce((a, v) => a + v, 0) / Math.max(1, ballXs.length);
    const ballXStd = Math.sqrt(ballXs.reduce((a, v) => a + (v - mx) ** 2, 0) / Math.max(1, ballXs.length));
    return { gd: s.score.A - s.score.B, xgd: xg.A - xg.B, possA, turnovers, ballXStd, diverged };
  }

  function degenerate(rs) {
    const m = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
    const scale = (2 * half) / 5400;                       // 정규 90분 대비
    if (rs.some((r) => r.diverged)) return '좌표 발산';
    const to = m('turnovers') / scale, std = m('ballXStd'), poss = m('possA');
    if (to < VIABLE.turnoversPer90) return `경합 없음(소유권 전환 ${to.toFixed(0)}회)`;
    if (std < VIABLE.ballXStd) return `공 고착(x 표준편차 ${std.toFixed(1)}m)`;
    if (poss < VIABLE.possMin || poss > VIABLE.possMax) return `소유 고착(점유 ${(poss * 100).toFixed(0)}%)`;
    return null;
  }

  /** 도전자 vs 챔피언. 진영 편향을 없애려 절반은 팀을 바꿔 치른다. */
  return function duel(wCand, wChamp) {
    const rs = [];
    let gd = 0;
    for (let i = 0; i < matches; i++) {
      const seed = 1000 + i;
      if (i % 2 === 0) { const r = play(seed, wCand, wChamp); rs.push(r); gd += r.gd + 0.25 * r.xgd; }
      else { const r = play(seed, wChamp, wCand); rs.push(r); gd -= r.gd + 0.25 * r.xgd; }
    }
    return { gd: gd / matches, bad: degenerate(rs) };
  };
}
