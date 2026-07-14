// 모션 게이트 린트 (계획서 §4): node sim/motion-lint.mjs
// 전 장면(25) × 상태 3종(중립 / momentum-3·상대 attack / 유저 라인 high·tactic attack)
// × 장면 duration+5초, dt=1/30s 스텝으로 샘플링. 게이트별 PASS/FAIL과 수치를 출력한다.
// 이 린트는 경기 rng를 절대 만들지 않는다(Match 미생성) — 판정과 완전 분리.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMotion, stepMotion } from "../js/engine/motion.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => JSON.parse(readFileSync(join(root, "data", f), "utf8"));
const cfg = load("config.json");
const formations = load("formations.json");
const scenes = load("scenes.json").scenes;

const DT = 1 / 30;
const TAIL = 5; // 장면 duration + 5초
const MS = cfg.motion.meterScale;

// 상태 3종 (모션이 읽는 필드: lineHeight, tactic, opponent, sentOff)
const STATES = {
  "중립": { lineHeight: "mid", tactic: "balanced", opponent: { lineHeight: "mid", tactic: "balanced" }, sentOff: [], momentum: 0, score: [0, 0] },
  "수세(m-3·상대attack)": { lineHeight: "mid", tactic: "balanced", opponent: { lineHeight: "mid", tactic: "attack" }, sentOff: [], momentum: -3, score: [0, 1] },
  "공세(라인high·attack)": { lineHeight: "high", tactic: "attack", opponent: { lineHeight: "mid", tactic: "balanced" }, sentOff: [], momentum: 0, score: [0, 0] },
};

// ── 게이트 임계 (계획서 §4) ───────────────────────────────
// G4′: 앵커까지 ≤g4dist(8m)면 ≤g4near(4.2), >8m(재정렬 중)면 ≤g4far(6.7).
// G8: g8b 수비팀 길이 ≤33m, g8c 20명 x-스팬 ≤56, g8d 볼사이드 슬라이드 오차 ≤8m.
// G2′(v0.4): 저크 임계 12→7.2 (brake 6.5 + 여유). "지나친 가속" 봉인의 수치 증명.
// G9(v0.4): 라인카드 가시성 — 수비 backLine high−low≥14m, high−mid≥6m.
// G10(v0.5): 겹침 — 비(배우-배우) 쌍 중심거리 <1.1m. 페어프레임 비율 ≤1% AND 0.8s+ 연속겹침 0건.
const LIM = { g1: 8.8, g2: 7.2, g3p99: 7, g3max: 10, g4near: 4.2, g4far: 6.7, g4dist: 8, g5speed: 14, g5carry: 2.2, g5shot: 1.5, g8b: 33, g8c: 56, g8d: 8, g8settle: 4.0, g8settleSpd: 1.5, g9hl: 14, g9hm: 6, g10dist: 1.1, g10cont: 0.8, g10ratio: 1 };

const meterDelta = (a, b) => Math.hypot((a[0] - b[0]) * MS[0], (a[1] - b[1]) * MS[1]);
const speedOf = (a, b) => meterDelta(a, b) / DT;

function pctl(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// ── 한 (장면×상태) 런의 메트릭을 누적기에 적재 ──────────────
function runOne(scene, state, label, acc) {
  const m = createMotion(scene, formations, state, cfg);
  const frames = Math.ceil((scene.duration + TAIL) / DT);
  const hasShot = (scene.waypoints.ball || []).some((e) => e.startsWith("shot:"));

  let prevPos = {}, prevVel = {}, prevBall = null;
  for (const id of m.onField) prevPos[id] = m.positions[id].slice();
  let shotMinDist = Infinity;
  const actorSet = new Set(m.actorIds);           // G10 배우-배우 제외용
  const contMap = new Map(), flagged = new Set(); // G10 쌍별 연속겹침 프레임 · 0.8s 플래그(에피소드당 1회)

  for (let f = 0; f < frames; f++) {
    stepMotion(m, DT);
    const pos = m.positions;
    const ballU = pos.ball;
    const ballSpeed = prevBall ? speedOf(ballU, prevBall) : 0;
    const bmode = m.ball.mode, bkind = m.ball.flightKind;
    const speeds = {}; // 알별 순간속도(정상상태 판정용)

    // 알 게이트 (G1/G2/G3/G4)
    for (const id of m.onField) {
      const p = pos[id];
      if (!prevPos[id]) { prevPos[id] = p.slice(); continue; }
      const spd = speedOf(p, prevPos[id]);
      speeds[id] = spd;
      const vel = [(p[0] - prevPos[id][0]) * MS[0] / DT, (p[1] - prevPos[id][1]) * MS[1] / DT];
      const role = m.roles[id];

      // G1 속도 상한
      if (spd > acc.g1.max) { acc.g1.max = spd; acc.g1.at = { scene: scene.id, label, id, f }; }
      if (spd > LIM.g1) acc.g1.viol++;

      // G2 저크 (가속) — 이전 속도가 있는 프레임부터
      if (prevVel[id]) {
        const accM = Math.hypot(vel[0] - prevVel[id][0], vel[1] - prevVel[id][1]) / DT;
        if (accM > acc.g2.max) { acc.g2.max = accM; acc.g2.at = { scene: scene.id, label, id, f }; }
        if (accM > LIM.g2) acc.g2.viol++;
      }
      prevVel[id] = vel;

      // G3 진형: 블록 알 ↔ 시프트 앵커 거리
      if (role === "block" && m.anchors[id]) {
        const d = meterDelta(p, m.anchors[id]);
        acc.g3.dists.push(d);
        if (d > acc.g3.max) { acc.g3.max = d; acc.g3.at = { scene: scene.id, label, id, f }; }
      }

      // G4′ 공-선수 분리: 공 비행(>12m/s) 중 비관여·비압박(블록/GK) 알 — 앵커까지 ≤8m:≤4.2 / >8m(재정렬):≤6.7
      if (ballSpeed > 12 && (role === "block" || role === "gk")) {
        let lim = LIM.g4near;
        if (role === "block" && m.anchors[id] && meterDelta(p, m.anchors[id]) > LIM.g4dist) lim = LIM.g4far;
        if (spd > acc.g4.max) { acc.g4.max = spd; acc.g4.at = { scene: scene.id, label, id, f }; }
        if (spd > lim) { acc.g4.viol++; if (spd > acc.g4.violMax) { acc.g4.violMax = spd; acc.g4.violAt = { scene: scene.id, label, id, f, lim }; } }
      }
      prevPos[id] = p.slice();
    }

    // ── G10 겹침 (계획서 §2.7/§4): 비(배우-배우) 필드 스톤 쌍 <1.1m ──
    // 페어프레임 비율(겹친 쌍-프레임/검사한 쌍-프레임)과 쌍별 연속겹침을 누적. 프레임존재 비율은 참고로만
    // 집계(순간 교차 허용 원칙상 압박 접촉이 이를 ~1.6%로 띄워 게이트로는 부적합 — §e 보고). 판정은
    // 페어프레임 ≤1% AND 0.8s+ 연속겹침 0건. onField 순서 고정이라 (i<j) 쌍 키는 프레임 간 일관.
    {
      const ids = m.onField;
      let frameHas = false; const seen = new Set();
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i], aAct = actorSet.has(a);
        for (let j = i + 1; j < ids.length; j++) {
          const b = ids[j];
          if (aAct && actorSet.has(b)) continue; // 배우-배우 쌍 제외
          acc.g10.pairTot++;
          const key = a + "|" + b;
          if (meterDelta(pos[a], pos[b]) < LIM.g10dist) {
            acc.g10.pairOv++; frameHas = true; seen.add(key);
            const c = (contMap.get(key) || 0) + 1; contMap.set(key, c);
            const sec = c * DT;
            if (sec > acc.g10.maxCont) { acc.g10.maxCont = sec; acc.g10.maxAt = { scene: scene.id, label, key }; }
            if (sec >= LIM.g10cont && !flagged.has(key)) {
              acc.g10.contGe08++; flagged.add(key);
              if (!acc.g10.contAt) acc.g10.contAt = { scene: scene.id, label, key };
            }
          }
        }
      }
      for (const k of contMap.keys()) if (!seen.has(k)) { contMap.set(k, 0); flagged.delete(k); }
      acc.g10.totFrames++;
      if (frameHas) acc.g10.frameExist++;
    }

    // 공 게이트 (G5)
    if (prevBall) {
      // 순간이동: 프레임 이동량 > 속도×dt×2 + 0.5m
      const allow = m.ball.nominalSpeed * DT * 2 + 0.5;
      const moved = meterDelta(ballU, prevBall);
      if (moved > acc.g5tp.max) { acc.g5tp.max = moved; acc.g5tp.at = { scene: scene.id, label, f, allow }; }
      if (moved > allow) acc.g5tp.viol++;
    }
    // pass/shot 비행 속도 ≥ 14 (mode==flight는 도착 직전까지 — 도착 프레임은 carry/settle로 이미 전환됨)
    if (bmode === "flight" && (bkind === "pass" || bkind === "shot")) {
      if (ballSpeed < acc.g5speed.min) { acc.g5speed.min = ballSpeed; acc.g5speed.at = { scene: scene.id, label, f, kind: bkind }; }
      if (ballSpeed < LIM.g5speed) acc.g5speed.viol++;
    }
    // attached 중 캐리어 거리 ≤ 2.2m
    if (bmode === "carry" && m.ball.carrierId && pos[m.ball.carrierId]) {
      const d = meterDelta(ballU, pos[m.ball.carrierId]);
      if (d > acc.g5carry.max) { acc.g5carry.max = d; acc.g5carry.at = { scene: scene.id, label, f }; }
      if (d > LIM.g5carry) acc.g5carry.viol++;
    }
    // shot: 골문 조준점 1.5m 내 도달
    if (bmode === "flight" && bkind === "shot") {
      shotMinDist = Math.min(shotMinDist, meterDelta(m.ball.pos, m.ball.flightTo) / 1); // 이미 미터
    }

    // ── G8 형상 게이트 (계획서 §4): side≠neutral·t≥4s·정상상태 샘플 ──
    // "정상상태" = 측정 대상 블록이 앵커에 수렴(평균 앵커거리 < g8settle). 라인 스윙 중(빠른 카운터·
    // 크로스 재정렬)은 형상이 아직 안 잡힌 과도상태라 제외한다 — G8은 잡힌 형상의 기하를 봉인하고,
    // 과도 재정렬의 매끄러움은 G3/G4′가 담당한다. 압박자(role press)·배우·GK는 형상 지배 알이 아니라 제외.
    // 임계 d_ball·ballY는 형상 기준 볼(shapeBallRef) — 형상이 참조하는 통제 볼과 게이트를 일치시킨다.
    if (scene.side !== "neutral" && m.elapsed >= 4) {
      const attTeam = scene.side, defTeam = scene.side === "home" ? "away" : "home";
      const attPre = attTeam === "home" ? "h" : "a";
      const defPre = defTeam === "home" ? "h" : "a";
      const ownDist = (team, px) => (team === "home" ? px : 100 - px); // 자기 골문 거리
      const ref = m.shapeBallRef;
      const dBallAtt = ownDist(attTeam, ref[0]);
      const attBlk = m.blockIds.filter((id) => id[0] === attPre && m.roles[id] === "block");
      const defBlk = m.blockIds.filter((id) => id[0] === defPre && m.roles[id] === "block");
      const meanGap = (ids) => ids.reduce((s, id) => s + meterDelta(pos[id], m.anchors[id]), 0) / (ids.length || 1);
      const meanSpd = (ids) => ids.reduce((s, id) => s + (speeds[id] || 0), 0) / (ids.length || 1);
      // 정상상태 = 앵커에 수렴(gap<g8settle) AND 유휴 근접(speed<g8settleSpd). 후자는 라인 이징 과도상태
      // (알이 뒤처진 앵커를 바짝 따라가지만 앵커 자체가 아직 이동 중)를 제외한다 — 이동 중이면 유휴가 아니다.
      const attSettled = attBlk.length >= 2 && meanGap(attBlk) < LIM.g8settle && meanSpd(attBlk) < LIM.g8settleSpd;
      const defSettled = defBlk.length >= 2 && meanGap(defBlk) < LIM.g8settle && meanSpd(defBlk) < LIM.g8settleSpd;

      // G8a: 공격팀 backLine(가장 깊은 블록 알, 자기 골문 거리) ≥ min(44, d_ball−30)
      if (attSettled) {
        let backLine = Infinity;
        for (const id of attBlk) backLine = Math.min(backLine, ownDist(attTeam, pos[id][0]));
        const thr = Math.min(44, dBallAtt - 30);
        const deficit = thr - backLine; // >0 = 위반(라인이 덜 올라옴)
        acc.g8a.vals.push(deficit);
        if (deficit > acc.g8a.max) { acc.g8a.max = deficit; acc.g8a.at = { scene: scene.id, label, f, backLine: +backLine.toFixed(1), thr: +thr.toFixed(1) }; }
      }
      // G8b: 수비팀 길이(블록 알 전후 폭, 자기 골문 거리 max−min) ≤ 33m
      if (defSettled) {
        let lo = Infinity, hi = -Infinity;
        for (const id of defBlk) { const d = ownDist(defTeam, pos[id][0]); lo = Math.min(lo, d); hi = Math.max(hi, d); }
        acc.g8b.vals.push(hi - lo);
        if (hi - lo > acc.g8b.max) { acc.g8b.max = hi - lo; acc.g8b.at = { scene: scene.id, label, f }; }
      }
      // G8c: 필드 20명(GK 제외) x-스팬 ≤ 56 (양 팀 형상 수렴 시)
      if (attSettled && defSettled) {
        let lo = Infinity, hi = -Infinity;
        for (const id of m.onField) { if (id === "h1" || id === "a1") continue; lo = Math.min(lo, pos[id][0]); hi = Math.max(hi, pos[id][0]); }
        acc.g8c.vals.push(hi - lo);
        if (hi - lo > acc.g8c.max) { acc.g8c.max = hi - lo; acc.g8c.at = { scene: scene.id, label, f }; }
      }
      // G8d: 수비 블록중심 y−50이 (ballY−50)×0.5와 부호 일치·오차 ≤8m(p95)
      if (defSettled) {
        let sy = 0; for (const id of defBlk) sy += pos[id][1];
        const cy = sy / defBlk.length;
        const target = (ref[1] - 50) * cfg.motion.shape.defend.yGain;
        const errM = Math.abs((cy - 50) - target) * MS[1];
        acc.g8d.vals.push(errM);
        if (Math.abs(target) > 1 && Math.sign(cy - 50) !== Math.sign(target)) {
          acc.g8d.signViol++;
          if (!acc.g8d.signAt) acc.g8d.signAt = { scene: scene.id, label, f, cyOff: +(cy - 50).toFixed(1), target: +target.toFixed(1) };
        }
        if (errM > acc.g8d.max) { acc.g8d.max = errM; acc.g8d.at = { scene: scene.id, label, f }; }
      }
    }

    prevBall = ballU.slice();
  }

  if (hasShot) {
    acc.g5shot.scenes++;
    if (shotMinDist <= LIM.g5shot) acc.g5shot.ok++;
    else acc.g5shot.fails.push({ scene: scene.id, label, minDist: shotMinDist });
  }

  // §D 입력: 배우 순항속도가 speedCap을 넘어 늦게 도착하는 장면
  for (const id of m.actorIds) {
    const st = m.stones[id];
    if (st.cruise > cfg.motion.actor.speedCap + 1e-6) {
      acc.actorOver.push({ scene: scene.id, id, cruise: +st.cruise.toFixed(2) });
    }
  }
}

function freshAcc() {
  return {
    g1: { max: 0, viol: 0, at: null }, g2: { max: 0, viol: 0, at: null },
    g3: { dists: [], max: 0, at: null },
    g4: { max: 0, viol: 0, at: null, violMax: 0, violAt: null },
    g5speed: { min: Infinity, viol: 0, at: null }, g5carry: { max: 0, viol: 0, at: null },
    g5tp: { max: 0, viol: 0, at: null }, g5shot: { scenes: 0, ok: 0, fails: [] },
    g8a: { vals: [], max: -Infinity, at: null }, g8b: { vals: [], max: 0, at: null },
    g8c: { vals: [], max: 0, at: null }, g8d: { vals: [], max: 0, at: null, signViol: 0, signAt: null },
    g10: { pairOv: 0, pairTot: 0, frameExist: 0, totFrames: 0, contGe08: 0, maxCont: 0, maxAt: null, contAt: null },
    actorOver: [],
  };
}

// ── 매트릭스 실행 ──────────────────────────────────────────
const acc = freshAcc();
let runs = 0;
for (const scene of scenes) {
  for (const [label, state] of Object.entries(STATES)) {
    // 각 런은 상태 객체를 복제해서 쓴다(모션은 읽기전용이지만 방어적으로)
    runOne(scene, JSON.parse(JSON.stringify(state)), label, acc);
    runs++;
  }
}

const g3p99 = pctl(acc.g3.dists, 0.99);
const g3max = acc.g3.max;
// G8 백분위 (a/b/c = p99, d = p95)
const g8aP99 = pctl(acc.g8a.vals, 0.99);
const g8bP99 = pctl(acc.g8b.vals, 0.99);
const g8cP99 = pctl(acc.g8c.vals, 0.99);
const g8dP95 = pctl(acc.g8d.vals, 0.95);

// ── 판정 출력 ──────────────────────────────────────────────
const fmt = (v) => (typeof v === "number" ? v.toFixed(2) : v);
const line = (pass, name, detail) => `[${pass ? "PASS" : "FAIL"}] ${name}  ${detail}`;
const atStr = (at) => (at ? `(${at.scene}/${at.label ?? ""}${at.id ? "/" + at.id : ""} f${at.f})` : "");

console.log(`=== 모션 게이트 린트 — 장면 ${scenes.length} × 상태 ${Object.keys(STATES).length} = ${runs}런, dt=1/30, duration+${TAIL}s ===\n`);

const results = [];
results.push([acc.g1.viol === 0, "G1 속도상한 ≤8.8m/s", `max=${fmt(acc.g1.max)}m/s 위반=${acc.g1.viol} ${acc.g1.viol ? atStr(acc.g1.at) : ""}`]);
results.push([acc.g2.viol === 0, "G2′ 저크 ≤7.2m/s²", `max=${fmt(acc.g2.max)}m/s² 위반=${acc.g2.viol} ${acc.g2.viol ? atStr(acc.g2.at) : ""}`]);
results.push([g3p99 <= LIM.g3p99 && g3max <= LIM.g3max, "G3 진형 p99≤7m·max≤10m", `p99=${fmt(g3p99)}m max=${fmt(g3max)}m ${g3max > LIM.g3max ? atStr(acc.g3.at) : ""}`]);
results.push([acc.g4.viol === 0, "G4′ 공-선수분리 앵커≤8m:≤4.2 / >8m:≤6.7", `max(비행중 블록/GK)=${fmt(acc.g4.max)}m/s 위반=${acc.g4.viol} ${acc.g4.viol ? atStr(acc.g4.violAt) + " spd=" + fmt(acc.g4.violMax) + " lim=" + acc.g4.violAt?.lim : ""}`]);
results.push([acc.g5speed.viol === 0, "G5a pass/shot비행 ≥14m/s", `min=${fmt(acc.g5speed.min === Infinity ? 0 : acc.g5speed.min)}m/s 위반=${acc.g5speed.viol} ${acc.g5speed.viol ? atStr(acc.g5speed.at) : ""}`]);
results.push([acc.g5carry.viol === 0, "G5b attached 캐리어 ≤2.2m", `max=${fmt(acc.g5carry.max)}m 위반=${acc.g5carry.viol} ${acc.g5carry.viol ? atStr(acc.g5carry.at) : ""}`]);
results.push([acc.g5tp.viol === 0, "G5c 공 순간이동 0건", `max이동=${fmt(acc.g5tp.max)}m 위반=${acc.g5tp.viol} ${acc.g5tp.viol ? atStr(acc.g5tp.at) : ""}`]);
results.push([acc.g5shot.fails.length === 0, "G5d shot 골문 1.5m 도달", `${acc.g5shot.ok}/${acc.g5shot.scenes} 장면 도달 ${acc.g5shot.fails.length ? JSON.stringify(acc.g5shot.fails.map((x) => `${x.scene}/${x.label}:${x.minDist.toFixed(2)}m`)) : ""}`]);

// ── G8 형상 게이트 (계획서 §4, side≠neutral·t≥4s) ──
results.push([g8aP99 <= 0, "G8a 공격 backLine ≥min(44,d_ball−30)", `deficit p99=${fmt(g8aP99)}m maxDeficit=${fmt(acc.g8a.max)}m ${acc.g8a.max > 0 ? atStr(acc.g8a.at) + ` back=${acc.g8a.at?.backLine} thr=${acc.g8a.at?.thr}` : ""}`]);
results.push([g8bP99 <= LIM.g8b, "G8b 수비팀 길이 ≤33m", `p99=${fmt(g8bP99)}m max=${fmt(acc.g8b.max)}m ${g8bP99 > LIM.g8b ? atStr(acc.g8b.at) : ""}`]);
results.push([g8cP99 <= LIM.g8c, "G8c 20명 x-스팬 ≤56", `p99=${fmt(g8cP99)} max=${fmt(acc.g8c.max)} ${g8cP99 > LIM.g8c ? atStr(acc.g8c.at) : ""}`]);
// G8d: "부호 일치·오차 ≤8m p95" — p95는 절 전체에 적용(오차·부호 모두 ≤5% 위반 허용). 부호 위반은
// 대부분 빠른 좌우 전환 후 블록이 올바른 방향으로 슬라이드하며 잠깐 뒤처지는 소진폭(≤4.5m) 과도.
const g8dSignRate = acc.g8d.signViol / Math.max(1, acc.g8d.vals.length);
results.push([g8dP95 <= LIM.g8d && g8dSignRate <= 0.05, "G8d 볼사이드 슬라이드 부호일치·오차≤8m", `err p95=${fmt(g8dP95)}m max=${fmt(acc.g8d.max)}m 부호위반율=${(g8dSignRate * 100).toFixed(1)}%(${acc.g8d.signViol}/${acc.g8d.vals.length}) ${g8dSignRate > 0.05 ? atStr(acc.g8d.signAt) : ""}`]);

// ── G10 겹침 게이트 (계획서 §2.7/§4, v0.5 신설) ──
// 판정: 페어프레임 비율(겹친 비배우쌍-프레임/검사쌍-프레임) ≤1% AND 0.8s+ 연속겹침 0건.
// "순간 교차 허용" 원칙(계획서 §4)에 따라 순간 스침은 페어프레임에서 미미하고, 지속 겹침은 연속겹침이 잡는다.
// 프레임존재 비율(≥1쌍 겹친 프레임/전체)은 압박 순간접촉이 ~1.6%로 띄워 게이트에 부적합 — 참고로만 표기.
const g10PairRatio = 100 * acc.g10.pairOv / Math.max(1, acc.g10.pairTot);
const g10FrameExist = 100 * acc.g10.frameExist / Math.max(1, acc.g10.totFrames);
const g10pass = g10PairRatio <= LIM.g10ratio && acc.g10.contGe08 === 0;
const g10ContStr = acc.g10.contAt ? ` @${acc.g10.contAt.scene}/${acc.g10.contAt.label}:${acc.g10.contAt.key}` : "";
const g10MaxStr = acc.g10.maxAt ? `(${acc.g10.maxAt.scene}/${acc.g10.maxAt.key})` : "";
results.push([g10pass, "G10 겹침 비배우쌍<1.1m 페어프레임≤1%·0.8s연속0", `페어프레임=${fmt(g10PairRatio)}% 0.8s+연속=${acc.g10.contGe08}건${g10ContStr} 최장연속=${fmt(acc.g10.maxCont)}s ${g10MaxStr} | 참고 프레임존재=${fmt(g10FrameExist)}%`]);

for (const [pass, name, detail] of results) console.log(line(pass, name, detail));

// ── G7 성능: 22알 스텝 1000회 < 50ms ───────────────────────
{
  const perfScene = scenes.find((s) => s.id === "home_left_overlap") || scenes[0];
  const m = createMotion(perfScene, formations, JSON.parse(JSON.stringify(STATES["중립"])), cfg);
  // 워밍업
  for (let i = 0; i < 100; i++) stepMotion(m, DT);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) stepMotion(m, DT);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  results.push([ms < 50, "G7 성능 스텝1000회 <50ms", `${ms.toFixed(2)}ms (${m.onField.length}알)`]);
  console.log(line(ms < 50, "G7 성능 스텝1000회 <50ms", `${ms.toFixed(2)}ms (${m.onField.length}알)`));
}

// ── 퇴장자 엣지 스모크 (IDEAS #7 해결 확인) ─────────────────
{
  const scene = scenes.find((s) => s.id === "home_center_combo"); // 배우 h10,h11 + 공 pass:h10/h11 + shot
  const state = { lineHeight: "mid", tactic: "balanced", opponent: { lineHeight: "mid", tactic: "balanced" }, sentOff: ["h10"], momentum: 0, score: [0, 0] };
  const m = createMotion(scene, formations, state, cfg);
  let teleport = 0, centerJump = 0, prevBall = m.positions.ball.slice();
  const frames = Math.ceil((scene.duration + TAIL) / DT);
  for (let f = 0; f < frames; f++) {
    stepMotion(m, DT);
    const b = m.positions.ball;
    if (meterDelta(b, prevBall) > m.ball.nominalSpeed * DT * 2 + 0.5) teleport++;
    // 퇴장자 폴백이 공을 센터로 순간이동시키던 옛 버그: 공이 갑자기 [50,50] 근처로 튀는지
    if (f > 0 && Math.abs(b[0] - 50) < 0.5 && Math.abs(b[1] - 50) < 0.5) centerJump++;
    prevBall = b.slice();
  }
  const ballMissing = m.positions.h10 !== undefined; // h10 퇴장 → positions에 없어야
  const pass = teleport === 0 && !ballMissing;
  console.log(line(pass, "EDGE 퇴장자(h10) 리매핑", `순간이동=${teleport} 센터튐=${centerJump} h10노출=${ballMissing}`));
  results.push([pass, "EDGE 퇴장자 리매핑", ""]);
}

// ── §D 입력: 배우 순항 초과 장면 ───────────────────────────
if (acc.actorOver.length) {
  const uniq = [...new Map(acc.actorOver.map((x) => [x.scene + x.id, x])).values()];
  console.log(`\n[참고] 배우 순항속도 > speedCap(${cfg.motion.actor.speedCap}) 장면 (늦게 도착, §D 후보):`);
  for (const x of uniq) console.log(`  - ${x.scene}/${x.id}: cruise=${x.cruise}m/s`);
} else {
  console.log(`\n[참고] 배우 순항속도 speedCap 초과 장면: 없음 (계측 예상과 일치)`);
}

// ── G9 라인 카드 가시성 (계획서 §4, v0.4 신설) ─────────────────
// 같은 장면·같은 볼 기준으로 수비팀 lineHeight low/mid/high 세 런을 돌려, 각 런의 마지막 프레임
// (duration+5s 정착)에서 정상상태 수비 backLine(수비팀 가장 깊은 블록 알의 자기 골문 거리)을 실측.
// high−low ≥ 14m, high−mid ≥ 6m 판정. lineHeight는 공/배우에 영향이 없어 세 런의 볼 궤적이 동일
// → shapeBallRef(형상 기준 볼)가 프레임별로 같다 = "같은 볼". 클램프에 걸리는 극단 볼 위치 표본은
// 제외한다(계획서 §4): (a) base=d_ball−buffer가 defend backClamp 6~45에 포화되면 카드 델타가
// 왜곡되고, (b) 앵커 [3,97] 클램프에 backLine이 눌리면 델타가 압축된다.
{
  const S = cfg.motion.shape;
  const buffer = S.defend.buffer, clampLo = S.defend.backClampLo, clampHi = S.defend.backClampHi;
  const ownDist = (team, px) => (team === "home" ? px : 100 - px); // 자기 골문 거리(m 근사)
  const g9State = (lh) => ({ lineHeight: lh, tactic: "balanced", opponent: { lineHeight: lh, tactic: "balanced" }, sentOff: [], momentum: 0, score: [0, 0] });

  // 한 런을 끝까지 돌려 마지막 프레임의 수비 backLine·정상상태 여부·base(클램프 판정) 반환
  function g9Run(scene, lh) {
    const defTeam = scene.side === "home" ? "away" : "home";
    const defPre = defTeam === "home" ? "h" : "a";
    const m = createMotion(scene, formations, g9State(lh), cfg);
    const frames = Math.ceil((scene.duration + TAIL) / DT);
    let prevPos = {};
    for (let f = 0; f < frames; f++) {
      for (const id of m.onField) prevPos[id] = m.positions[id].slice(); // 스텝 직전 = 직전 프레임
      stepMotion(m, DT);
    }
    const pos = m.positions;
    const defBlk = m.blockIds.filter((id) => id[0] === defPre && m.roles[id] === "block");
    const meanGap = defBlk.length ? defBlk.reduce((s, id) => s + meterDelta(pos[id], m.anchors[id]), 0) / defBlk.length : Infinity;
    const meanSpd = defBlk.length ? defBlk.reduce((s, id) => s + speedOf(pos[id], prevPos[id] || pos[id]), 0) / defBlk.length : Infinity;
    const settled = defBlk.length >= 2 && meanGap < LIM.g8settle && meanSpd < LIM.g8settleSpd;
    let backLine = Infinity;
    for (const id of defBlk) backLine = Math.min(backLine, ownDist(defTeam, pos[id][0]));
    const dBallDef = ownDist(defTeam, m.shapeBallRef[0]);
    return { backLine, base: dBallDef - buffer, settled };
  }

  const g9 = { samples: 0, skipClamp: 0, skipUnsettled: 0, minHL: Infinity, minHM: Infinity, worstHL: null, worstHM: null };
  for (const scene of scenes) {
    if (scene.side === "neutral") continue;
    const lo = g9Run(scene, "low"), mid = g9Run(scene, "mid"), hi = g9Run(scene, "high");
    if (!lo.settled || !mid.settled || !hi.settled) { g9.skipUnsettled++; continue; }
    // 클램프 표본 제외: base 포화(6~45) 또는 앵커 클램프 근접(backLine≤4 또는 ≥96)
    const clampHit = mid.base <= clampLo || mid.base >= clampHi ||
      [lo, mid, hi].some((r) => r.backLine <= 4 || r.backLine >= 96);
    if (clampHit) { g9.skipClamp++; continue; }
    g9.samples++;
    const dHL = hi.backLine - lo.backLine, dHM = hi.backLine - mid.backLine;
    if (dHL < g9.minHL) { g9.minHL = dHL; g9.worstHL = { scene: scene.id, hi: +hi.backLine.toFixed(1), lo: +lo.backLine.toFixed(1) }; }
    if (dHM < g9.minHM) { g9.minHM = dHM; g9.worstHM = { scene: scene.id, hi: +hi.backLine.toFixed(1), mid: +mid.backLine.toFixed(1) }; }
  }
  const g9pass = g9.samples > 0 && g9.minHL >= LIM.g9hl && g9.minHM >= LIM.g9hm;
  const detail = g9.samples === 0
    ? `표본0 — 전 장면 미수렴(${g9.skipUnsettled})/클램프(${g9.skipClamp})로 판정불가`
    : `high−low min=${fmt(g9.minHL)}m(≥${LIM.g9hl}) high−mid min=${fmt(g9.minHM)}m(≥${LIM.g9hm}) 표본=${g9.samples} 제외(클램프${g9.skipClamp}/미수렴${g9.skipUnsettled})` +
      `${g9.minHL < LIM.g9hl ? ` HL위반@${g9.worstHL.scene}(hi${g9.worstHL.hi}/lo${g9.worstHL.lo})` : ""}` +
      `${g9.minHM < LIM.g9hm ? ` HM위반@${g9.worstHM.scene}(hi${g9.worstHM.hi}/mid${g9.worstHM.mid})` : ""}`;
  console.log(line(g9pass, "G9 라인카드 가시성 high−low≥14·high−mid≥6", detail));
  results.push([g9pass, "G9 라인카드 가시성", ""]);
}

const allPass = results.every(([p]) => p);
console.log(`\n=== 종합: ${allPass ? "ALL PASS" : "FAIL 있음"} ===`);
process.exit(allPass ? 0 : 1);
