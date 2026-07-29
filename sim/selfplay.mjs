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

/** 한 경기: teamA 정책 wA, teamB 정책 wB. 축구가 아니게 무너졌는지도 함께 본다. */
function play(seed, wA, wB) {
  const mk = (v) => ({ arch: ARCH, weights: v.off, carrier: { arch: CARCH, weights: v.car } });
  const s = createMatch(seed, cfg, com, null, { A: mk(wA), B: mk(wB) });
  s.halfSeconds = HALF;
  while (s.phase !== 'FULLTIME') tick(s);
  const ev = {};
  for (const e of s.eventLog) ev[e.type] = (ev[e.type] || 0) + 1;
  const possA = s.stats ? s.stats.possTicks.A / Math.max(1, s.stats.possTicks.A + s.stats.possTicks.B) : 0.5;
  const xg = s.stats ? s.stats.xg : { A: 0, B: 0 };
  return { gd: s.score.A - s.score.B, xgd: xg.A - xg.B, goals: s.score.A + s.score.B,
    shots: ev.SHOT || 0, offside: ev.OFFSIDE || 0, passes: ev.PASS || 0, possA };
}

/** 제약: 축구가 아니게 무너진 정책은 승패와 무관하게 탈락시킨다. */
function degenerate(rs) {
  const m = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  const scale = (2 * HALF) / 5400;                       // 정규 90분 대비
  const shots = m('shots') / scale, goals = m('goals') / scale;
  const passes = m('passes') / scale, off = m('offside') / scale;
  const poss = m('possA');
  if (shots > 70) return `슛 ${shots.toFixed(0)}`;
  if (goals > 25) return `골 ${goals.toFixed(0)}`;
  if (passes < 120) return `패스 ${passes.toFixed(0)}`;
  if (off > 30) return `오프사이드 ${off.toFixed(0)}`;
  if (poss < 0.2 || poss > 0.8) return `점유 ${(poss * 100).toFixed(0)}%`;
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
let champ = { off: pol.weights.slice(), car: (pol.carrier?.weights || []).slice() };
let gen = pol.generation || 0;
const r = rng(987654321);

console.log(`자기대국 시작 — 세대 ${GENS} · 개체 ${POP} · 경기 ${MATCHES}/개체 · 하프 ${HALF}초 · σ ${SIGMA}`);
console.log(`정책: 오프볼 ${ARCH.join('→')}(${champ.off.length}) + 캐리어 ${CARCH.join('→')}(${champ.car.length}) 파라미터`);
console.log(`관측: ${pol.features.join(', ')}`);
console.log(`세대 ${gen} 에서 시작\n`);

const base = duel(champ, champ);
console.log(`기준선 자기대국 득실차 ${base.gd.toFixed(2)} (0 근처여야 정상)${base.bad ? ` · 제약 위반: ${base.bad}` : ''}\n`);

for (let g = 1; g <= GENS; g++) {
  let bestW = null, bestGd = 0, tried = 0, rejected = 0;
  for (let k = 0; k < POP; k++) {
    const cand = { off: champ.off.map((x) => x + gauss(r) * SIGMA), car: champ.car.map((x) => x + gauss(r) * SIGMA) };
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
      carrier: { arch: CARCH, weights: champ.car.map((x) => +x.toFixed(4)) } }, null, 2) + '\n');
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
