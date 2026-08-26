// 자기대국 — 정책 계수를 승패로 찾는다 (docs/first_principle.md)
//
//   node sim/selfplay.mjs [--gens 20] [--pop 8] [--matches 6] [--half 300] [--sigma 0.15]
//                         [--lr 0.6] [--workers 8]
//
// 내가 계수를 고르지 않는다. 현 챔피언을 가우시안으로 흔들어 같은 엔진 안에서 챔피언과 직접 붙이고,
// **골 득실차**로 방향을 잡는다. 축구다움 눈금은 목표가 아니라 **제약**이다 — 퇴화 전략(양 팀이
// 똑같이 망가져 승률 신호가 사라지는 것)을 걸러내는 필터로만 쓴다. 바둑에는 없는 문제이고,
// 규칙·제약이 충분히 완전해야 최적화가 축구로 수렴한다.
//
// ── 탐색 방식(2026-08-26 개편) ─────────────────────────────────
// 예전에는 (1,λ) — 도전자 8명 중 이긴 한 명을 통째로 채택했다. 정책이 5종 745 파라미터로 늘면서
// 이 방식은 한계가 뚜렷해졌다: 한 세대가 쓰는 48경기가 **한 표본**으로 축약되고(나머지 7명의
// 정보는 버려진다), 득실차 잡음이 커서 진짜 개선과 운을 못 가른다. 실제로 지난 세션 12세대에
// 수비망 121계수가 거의 안 움직였다.
//
// 지금은 **대칭 표본 + 순위 가중 갱신**(OpenAI-ES 계열)이다:
//   ① 방향 ε 를 λ/2 개 뽑아 +ε 와 −ε 를 **둘 다** 치른다(대칭쌍 = 잡음 절반, 같은 시드라 짝비교).
//   ② 득실차를 순위로 바꿔 중앙을 0 으로 맞춘다(이상치 한 경기가 방향을 못 흔든다).
//   ③ θ ← θ + lr·(1/λ)·Σ uᵢεᵢ — **모든 표본이 방향에 기여한다.**
// 경기 수는 그대로인데 한 세대가 쓰는 정보량이 λ배가 된다.
// 경기가 성립하지 않은 표본(degenerate)은 버리지 않고 **최하위 순위**를 준다 — 그래야
// '퇴화 쪽으로 가지 마라'가 방향에 실린다(예전엔 그냥 버려서 아무 신호도 안 됐다).
//
// 한 세대의 도전자 평가는 서로 완전히 독립이라 **워커 스레드로 병렬**로 돈다. 시드가 전부
// 고정이라 순차와 결과가 한 톨도 다르지 않다(`--workers 1` 로 대조 가능). 1코어 4.7분/세대가
// 8워커에서 1분 아래로 떨어진다.
//
// 결정론: 경기 시드도 섭동 난수도 **세대 번호**에서 유도한다 — 중단 후 재개해도 이어진다.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { makeEvaluator, MODULES } from './selfplay-eval.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const L = (p) => JSON.parse(readFileSync(ROOT + 'data/' + p, 'utf8'));
const cfg = L('engine.json'), com = L('commentary.json');
const POLICY_PATH = ROOT + 'data/policy.json';
const LOG_PATH = ROOT + '.claude/loop/selfplay.log.jsonl';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? +argv[i + 1] : d; };
const GENS = arg('--gens', 10), POP = arg('--pop', 8), MATCHES = arg('--matches', 6);
const HALF = arg('--half', 300), SIGMA = arg('--sigma', 0.15), LR = arg('--lr', 0.6);
const WORKERS = Math.max(1, arg('--workers', Math.max(1, Math.min(POP, availableParallelism() - 2))));

// 결정론 난수(섭동용) — Math.random 금지
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const pol = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
const ARCHES = {
  off: pol.arch || null,
  car: pol.carrier?.arch || null,
  gk: pol.gk?.arch || null,        // GK 전용 정책(§9) — 돌진/자세 유지도 자기대국이 찾는다
  def: pol.def?.arch || null,      // 수비 오프-볼(defball.js) — 박스를 지킬지도 자기대국이 찾는다
  duel: pol.duel?.arch || null,    // 1대1 경합(duel.js) — 언제 달려들지도 자기대국이 찾는다
};
let champ = {
  off: pol.weights.slice(),
  car: (pol.carrier?.weights || []).slice(),
  gk: (pol.gk?.weights || []).slice(),
  def: (pol.def?.weights || []).slice(),
  duel: (pol.duel?.weights || []).slice(),
};
let gen = pol.generation || 0;

// ── 워커 풀 ─────────────────────────────────────────────────
const workerData = { cfg, com, arch: ARCHES, matches: MATCHES, half: HALF };
const pool = Array.from({ length: WORKERS }, () =>
  new Worker(new URL('./selfplay-worker.mjs', import.meta.url), { workerData }));
const localDuel = WORKERS === 1 ? makeEvaluator(workerData) : null;

// 리스너는 풀을 만들 때 **한 번만** 건다. 세대마다 걸면 400세대에 리스너가 400개씩 쌓인다
// (MaxListenersExceededWarning 로 드러났다). 현재 세대의 상태는 batch 하나가 들고 있다.
let batch = null;
for (const w of pool) {
  w.on('message', (m) => {
    if (!batch) return;
    batch.out[m.id] = { gd: m.gd, bad: m.bad };
    if (++batch.done === batch.out.length) { const b = batch; batch = null; b.resolve(b.out); }
    else feed(w);
  });
  w.on('error', (e) => { if (batch) batch.reject(e); else throw e; });
}
function feed(w) {
  if (!batch || batch.next >= batch.cands.length) return;
  const id = batch.next++;
  w.postMessage({ id, cand: batch.cands[id], champ: batch.champ });
}

/** 도전자 여럿을 한꺼번에 평가한다. 순서 보존. */
function evaluate(cands) {
  if (localDuel) return Promise.resolve(cands.map((c) => localDuel(c, champ)));
  return new Promise((resolve, reject) => {
    batch = { cands, champ, out: new Array(cands.length), next: 0, done: 0, resolve, reject };
    for (const w of pool) feed(w);
  });
}

// ── 정책 5종을 한 벡터로 펴고 되돌리는 어댑터 ────────────────
const flatten = (w) => MODULES.flatMap((k) => w[k]);
function unflatten(v) {
  const out = {}; let i = 0;
  for (const k of MODULES) { const n = champ[k].length; out[k] = v.slice(i, i + n); i += n; }
  return out;
}
/** 중앙 0 · 합 0 인 순위 가중치. 잘한 표본은 +, 못한 표본은 −. */
function centeredRanks(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const u = new Array(vals.length);
  for (let r = 0; r < idx.length; r++) u[idx[r][1]] = r / Math.max(1, idx.length - 1) - 0.5;
  return u;
}

function save() {
  writeFileSync(POLICY_PATH, JSON.stringify({ ...pol, generation: gen,
    weights: champ.off.map((x) => +x.toFixed(4)),
    carrier: { arch: ARCHES.car, weights: champ.car.map((x) => +x.toFixed(4)) },
    ...(ARCHES.gk ? { gk: { arch: ARCHES.gk, weights: champ.gk.map((x) => +x.toFixed(4)) } } : {}),
    ...(ARCHES.def ? { def: { arch: ARCHES.def, weights: champ.def.map((x) => +x.toFixed(4)) } } : {}),
    ...(ARCHES.duel ? { duel: { arch: ARCHES.duel, features: pol.duel.features, weights: champ.duel.map((x) => +x.toFixed(4)) } } : {}) }, null, 2) + '\n');
}

// ── 실행 ─────────────────────────────────────────────────────
console.log(`자기대국 시작 — 세대 ${GENS} · 개체 ${POP} · 경기 ${MATCHES}/개체 · 하프 ${HALF}초 · σ ${SIGMA} · lr ${LR} · 워커 ${WORKERS}`);
console.log(`정책: 오프볼 ${ARCHES.off.join('→')}(${champ.off.length}) + 캐리어 ${ARCHES.car.join('→')}(${champ.car.length})`
  + (ARCHES.gk ? ` + GK ${ARCHES.gk.join('→')}(${champ.gk.length})` : '')
  + (ARCHES.def ? ` + 수비 ${ARCHES.def.join('→')}(${champ.def.length})` : '')
  + (ARCHES.duel ? ` + 경합 ${ARCHES.duel.join('→')}(${champ.duel.length})` : '')
  + ` = ${flatten(champ).length} 파라미터`);
console.log(`세대 ${gen} 에서 시작\n`);

const DIRS = Math.max(1, Math.floor(POP / 2));
const t0 = Date.now();
for (let g = 1; g <= GENS; g++) {
  // 섭동 난수를 **세대 번호**에서 유도한다 — 중단 후 재개해도 같은 자리를 다시 밟지 않는다.
  const r = rng((987654321 ^ ((gen + 1) * 2654435761)) >>> 0);
  const theta = flatten(champ);
  const eps = [], cands = [];
  for (let k = 0; k < DIRS; k++) {
    const e = theta.map(() => gauss(r));
    eps.push(e);
    cands.push(unflatten(theta.map((x, i) => x + e[i] * SIGMA)));
    cands.push(unflatten(theta.map((x, i) => x - e[i] * SIGMA)));
  }

  const res = await evaluate(cands);
  const fits = res.map((x) => (x.bad ? -Infinity : x.gd));
  const rejected = res.filter((x) => x.bad).length;

  const u = centeredRanks(fits);                       // -Infinity 는 정렬에서 자동으로 최하위
  const step = new Array(theta.length).fill(0);
  for (let k = 0; k < DIRS; k++) {
    const w = u[2 * k] - u[2 * k + 1], e = eps[k];
    for (let i = 0; i < theta.length; i++) step[i] += w * e[i];
  }
  const scale = (LR * SIGMA) / (2 * DIRS);
  champ = unflatten(theta.map((x, i) => x + scale * step[i]));
  gen++;
  save();

  const finite = fits.filter(Number.isFinite);
  const bestGd = finite.length ? Math.max(...finite) : 0;
  const stepNorm = Math.hypot(...step.map((x) => x * scale));
  const mins = (Date.now() - t0) / 60000;
  console.log(`세대 ${gen}: 갱신 (최고 득실차 +${bestGd.toFixed(2)}, 표본 ${fits.length}, 퇴화 ${rejected}, 걸음 ${stepNorm.toFixed(3)}) · ${(mins / g).toFixed(2)}분/세대`);
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ gen, adopted: true, gd: +bestGd.toFixed(3), rejected,
      step: +stepNorm.toFixed(4), weights: theta.length }) + '\n');
  } catch { /* 로그 실패는 주행을 막지 않는다 */ }
}

for (const w of pool) await w.terminate();
console.log(`\n최종 세대 ${gen}`);
console.log(`→ data/policy.json 갱신됨. 검증: npm run sim:realism`);
