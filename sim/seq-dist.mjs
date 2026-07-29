// 공격 시퀀스 패스 수 분포 측정 (디자이너 목표: 1패스 10% · 3-5 40% · 6-8 30% · 나머지 20%).
// 슛으로 귀결된 시퀀스의 '슛 전 패스 수'(SHOT.seq)를 모아 버킷 분포를 낸다. 이 수치에 다다를 때까지 엔진 튜닝.
//   node sim/seq-dist.mjs [matches]

import { readFileSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';

const cfg = JSON.parse(readFileSync(new URL('../data/engine.json', import.meta.url)));
const N = parseInt(process.argv[2] || '40', 10);

const seqs = [];
for (let seed = 1; seed <= N; seed++) {
  const s = createMatch(seed, cfg);
  while (s.phase !== 'FULLTIME') tick(s);
  for (const e of s.eventLog) if (e.type === 'SHOT') seqs.push(e.seq | 0);
}

const total = seqs.length || 1;
const pct = (f) => (100 * f / total);
const b = { 0: 0, 1: 0, 2: 0, '3-5': 0, '6-8': 0, '9+': 0 };
for (const q of seqs) {
  if (q <= 0) b[0]++; else if (q === 1) b[1]++; else if (q === 2) b[2]++;
  else if (q <= 5) b['3-5']++; else if (q <= 8) b['6-8']++; else b['9+']++;
}
const target = { 1: 10, '3-5': 40, '6-8': 30 };
console.log(`${N}경기, 슛 ${total}개. 슛 전 패스 수 분포:`);
for (const k of ['0', '1', '2', '3-5', '6-8', '9+']) {
  const t = target[k] !== undefined ? `  (목표 ${target[k]}%)` : '';
  console.log(`  ${k.padEnd(4)} : ${pct(b[k]).toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(pct(b[k]) / 2))}${t}`);
}
// 목표와의 편차(핵심 3버킷) — 게이트: ≤8%p(런간 편차 여유)
const err = Math.abs(pct(b[1]) - 10) + Math.abs(pct(b['3-5']) - 40) + Math.abs(pct(b['6-8']) - 30);
console.log(`  핵심 3버킷 목표편차 합: ${err.toFixed(1)}%p  (목표 ≤8%p)`);
const ok = err <= 8;
console.log(ok ? '✅ 목표 분포 근접' : `❌ 목표 이탈 (${err.toFixed(1)}%p)`);
process.exit(ok ? 0 : 1);
