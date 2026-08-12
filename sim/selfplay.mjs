// 자기대국 — 오프-볼 정책 계수를 승패로 찾는다 (docs/first_principle.md)
//
//   node sim/selfplay.mjs [--gens 20] [--pop 8] [--matches 6] [--half 300] [--sigma 0.15]
//
// 내가 계수를 고르지 않는다. 현 챔피언을 가우시안으로 흔든 도전자들을 만들고, 같은 엔진 안에서
// 챔피언과 직접 붙여 **골 득실차**로 채택한다. 축구다움 눈금은 목표가 아니라 **제약**이다 —
// 퇴화 전략(양 팀이 똑같이 망가져 승률 신호가 사라지는 것)을 걸러내는 필터로만 쓴다.
// 바둑에는 없는 문제이고, 규칙·제약이 충분히 완전해야 최적화가 축구로 수렴한다.
//
// 결정론: 모든 경기 시드와 섭동 난수가 고정이라 같은 명령이 같은 결과를 낸다.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';
import { FIELD } from '../js/game/field.js';

const ROOT = new URL('..', import.meta.url).pathname;
const L = (p) => JSON.parse(readFileSync(ROOT + 'data/' + p, 'utf8'));
const cfg = L('engine.json'), com = L('commentary.json');
const POLICY_PATH = ROOT + 'data/policy.json';
const LOG_PATH = ROOT + '.claude/loop/selfplay.log.jsonl';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? +argv[i + 1] : d; };
const GENS = arg('--gens', 10), POP = arg('--pop', 8), MATCHES = arg('--matches', 6);
const HALF = arg('--half', 300), SIGMA = arg('--sigma', 0.15);

// 결정론 난수(섭동용) — Math.random 금지
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** 한 경기: teamA 정책 wA, teamB 정책 wB. '경기가 성립했는가'에 필요한 관측도 함께 모은다. */
function play(seed, wA, wB) {
  const mk = (v) => ({ arch: ARCH, weights: v.off, carrier: { arch: CARCH, weights: v.car },
    gk: GARCH ? { arch: GARCH, weights: v.gk } : undefined,
    def: DARCH ? { arch: DARCH, weights: v.def } : undefined });
  const s = createMatch(seed, cfg, com, null, { A: mk(wA), B: mk(wB) });
  s.halfSeconds = HALF;

  // 경기 성립 관측: 소유권이 오가는가 · 공이 피치를 오가는가 · 좌표가 성한가
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

  const ev = {};
  for (const e of s.eventLog) ev[e.type] = (ev[e.type] || 0) + 1;
  const possA = s.stats ? s.stats.possTicks.A / Math.max(1, s.stats.possTicks.A + s.stats.possTicks.B) : 0.5;
  const xg = s.stats ? s.stats.xg : { A: 0, B: 0 };
  const mx = ballXs.reduce((a, v) => a + v, 0) / Math.max(1, ballXs.length);
  const ballXStd = Math.sqrt(ballXs.reduce((a, v) => a + (v - mx) ** 2, 0) / Math.max(1, ballXs.length));
  return { gd: s.score.A - s.score.B, xgd: xg.A - xg.B, goals: s.score.A + s.score.B,
    shots: ev.SHOT || 0, offside: ev.OFFSIDE || 0, passes: ev.PASS || 0, possA,
    turnovers, ballXStd, diverged };
}

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
 * ⚠️ 알고 있는 한계: 슛 남발(경기당 400슛)은 이 필터를 통과한다. 그건 의도한 것이다.
 * 슛 남발이 이득이면 그건 정책의 잘못이 아니라 **슛 결과 모델(규칙)이 무르다**는 뜻이고,
 * 필터에 "슛 상한"을 다시 넣는 것은 규칙의 구멍을 필터로 가리는 짓이다(= descriptive 회귀).
 * 고칠 곳은 여기가 아니라 규칙이다. docs/first_principle.md 참조. */
const VIABLE = {
  turnoversPer90: 10,   // 소유권이 이보다 적게 바뀌면 경합 자체가 없는 것
  ballXStd: 8,          // 공 x 표준편차(m). 이보다 작으면 공이 한 곳에 고여 있다
  possMin: 0.05,        // 한 팀이 공을 사실상 놓지 않음. 극단 점유 축구는 허용하려 넓게 둔다
  possMax: 0.95,
};
function degenerate(rs) {
  const m = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  const scale = (2 * HALF) / 5400;                       // 정규 90분 대비 (실측 검증: 슛 392 ↔ 정규 412)
  if (rs.some((r) => r.diverged)) return '좌표 발산';
  const to = m('turnovers') / scale, std = m('ballXStd'), poss = m('possA');
  if (to < VIABLE.turnoversPer90) return `경합 없음(소유권 전환 ${to.toFixed(0)}회)`;
  if (std < VIABLE.ballXStd) return `공 고착(x 표준편차 ${std.toFixed(1)}m)`;
  if (poss < VIABLE.possMin || poss > VIABLE.possMax) return `소유 고착(점유 ${(poss * 100).toFixed(0)}%)`;
  return null;
}

/** 도전자 vs 챔피언. 진영 편향을 없애려 절반은 팀을 바꿔 치른다. */
function duel(wCand, wChamp) {
  const rs = [];
  let gd = 0;
  for (let i = 0; i < MATCHES; i++) {
    const seed = 1000 + i;
    if (i % 2 === 0) { const r = play(seed, wCand, wChamp); rs.push(r); gd += r.gd + 0.25 * r.xgd; }
    else { const r = play(seed, wChamp, wCand); rs.push(r); gd -= r.gd + 0.25 * r.xgd; }
  }
  return { gd: gd / MATCHES, bad: degenerate(rs) };
}

// ── 실행 ─────────────────────────────────────────────────────
const pol = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
const ARCH = pol.arch || null;
const CARCH = pol.carrier?.arch || null;
const GARCH = pol.gk?.arch || null;                      // GK 전용 정책(§9) — 돌진/자세 유지도 자기대국이 찾는다
const DARCH = pol.def?.arch || null;                     // 수비 오프-볼 정책(defball.js) — 박스를 지킬지도 자기대국이 찾는다
let champ = { off: pol.weights.slice(), car: (pol.carrier?.weights || []).slice(), gk: (pol.gk?.weights || []).slice(), def: (pol.def?.weights || []).slice() };
let gen = pol.generation || 0;
const r = rng(987654321);

console.log(`자기대국 시작 — 세대 ${GENS} · 개체 ${POP} · 경기 ${MATCHES}/개체 · 하프 ${HALF}초 · σ ${SIGMA}`);
console.log(`정책: 오프볼 ${ARCH.join('→')}(${champ.off.length}) + 캐리어 ${CARCH.join('→')}(${champ.car.length})`
  + (GARCH ? ` + GK ${GARCH.join('→')}(${champ.gk.length})` : '')
  + (DARCH ? ` + 수비 ${DARCH.join('→')}(${champ.def.length})` : '') + ' 파라미터');
console.log(`관측: ${pol.features.join(', ')}`);
console.log(`세대 ${gen} 에서 시작\n`);

const base = duel(champ, champ);
console.log(`기준선 자기대국 득실차 ${base.gd.toFixed(2)} (0 근처여야 정상)${base.bad ? ` · 제약 위반: ${base.bad}` : ''}\n`);

for (let g = 1; g <= GENS; g++) {
  let bestW = null, bestGd = 0, tried = 0, rejected = 0;
  for (let k = 0; k < POP; k++) {
    const cand = { off: champ.off.map((x) => x + gauss(r) * SIGMA), car: champ.car.map((x) => x + gauss(r) * SIGMA),
      gk: champ.gk.map((x) => x + gauss(r) * SIGMA), def: champ.def.map((x) => x + gauss(r) * SIGMA) };
    const res = duel(cand, champ);
    tried++;
    if (res.bad) { rejected++; continue; }              // 축구가 아니면 이겨도 탈락
    if (res.gd > bestGd) { bestGd = res.gd; bestW = cand; }
  }
  gen++;
  if (bestW) {
    champ = bestW;
    writeFileSync(POLICY_PATH, JSON.stringify({ ...pol, generation: gen,
      weights: champ.off.map((x) => +x.toFixed(4)),
      carrier: { arch: CARCH, weights: champ.car.map((x) => +x.toFixed(4)) },
      ...(GARCH ? { gk: { arch: GARCH, weights: champ.gk.map((x) => +x.toFixed(4)) } } : {}),
      ...(DARCH ? { def: { arch: DARCH, weights: champ.def.map((x) => +x.toFixed(4)) } } : {}) }, null, 2) + '\n');
    console.log(`세대 ${gen}: 채택 (득실차 +${bestGd.toFixed(2)}, 시도 ${tried}, 제약탈락 ${rejected})`);
  } else {
    console.log(`세대 ${gen}: 유지 (개선 없음, 시도 ${tried}, 제약탈락 ${rejected})`);
  }
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ gen, adopted: !!bestW, gd: +bestGd.toFixed(3), rejected, weights: champ.off.length + champ.car.length }) + '\n');
  } catch { /* 로그 실패는 주행을 막지 않는다 */ }
}

console.log(`\n최종 세대 ${gen}`);
console.log(`→ data/policy.json 갱신됨. 검증: node sim/realism-lint.mjs`);
