// 헤드리스 시뮬 (계획서 §4, M5): node sim/headless.mjs [경기수]
// 게이트: 평균 총득점 2.5–3.5 / 장면 분포 득점 20–25%, 슈팅·선방 ~40%, 흐름 ~35% / PRD 수렴
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Match } from "../js/engine/match.js";
import { prdCheck } from "../js/engine/prd.js";
import { mulberry32 } from "../js/engine/rng.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => JSON.parse(readFileSync(join(root, "data", f), "utf8"));
const data = {
  config: load("config.json"),
  formations: load("formations.json"),
  scenes: load("scenes.json"),
  cards: load("cards.json"),
  caster: load("caster.json"),
  advisors: load("advisors.json"),
};

const N = parseInt(process.argv[2] ?? "1000", 10);
const usePolicy = process.argv.includes("--with-cards"); // 신호에 반응하는 단순 정책

function runMatch(seed, policy) {
  const m = new Match(data, seed);
  const stats = { class: { goal: 0, chance: 0, flow: 0 }, scenes: 0 };
  while (!m.state.finished) {
    const ctx = m.beginScene();
    if (policy && ctx.signal && ctx.signal.level >= 2 && ctx.scene.counter) {
      const c = ctx.scene.counter;
      m.playCard(c.card, c.choice ? c.choice[0] : null);
    }
    const r = m.resolveScene();
    stats.class[r.classification] += 1;
    stats.scenes += 1;
    m.finishScene();
  }
  return { score: m.state.score, stats, briefing: m.briefing() };
}

const agg = { goals: [], class: { goal: 0, chance: 0, flow: 0 }, scenes: 0, scorelines: new Map() };
for (let i = 0; i < N; i++) {
  const { score, stats } = runMatch(1000 + i, usePolicy);
  agg.goals.push(score[0] + score[1]);
  for (const k of Object.keys(stats.class)) agg.class[k] += stats.class[k];
  agg.scenes += stats.scenes;
  const key = `${score[0]}:${score[1]}`;
  agg.scorelines.set(key, (agg.scorelines.get(key) ?? 0) + 1);
}

const avgGoals = agg.goals.reduce((a, b) => a + b, 0) / N;
const zeroZero = (agg.scorelines.get("0:0") ?? 0) / N;
const blowout = agg.goals.filter((g) => g >= 5).length / N;
const pctOf = (k) => (100 * agg.class[k] / agg.scenes).toFixed(1);

console.log(`=== ${N}경기 (${usePolicy ? "신호 반응 정책" : "무개입"}) ===`);
console.log(`평균 총득점: ${avgGoals.toFixed(2)}  (게이트 2.5–3.5)`);
console.log(`장면 분포: 득점 ${pctOf("goal")}% (20–25) / 슈팅·선방 ${pctOf("chance")}% (~40) / 흐름 ${pctOf("flow")}% (~35)`);
console.log(`경기당 장면 수: ${(agg.scenes / N).toFixed(1)}`);
console.log(`0:0 비율: ${(zeroZero * 100).toFixed(1)}%  |  총 5골 이상: ${(blowout * 100).toFixed(1)}%`);
const top = [...agg.scorelines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`스코어 상위: ${top.map(([k, v]) => `${k}(${(100 * v / N).toFixed(1)}%)`).join(" ")}`);

// PRD 수렴 검증 (§9): 장기 빈도 = 표기 확률 ±2%p
console.log("\n=== PRD 수렴 (20000회) ===");
for (const p of [0.18, 0.3, 0.42, 0.6]) {
  const rng = mulberry32(7);
  const tracker = { fails: 0 };
  let hit = 0;
  for (let i = 0; i < 20000; i++) if (prdCheck(tracker, p, data.config.prd, rng).success) hit++;
  const freq = hit / 20000;
  const ok = Math.abs(freq - p) <= 0.02 ? "OK" : "FAIL";
  console.log(`표기 ${(p * 100).toFixed(0)}% → 실측 ${(freq * 100).toFixed(1)}%  ${ok}`);
}

// 브리핑 스모크: 1경기 로그로 브리핑 생성이 터지지 않는지
const one = runMatch(42, true);
console.log("\n=== 브리핑 스모크 (seed 42) ===");
console.log(`스코어 ${one.score.join(":")} — ${one.briefing.summary}`);
one.briefing.items.forEach((it) => console.log(`- [${it.kind}] ${it.text}`));
