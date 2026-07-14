// Stage 8 안정성 게이트 (마스터 §17): 100경기 풀 스택(카드·상대AI·중계·스크립트 지시)에서
// 예외·NaN·데드락·중복재개 없음 + 재현성. tick()의 assertFinite 가 NaN 시 즉시 throw → 예외로 잡힌다.
//   node sim/stability.mjs   (또는  npm run sim:stability)

import { readFileSync } from 'node:fs';
import { createMatch, tick, HALF_SECONDS } from '../js/game/match.js';
import { playFromHand, playSub } from '../js/game/hand.js';

const L = (p) => JSON.parse(readFileSync(new URL('../data/' + p, import.meta.url)));
const cfg = L('engine.json'), com = L('commentary.json'), cards = L('cards.json');

let fail = 0;
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

// 결정론 스크립트 지시(틱 기준) — 손패 플레이/오디블/교체 경로까지 스트레스.
// 200·215 는 전달(2s=30틱) 안쪽 → 두 번째가 오디블. 1400·4300 은 교체.
const actTicks = new Set([200, 215, 430, 900, 1400, 2500, 4000, 4300]);
const subTicks = new Set([1400, 4300]);

function act(s) {
  const cc = s.cards && s.cards.A; if (!cc) return;
  for (let i = 0; i < cc.hand.length; i++) {                 // 유효한 첫 손패 카드를 낸다(전달중이면 오디블)
    const c = cc.hand[i].card;
    const tgt = c.targetType === 'OPPONENT_PLAYER' ? 'B9' : null;
    if (playFromHand(s, 'A', i, tgt, cards).ok) break;
  }
}

function runMatch(seed, withDirectives) {
  const s = createMatch(seed, cfg, com, cards);
  let n = 0;
  while (s.phase !== 'FULLTIME' && n < 200000) {
    tick(s); n++;                                   // assertFinite 내장(NaN→throw)
    if (withDirectives) {
      if (actTicks.has(n)) act(s);
      if (subTicks.has(n)) playSub(s, 'A', 'fw', 2, cards);
    }
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
