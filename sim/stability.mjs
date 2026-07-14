// Stage 8 안정성 게이트 (마스터 §17): 100경기 풀 스택(카드·상대AI·중계·스크립트 지시)에서
// 예외·NaN·데드락·중복재개 없음 + 재현성. tick()의 assertFinite 가 NaN 시 즉시 throw → 예외로 잡힌다.
//   node sim/stability.mjs   (또는  npm run sim:stability)

import { readFileSync } from 'node:fs';
import { createMatch, tick, HALF_SECONDS } from '../js/game/match.js';
import { playDirective } from '../js/game/directives.js';

const L = (p) => JSON.parse(readFileSync(new URL('../data/' + p, import.meta.url)));
const cfg = L('engine.json'), com = L('commentary.json'), cards = L('cards.json');

let fail = 0;
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

// 결정론 스크립트 지시(틱 기준) — 지시/오디블/교체 경로까지 스트레스
const script = [[200, 'attack_wing'], [430, 'high_press'], [900, 'counter'], [1400, 'sub_fw'], [2500, 'attack_central'], [4000, 'park']];

function runMatch(seed, withDirectives) {
  const s = createMatch(seed, cfg, com, cards);
  let n = 0, si = 0;
  while (s.phase !== 'FULLTIME' && n < 200000) {
    tick(s); n++;                                   // assertFinite 내장(NaN→throw)
    if (withDirectives && si < script.length && n === script[si][0]) { playDirective(s, script[si][1], cards); si++; }
  }
  return s;
}

console.log('100경기 안정성 (풀 스택: 카드·상대AI·중계, 매 10번째 경기는 스크립트 지시)...');
let goals = 0, minG = 99, maxG = 0, done = 0;
for (let seed = 1; seed <= 100; seed++) {
  let s;
  try { s = runMatch(seed, seed % 10 === 0); }
  catch (e) { bad(`시드 ${seed} 예외: ${e.message}`); continue; }
  if (s.phase !== 'FULLTIME') { bad(`시드 ${seed} 풀타임 미도달(데드락?)`); continue; }
  if (Math.abs(s.clockSeconds - 2 * HALF_SECONDS) > 1) { bad(`시드 ${seed} 시계 이상 ${s.clockSeconds}`); continue; }
  const g = s.score.A + s.score.B; goals += g; minG = Math.min(minG, g); maxG = Math.max(maxG, g); done++;
}
console.log(`  완주 ${done}/100경기, 골 평균 ${(goals / 100).toFixed(2)} (최소 ${minG} 최대 ${maxG})`);
if (done !== 100) bad(`완주 실패 ${100 - done}경기`);
if (maxG > 40) bad(`득점 폭주 의심 (최대 ${maxG})`);

// 재현성(스크립트 지시 포함)
const a = runMatch(7, true), b = runMatch(7, true);
if (JSON.stringify(a.eventLog) !== JSON.stringify(b.eventLog)) bad('재현성: 시드7+지시 이벤트 로그 불일치');
if (a.score.A !== b.score.A || a.score.B !== b.score.B) bad('재현성: 스코어 불일치');

console.log(fail === 0 ? '\n✅ 안정성 통과 (예외·NaN·데드락·득점폭주 0, 재현성 OK)' : `\n❌ ${fail}건 실패`);
process.exit(fail === 0 ? 0 : 1);
