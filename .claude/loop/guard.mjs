// 봉쇄 가드 (goal-harness). 루프가 정직하게 개선하는 대신 할 수 있는 값싼 짓을 기계적으로 막는다.
//   node .claude/loop/guard.mjs          # 해시 대조만 (회차 시작·종료마다 — 몇 ms)
//   node .claude/loop/guard.mjs --full   # 해시 + 기존 게이트 8종 회귀 확인 (~3분, 회차 끝에)
//   node .claude/loop/guard.mjs --seal   # guard.lock 재생성. 사람이 표적/눈금을 의도적으로 바꿀 때만.
//
// 문장으로 쓴 금지는 밤새 지켜지지 않는다. 눈금·심판 프롬프트·표적을 해시로 못박고 회차마다 대조한다.
// --seal 은 루프가 절대 실행하면 안 된다(그 자체가 봉쇄 위반). 사람 전용.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const LOCK = join(ROOT, '.claude/loop/guard.lock');

// 루프가 수정하면 안 되는 것 — 눈금·연출대·표적·심판 프롬프트·이 가드 자신
const PROTECTED = [
  'sim/realism-lint.mjs',
  'sim/report.mjs',
  'sim/pitchshot.mjs',
  'docs/reference/match_stats.json',
  'docs/reference/README.md',
  'docs/reference/target-pitch.png',
  '.claude/loop/judge.md',
  '.claude/loop/match-realism.md',
  '.claude/loop/guard.mjs',
];

// 회귀 금지 — 기존 게이트는 약화·삭제할 수 없고 계속 초록이어야 한다
const GATES = ['sim:match', 'sim:pos', 'sim:play', 'sim:rules', 'sim:stance', 'sim:seq', 'sim:stability'];

const sha = (p) => {
  const f = join(ROOT, p);
  if (!existsSync(f)) return null;
  return createHash('sha256').update(readFileSync(f)).digest('hex');
};

if (process.argv.includes('--seal')) {
  const lock = Object.fromEntries(PROTECTED.map((p) => [p, sha(p)]));
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  const missing = PROTECTED.filter((p) => !lock[p]);
  console.log(`guard.lock 재생성 — ${PROTECTED.length - missing.length}/${PROTECTED.length} 파일 고정`);
  if (missing.length) console.log(`  아직 없는 파일: ${missing.join(', ')}`);
  process.exit(0);
}

if (!existsSync(LOCK)) { console.error('✗ guard.lock 이 없다. 사람이 `--seal` 로 봉인한 뒤 주행하라.'); process.exit(1); }
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

let bad = 0;
for (const p of PROTECTED) {
  const want = lock[p], got = sha(p);
  if (want === null && got === null) { console.error(`✗ ${p} — 봉인 시점에도 없었고 지금도 없다. 표적/눈금이 비어 있다.`); bad++; continue; }
  if (got === null) { console.error(`✗ ${p} — 삭제됨 (봉쇄 위반)`); bad++; continue; }
  if (want === null) { console.error(`✗ ${p} — 봉인되지 않은 파일. 사람이 --seal 해야 한다.`); bad++; continue; }
  if (want !== got) { console.error(`✗ ${p} — 내용이 바뀜 (봉쇄 위반: 눈금·표적·심판 프롬프트는 루프가 못 고친다)`); bad++; continue; }
  console.log(`  ✓ ${p}`);
}

if (process.argv.includes('--full')) {
  console.log('\n기존 게이트 회귀 확인:');
  for (const g of GATES) {
    try {
      execSync(`npm run --silent ${g}`, { cwd: ROOT, stdio: 'pipe' });
      console.log(`  ✓ ${g}`);
    } catch (e) {
      console.error(`  ✗ ${g} — 실패. 축구다움을 올리려고 기존 보장을 깼다(회귀 금지 위반).`);
      bad++;
    }
  }
}

if (bad) { console.error(`\n❌ 봉쇄 위반 ${bad}건 — 이 회차는 무효다. 되돌리고 다시 하라.`); process.exit(1); }
console.log('\n✅ 봉쇄 정상');
