// 모션 엔진 v2 (계획서 §2). 순수 모듈 — DOM을 모른다. 경기 rng(match.rng)를 절대 소비하지 않는다.
// "공 중력장"(waypoints.js) 폐기 → 위치+속도를 dt로 적분하는 stateful 운동학 (계획서 §2.0).
//   createMotion(scene, formations, matchState, cfg) → 모션 상태 (장면 시작 배치 포함)
//   stepMotion(motion, dtSec) → 내부 상태 적분, motion.positions 갱신
//     positions = { h1..a11: [x,y], ball: [x,y], ballZ: 0..1 }
// 모든 알은 "목표점을 향해 가속/감속 상한 안에서 이동"(seek+arrival)하므로 목표가 아무리
// 빨리 움직여도 자기 속도 상한으로만 따라간다 — 지적 ①②④의 구조적 해결.
//
// matchState는 읽기만 한다(쓰기 금지). 미세 노이즈는 알 id 해시 위상 + 경과시간 기반(결정론, §2.0).

// ── 벡터 헬퍼 (전부 미터 공간) ─────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);
const distM = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampLen = (v, max) => { const l = len(v); return l > max ? scale(v, max / l) : v; };

// 0-100 좌표 ↔ 미터. 피치는 비등방(x≈105m, y≈68m)이라 METER_SCALE로 환산한다 (계획서 §2.0).
// 위치는 계속 0-100으로 저장하고, 속도·거리 계산만 미터로 하면 config 속도가 실축 m/s 그대로 읽힌다.
const toM = (p, ms) => [p[0] * ms[0], p[1] * ms[1]];
const toU = (pm, ms) => [pm[0] / ms[0], pm[1] / ms[1]];

// 알 id 결정론 해시 → 0..1 (rng 대체 — 반응지연·터치위상·골문분산에 사용)
function hash01(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0) / 4294967296;
}

// 프레임률 독립 지수 스무딩 (블록 시프트·터치 오프셋)
function easeTo(cur, target, dt, tau) {
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return [cur[0] + (target[0] - cur[0]) * k, cur[1] + (target[1] - cur[1]) * k];
}

// 목표점 추적 (seek + arrival), 가속 상한 (계획서 §2.1).
// 불변식: 시작 속도 ‖vm‖ ≤ maxSpeed 이면 스텝 후에도 ‖vm‖ ≤ maxSpeed (볼록성) → G1 상한 보장.
//         프레임간 속도 변화 ‖dv‖ ≤ accel·dt → 측정 가속 ≤ accel → G2 저크 보장.
function seek(st, targetM, maxSpeed, accel, dt, arrivalRadius) {
  const toT = sub(targetM, st.pm);
  const d = len(toT);
  const desiredSpeed = d < arrivalRadius ? maxSpeed * (d / arrivalRadius) : maxSpeed;
  const dir = d > 1e-9 ? scale(toT, 1 / d) : [0, 0];
  const desiredVel = scale(dir, desiredSpeed);
  let dv = sub(desiredVel, st.vm);
  const dvl = len(dv);
  const maxDv = accel * dt;
  if (dvl > maxDv) dv = scale(dv, maxDv / dvl);
  st.vm = add(st.vm, dv);
  st.pm = add(st.pm, scale(st.vm, dt));
}

// 경로 호 길이 s(미터)에서의 점 (등속 파라미터화, 계획서 §2.2)
function arcPoint(pathM, cum, s) {
  const n = pathM.length;
  if (n === 1) return pathM[0].slice();
  const total = cum[n - 1];
  if (s <= 0) return pathM[0].slice();
  if (s >= total) return pathM[n - 1].slice();
  let i = 0;
  while (i < n - 1 && cum[i + 1] < s) i++;
  const segLen = cum[i + 1] - cum[i];
  const f = segLen > 1e-9 ? (s - cum[i]) / segLen : 0;
  return [pathM[i][0] + (pathM[i + 1][0] - pathM[i][0]) * f,
          pathM[i][1] + (pathM[i + 1][1] - pathM[i][1]) * f];
}

const teamOf = (id) => (id[0] === "h" ? "home" : "away");
const isGkId = (id) => id === "h1" || id === "a1";
// 팀 공격 방향: 홈은 +x(상대 골대 x=100), 원정은 -x
const attackDir = (id) => (id[0] === "h" ? 1 : -1);

// 퇴장 알 → 같은 팀 필드 위 최근접 알로 치환 (계획서 §2.2, IDEAS #7 해결)
function nearestSameTeamOnField(origId, formations, sentOff, taken) {
  const team = teamOf(origId);
  const base = formations[team][origId];
  if (!base) return null;
  let best = null, bestD = Infinity;
  for (const id of Object.keys(formations[team])) {
    if (sentOff.has(id) || taken.has(id)) continue;
    const d = Math.hypot(formations[team][id][0] - base[0], formations[team][id][1] - base[1]);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// ── 장면 인스턴스화 ────────────────────────────────────────
export function createMotion(scene, formations, matchState, cfg) {
  const M = cfg.motion;
  const ms = M.meterScale;
  const P = M.player;
  const sentOff = new Set(matchState.sentOff || []);

  // 1) 퇴장자 리매핑: 배우 경로 & 공 엔트리 참조 id를 치환한다 (계획서 §2.2)
  const idRemap = {};
  const takenActors = new Set(
    Object.keys(scene.waypoints).filter((k) => k !== "ball" && !sentOff.has(k))
  );
  for (const id of Object.keys(scene.waypoints)) {
    if (id === "ball" || !sentOff.has(id)) continue;
    const sub2 = nearestSameTeamOnField(id, formations, sentOff, takenActors);
    if (sub2) { idRemap[id] = sub2; takenActors.add(sub2); }
  }
  const resolveId = (id) => idRemap[id] || id;

  // 2) 배우(웨이포인트 참가자) — 경로를 미터 공간 호 길이로 사전 계산
  const stones = {};   // id -> { pm, vm, ... }
  const actorIds = [];
  for (const [rawId, pts] of Object.entries(scene.waypoints)) {
    if (rawId === "ball") continue;
    const id = resolveId(rawId);
    if (sentOff.has(id) || stones[id]) continue;
    const pathM = pts.map((p) => toM(p, ms));
    const cum = [0];
    for (let i = 1; i < pathM.length; i++) cum[i] = cum[i - 1] + distM(pathM[i - 1], pathM[i]);
    const pathLenM = cum[cum.length - 1];
    const cruise = scene.duration > 0 ? pathLenM / scene.duration : 0;
    stones[id] = {
      pm: pathM[0].slice(), vm: [0, 0],
      pathM, cum, cruise,
      maxSpeed: Math.min(cruise + M.actor.catchup, M.actor.speedCap),
    };
    actorIds.push(id);
  }

  // 3) 나머지 필드 알 (블록/압박/GK) — 초기 배치는 완성된 형상으로 시작 (컷=재배치, 계획서 §2.3-B)
  const gkIds = [];
  const blockIds = [];
  const onField = [...actorIds];
  const depthRank = computeDepthRanks(formations);

  // 초기 공 위치(0-100)를 먼저 알아야 형상 라인을 계산할 수 있다
  const ballEntries = scene.waypoints.ball || [];
  const firstBallU = initialBallUnits(ballEntries, resolveId, stones, formations, ms);
  const S = M.shape;
  // 컷 시 라인 즉시 초기화(스무딩 없이) — 초기 배치는 완성된 형상 (계획서 §2.3-B)
  const rawInit = {
    home: teamRawShape("home", firstBallU, scene.side, matchState, S),
    away: teamRawShape("away", firstBallU, scene.side, matchState, S),
  };

  for (const team of ["home", "away"]) {
    for (const id of Object.keys(formations[team])) {
      if (stones[id] || sentOff.has(id)) continue;
      const react = P.reactionMin + hash01(id) * (P.reactionMax - P.reactionMin);
      const tau = S.smoothTau * (0.7 + 0.6 * hash01(id + "t")); // 알별 지터 → 전원 동시반응 제거
      const st = { pm: [0, 0], vm: [0, 0], react, tau };
      stones[id] = st;
      onField.push(id);
      if (isGkId(id)) {
        gkIds.push(id);
        st.pm = toM(gkTarget(id, firstBallU, rawInit, scene.side, formations, M, ms), ms);
      } else {
        blockIds.push(id);
        st.shape = { ...rawInit[team] };   // 즉시 완성 형상 (스무딩 없이)
        st.pm = toM(anchorFrom(id, st.shape, formations, depthRank), ms);
      }
    }
  }

  const motion = {
    scene, formations, matchState, cfg, ms,
    elapsed: 0,
    stones, actorIds, blockIds, gkIds, onField,
    depthRank,
    shapeBallRef: firstBallU.slice(),   // 형상 기준 볼 위치(통제 볼만 추종, 계획서 §2.3-B)
    presserId: null, presserSince: 0,
    // 공 상태 기계 (계획서 §2.4)
    ball: {
      entries: ballEntries.map((e) => remapBallEntry(e, resolveId)),
      entryIdx: 0, entryStart: 0,
      mode: "settle", carrierId: null, carryOffsetM: [0, 0],
      flightFrom: [0, 0], flightTo: [0, 0], flightSpeed: 0, flightDur: 0, flightElapsed: 0,
      flightKind: null, attachTo: null, lofted: false,
      pos: toM(firstBallU, ms), z: 0, nominalSpeed: 0,
      lastDir: [attackDir("h"), 0], touchPhase: hash01(scene.id || "s") * 6.283,
    },
    // 골문 조준점 (y는 장면별 해시 분산, 계획서 §2.4)
    shotAimM: {
      away: toM([100, shotGoalY(scene, M)], ms),
      home: toM([0, shotGoalY(scene, M)], ms),
    },
    // 린트/게이트 노출용 (렌더러는 positions만 읽는다)
    roles: {}, anchors: {}, positions: {},
  };

  initBallEntry(motion, 0);
  writePositions(motion);
  return motion;
}

// 공 첫 엔트리의 초기 위치(0-100). attach면 캐리어 경로[0], point면 좌표.
function initialBallUnits(entries, resolveId, stones, formations, ms) {
  if (!entries || entries.length === 0) return [50, 50];
  const e = entries[0];
  if (e.startsWith("point:")) return e.slice(6).split(",").map(Number);
  if (e.startsWith("shot:")) return e === "shot:away_goal" ? [100, 50] : [0, 50];
  const id = resolveId(e.includes(":") ? e.split(":")[1] : e);
  const st = stones[id];
  if (st) return toU(st.pm, ms);
  const base = formations[teamOf(id)]?.[id];
  return base ? base.slice() : [50, 50];
}

function remapBallEntry(entry, resolveId) {
  if (entry.startsWith("shot:") || entry.startsWith("point:")) return entry;
  if (entry.includes(":")) {
    const [verb, id] = entry.split(":");
    return `${verb}:${resolveId(id)}`;
  }
  return resolveId(entry);
}

// ── 스텝 ────────────────────────────────────────────────────
// 적분 견고성 가드: 탭 전환·프레임 스로틀링으로 dt가 거대해지면(수 초) 오일러 적분이
// 폭주한다(속도×dt만큼 피치 밖으로). dt를 서브스텝으로 쪼개고, 한도를 넘는 밀린 시간은
// 버린다 — 모션은 잠깐 멈춘 것처럼 보일 뿐 절대 폭주하지 않는다. (튜닝 수치가 아니라
// 적분기 내부 상수라 config에 두지 않는다.)
const MAX_SUBSTEP = 1 / 30;
const MAX_STEP_BUDGET = 0.4; // 한 호출이 적분하는 최대 시간(초)

export function stepMotion(motion, dt) {
  let remaining = Math.min(Math.max(dt, 0), MAX_STEP_BUDGET);
  while (remaining > 1e-9) {
    const h = Math.min(remaining, MAX_SUBSTEP);
    remaining -= h;
    motion.elapsed += h;
    // 순서: 배우(독립) → 공(캐리어=배우 위치 참조) → 역할 선정 → 블록/압박/GK(공 위치 참조)
    stepActors(motion, h);
    stepBall(motion, h);
    assignPresser(motion);
    stepOthers(motion, h);
  }
  writePositions(motion);
  return motion.positions;
}

function stepActors(motion, dt) {
  const { cfg } = motion;
  const P = cfg.motion.player;
  for (const id of motion.actorIds) {
    const st = motion.stones[id];
    const carrot = arcPoint(st.pathM, st.cum, st.cruise * motion.elapsed); // 등속 캐럿 추적(pure pursuit)
    seek(st, carrot, st.maxSpeed, P.accel, dt, P.arrivalRadius);
    motion.roles[id] = "actor";
  }
}

function stepOthers(motion, dt) {
  const { cfg, formations, ms } = motion;
  const M = cfg.motion, P = M.player, S = M.shape;
  const sceneSide = motion.scene.side;

  // 팀별 형상 원시 목표: 형상 기준 볼 위치(통제 볼만 추종)·카드로 매 스텝 갱신; 알별 tau로 이징 (계획서 §2.3-B)
  const shapeU = motion.shapeBallRef;
  const raw = {
    home: teamRawShape("home", shapeU, sceneSide, motion.matchState, S),
    away: teamRawShape("away", shapeU, sceneSide, motion.matchState, S),
  };

  const liveBallU = toU(motion.ball.pos, ms); // GK는 라이브 볼에 반응(박스 진입·y 추종)
  for (const id of motion.gkIds) {
    // GK: 수비 GK 현행(박스 안 전진, 공 y 추종), 공격 GK 스위퍼 전진 (계획서 §2.3-B)
    const st = motion.stones[id];
    seek(st, toM(gkTarget(id, liveBallU, raw, sceneSide, formations, M, ms), ms), P.jog, P.accel, dt, P.arrivalRadius);
    motion.roles[id] = "gk";
  }

  for (const id of motion.blockIds) {
    const st = motion.stones[id];
    // 라인 값 이징(τ=2.5s, 알별 지터) — 컷 후 형상은 완성 상태에서 출렁인다
    st.shape = easeShape(st.shape, raw[teamOf(id)], dt, st.tau);
    const anchor = anchorFrom(id, st.shape, formations, motion.depthRank);
    const anchorM = toM(anchor, ms);
    motion.anchors[id] = anchor;

    const carrier = motion.ball.carrierId ? motion.stones[motion.ball.carrierId] : null;
    if (id === motion.presserId) st.engaged = true;
    const activePress = id === motion.presserId && carrier &&
      motion.elapsed - motion.presserSince >= st.react;

    if (activePress) {
      // 압박자 1인: 캐리어의 자기 골문 쪽 standoff 지점까지 run으로 접근 (계획서 §2.3-B)
      const ownGoalM = toM(teamOf(id) === "home" ? [0, 50] : [100, 50], ms);
      const toGoal = sub(ownGoalM, carrier.pm);
      const gl = len(toGoal);
      const standoff = gl > 1e-6 ? scale(toGoal, M.press.standoff / gl) : [0, 0];
      seek(st, add(carrier.pm, standoff), P.run, P.accel, dt, P.arrivalRadius);
      motion.roles[id] = "press";
    } else if (st.engaged) {
      // 압박 관여 알의 복귀: 앵커로 jog 복귀. 진형에 재합류(recoverRadius 내)할 때까지
      // '압박'으로 분류한다 — 복귀 중인 알은 '비관여·비압박'이 아니다(공을 따라 미끄러지는 게 아님).
      seek(st, anchorM, P.jog, P.accel, dt, P.arrivalRadius);
      motion.roles[id] = "press";
      // 진형 근처 + 감속 완료 후에만 블록 복귀 — 압박 관성(run 속도)이 남은 채 block으로 새면 G4′ 위반
      if (distM(st.pm, anchorM) <= M.press.recoverRadius && len(st.vm) <= P.jog * 1.02) st.engaged = false;
    } else {
      // 블록: 형상 앵커 + 유휴 미세 흔들림. 앵커까지 ≤runThreshold면 jog, >면 run
      // (라인 스윙 재정렬은 뛰어서 — 실축구 그대로. 공 비행 동조 금지는 G4′로 봉인).
      const ph = hash01(id) * 6.283;
      const noiseU = [
        Math.sin(motion.elapsed * M.idle.freq + ph) * M.idle.driftRadius,
        Math.cos(motion.elapsed * M.idle.freq * 0.8 + ph * 1.7) * M.idle.driftRadius,
      ];
      // 앵커까지 ≤runThreshold면 jog, 넘으면 run. 단 runRamp 구간에서 run→jog를 매끄럽게 낮춰
      // 8m 경계를 지날 때 이미 jog로 감속돼 있게 한다 — 급감속이 G4′-근접(≤4.2)을 넘지 않도록.
      const dA = distM(st.pm, anchorM);
      const spd = dA <= S.runThreshold ? P.jog
        : Math.min(P.run, P.jog + (P.run - P.jog) * (dA - S.runThreshold) / S.runRamp);
      seek(st, toM([anchor[0] + noiseU[0], anchor[1] + noiseU[1]], ms), spd, P.accel, dt, P.arrivalRadius);
      motion.roles[id] = "block";
    }
  }
}

// 압박자 선정: 수비팀 필드 알 중 캐리어에 존(포메이션 슬롯)이 가장 가까운 1인 (계획서 §2.3).
// 라이브 위치가 아니라 '존'으로 고르는 이유: 라이브로 고르면 중원의 전방 알이 자기 진영 코너까지
// 끌려나가 진형이 붕괴한다(지적 ②). 존이 캐리어에서 engageDist(m) 밖이면 아무도 압박하지 않는다.
function assignPresser(motion) {
  const side = motion.scene.side;
  const defTeam = side === "home" ? "away" : side === "away" ? "home" : null;
  if (!defTeam) { motion.presserId = null; return; }
  const defPrefix = defTeam === "home" ? "h" : "a";

  // 배우로 이미 참여 중인 수비 알이 있으면 그 알이 압박을 겸한다 → 별도 압박자 없음
  if (motion.actorIds.some((id) => id[0] === defPrefix)) { motion.presserId = null; return; }

  // 공이 캐리어에 붙어 있을 때만 압박 대상이 명확하다 (비행/루즈 중엔 직전 압박자 유지)
  const carrier = motion.ball.carrierId ? motion.stones[motion.ball.carrierId] : null;
  if (!carrier) return;

  const M = motion.cfg.motion, ms = motion.ms, S = M.shape;
  const carrierU = toU(carrier.pm, ms);
  // 존(형상 앵커)으로 캐리어 최근접 수비 알 1인 선정 — 라이브 위치로 고르면 진형 붕괴(지적 ②)
  const rawDef = teamRawShape(defTeam, motion.shapeBallRef, side, motion.matchState, S);
  let best = null, bestD = Infinity;
  for (const id of motion.blockIds) {
    if (id[0] !== defPrefix) continue;
    const za = anchorFrom(id, rawDef, motion.formations, motion.depthRank);
    const d = Math.hypot((za[0] - carrierU[0]) * ms[0], (za[1] - carrierU[1]) * ms[1]);
    if (d < bestD) { bestD = d; best = id; }
  }
  const desired = best !== null && bestD <= M.press.engageDist ? best : null;

  const cur = motion.presserId;
  const curValid = cur && motion.stones[cur] && motion.blockIds.includes(cur);
  if (curValid && motion.elapsed - motion.presserSince < M.press.hysteresisSec) return;
  if (desired !== cur) { motion.presserId = desired; motion.presserSince = motion.elapsed; }
}

// ── 공 물리 상태 기계 (계획서 §2.4) ────────────────────────
function stepBall(motion, dt) {
  const b = motion.ball;
  const M = motion.cfg.motion, ms = motion.ms;
  advanceBallEntry(motion);

  if (b.mode === "carry") {
    const carrier = motion.stones[b.carrierId];
    const cpm = carrier ? carrier.pm : b.pos;
    const spd = carrier ? len(carrier.vm) : 0;
    if (spd > 0.3) b.lastDir = scale(carrier.vm, 1 / spd);
    // 진행방향 앞 carryAhead ± 터치 진동 = 드리블 질감. 오프셋은 이징(순간이동 방지)
    const touch = M.ball.carryAhead + M.ball.carryAheadAmp * Math.sin(motion.elapsed * M.ball.touchFreq + b.touchPhase);
    const desiredOff = scale(b.lastDir, Math.max(0.2, touch));
    b.carryOffsetM = clampLen(easeTo(b.carryOffsetM, desiredOff, dt, M.ball.offsetTau), M.ball.carryMaxDist); // 캐리어 거리 하드 상한 (G5b 봉인)
    b.pos = add(cpm, b.carryOffsetM);
    b.z = 0;
    b.nominalSpeed = spd;
  } else if (b.mode === "flight") {
    b.flightElapsed += dt;
    const f = b.flightDur > 0 ? Math.min(1, b.flightElapsed / b.flightDur) : 1;
    b.pos = [b.flightFrom[0] + (b.flightTo[0] - b.flightFrom[0]) * f,
             b.flightFrom[1] + (b.flightTo[1] - b.flightFrom[1]) * f];
    b.z = b.lofted ? 4 * M.ball.loftHeight * f * (1 - f) : 0;
    b.nominalSpeed = b.flightSpeed;
    if (f >= 1) {
      if (b.attachTo && motion.stones[b.attachTo]) {
        b.mode = "carry"; b.carrierId = b.attachTo;
        b.carryOffsetM = clampLen(sub(b.pos, motion.stones[b.attachTo].pm), M.ball.carryMaxDist); // 이음새 연속·거리상한
      } else {
        b.mode = "settle";
      }
      b.attachTo = null; b.flightKind = null;
    }
  } else { // settle
    b.z = 0; b.nominalSpeed = 0;
  }

  // 형상 기준 볼 위치 갱신 (계획서 §2.3-B '볼 위치' 정련):
  //  - carry: 통제된 볼을 추종
  //  - 받을 패스/크로스(attachTo 있음): 도착지를 선반영(수비가 패스를 읽고 미리 이동)
  //  - 슛·데드볼: 유지(형상이 30m/s 슛/골에 멈춘 공을 실시간 추종해 골문까지 붕괴하지 않게)
  // 이동은 refMaxSpeed로 rate-limit — 이 상한이 앵커 이동 속도를 알 추종 속도 이하로 묶어
  // 라인 스윙 시에도 알이 앵커를 따라잡게 한다(패스 수신 순간의 순간 점프 제거 → G3 봉인).
  let refTgt;
  if (b.mode === "carry") refTgt = toU(b.pos, ms);
  else if (b.mode === "flight" && b.attachTo) refTgt = toU(b.flightTo, ms);
  else refTgt = motion.shapeBallRef;
  const refM = toM(motion.shapeBallRef, ms), tgtM = toM(refTgt, ms);
  const dRef = distM(refM, tgtM);
  const maxStep = M.shape.refMaxSpeed * dt;
  motion.shapeBallRef = dRef <= maxStep || dRef < 1e-9 ? refTgt.slice()
    : toU([refM[0] + (tgtM[0] - refM[0]) * (maxStep / dRef), refM[1] + (tgtM[1] - refM[1]) * (maxStep / dRef)], ms);
}

// 엔트리 전진: 이동형은 물리 비행 완료까지 대기(경계 넘치면 dwell 축소), attach/settle은 경계 시각에 전진.
function advanceBallEntry(motion) {
  const b = motion.ball;
  const N = b.entries.length;
  const dur = motion.scene.duration || 1;
  let guard = 0;
  while (b.entryIdx < N - 1 && guard++ < N + 2) {
    const nextNominal = ((b.entryIdx + 1) / N) * dur;
    const flightDone = b.mode !== "flight" || b.flightElapsed >= b.flightDur;
    const done = motion.elapsed >= nextNominal && flightDone;
    if (!done) break;
    b.entryIdx++;
    initBallEntry(motion, b.entryIdx);
  }
}

function initBallEntry(motion, idx) {
  const b = motion.ball;
  const M = motion.cfg.motion, ms = motion.ms;
  const raw = b.entries[idx];
  b.entryStart = motion.elapsed;

  if (raw.startsWith("shot:")) {
    const aim = raw === "shot:away_goal" ? motion.shotAimM.away : motion.shotAimM.home;
    startFlight(b, b.pos, aim, ballSpeed(distM(b.pos, aim), M.ball, "shot"), "shot", null, false);
    return;
  }
  if (raw.startsWith("point:")) {
    const to = toM(raw.slice(6).split(",").map(Number), ms);
    if (idx === 0) { b.mode = "settle"; b.pos = to; b.z = 0; }
    else startFlight(b, b.pos, to, M.ball.looseSpeed, "loose", null, false);
    return;
  }
  const isPass = raw.startsWith("pass:");
  const isCross = raw.startsWith("cross:");
  if (isPass || isCross) {
    const id = raw.split(":")[1];
    const kind = isCross ? "cross" : "pass";
    const { to, speed } = leadPredict(motion, id, kind);
    startFlight(b, b.pos, to, speed, kind, id, isCross);
    return;
  }
  // attach
  const cid = raw;
  const carrier = motion.stones[cid];
  const cpm = carrier ? carrier.pm : b.pos;
  if (idx === 0) {
    b.mode = "carry"; b.carrierId = cid; b.carryOffsetM = [0, 0]; b.pos = cpm.slice(); b.z = 0;
  } else if (distM(b.pos, cpm) > M.ball.carryAttachDist) {
    // 공이 멀면 캐리어 도착 예상지점으로 굴러가 부착(collect) — 순간이동/도착 오차 방지
    const fd0 = M.ball.collectSpeed > 1e-6 ? distM(b.pos, cpm) / M.ball.collectSpeed : 0;
    const to = carrier ? add(cpm, scale(carrier.vm, fd0)) : cpm;
    startFlight(b, b.pos, to, M.ball.collectSpeed, "loose", cid, false);
  } else {
    b.mode = "carry"; b.carrierId = cid; b.carryOffsetM = clampLen(sub(b.pos, cpm), M.ball.carryMaxDist);
  }
}

function startFlight(b, from, to, speed, kind, attachTo, lofted) {
  b.mode = "flight";
  b.flightFrom = from.slice(); b.flightTo = to.slice();
  b.flightSpeed = speed; b.flightKind = kind; b.attachTo = attachTo; b.lofted = lofted;
  b.flightElapsed = 0;
  const d = distM(from, to);
  b.flightDur = speed > 1e-6 ? d / speed : 0;
}

// 패스 타겟 리드: 수신 알의 도착 시점 예상 위치로 1회 반복 조준 (계획서 §2.4)
function leadPredict(motion, id, kind) {
  const b = motion.ball;
  const s = motion.stones[id];
  if (!s) return { to: b.pos.slice(), speed: motion.cfg.motion.ball.passMin };
  const d0 = distM(b.pos, s.pm);
  const speed = ballSpeed(d0, motion.cfg.motion.ball, kind);
  const fd0 = speed > 1e-6 ? d0 / speed : 0;
  return { to: add(s.pm, scale(s.vm, fd0)), speed };
}

// 거리(미터) 비례 비행 속도 (계획서 §2.4 표)
function ballSpeed(dM, B, kind) {
  if (kind === "shot") return clamp(B.shotMin + (B.shotMax - B.shotMin) * (dM / B.shotDistRef), B.shotMin, B.shotMax);
  if (kind === "cross") return clamp(B.loftMin + (B.loftMax - B.loftMin) * (dM / B.loftDistRef), B.loftMin, B.loftMax);
  return clamp(B.passMin + (B.passMax - B.passMin) * (dM / B.passDistRef), B.passMin, B.passMax);
}

// ── 축구 형상 모델 헬퍼 (계획서 §2.3-B) ─────────────────────
// 경기의 지리는 볼과 점유가 정한다. 팀별 backLine/frontLine(자기 골문 거리, x단위≈m)을 계산하고
// 필드 플레이어를 depthRank로 그 사이에 사상. 라인 값은 stepOthers에서 τ로 이징(알별 지터 유지).
const otherTeam = (t) => (t === "home" ? "away" : "home");

// depthRank: 진형 기준 x의 팀 내 정규화 순위(공격방향 투영, GK 제외). DF≈0/MF≈0.5/FW≈1. createMotion에서 1회 계산.
function computeDepthRanks(formations) {
  const ranks = {};
  for (const team of ["home", "away"]) {
    const ids = Object.keys(formations[team]).filter((id) => !isGkId(id));
    const fwd = {};
    let lo = Infinity, hi = -Infinity;
    for (const id of ids) {
      fwd[id] = attackDir(id) * formations[team][id][0]; // 공격 방향 투영(전방일수록 큼)
      lo = Math.min(lo, fwd[id]); hi = Math.max(hi, fwd[id]);
    }
    const span = hi - lo || 1;
    for (const id of ids) ranks[id] = (fwd[id] - lo) / span;
  }
  return ranks;
}

// 장면 side 기준 팀 역할
function roleOf(team, sceneSide) {
  if (sceneSide !== "home" && sceneSide !== "away") return "neutral";
  return team === sceneSide ? "attack" : "defend";
}
// 자기 골문에서 공까지 거리 (홈=ballX, 원정=100−ballX)
function dBallOwnOf(team, ballU) {
  const bx = clamp(ballU[0], 0, 100);
  return team === "home" ? bx : 100 - bx;
}
function teamStateOf(team, state) { return team === "home" ? state : state.opponent; }

// 카드 연동(자기 팀 상태): lineHeight low/mid/high=back −5/0/+5, tactic attack+3/counter−3/park−6 (계획서 §2.3-B)
function cardBackShift(teamState, S) {
  const lh = teamState.lineHeight === "low" ? -S.lineHeight
           : teamState.lineHeight === "high" ? S.lineHeight : 0;
  const tb = teamState.tactic === "attack" ? S.tactic.attackBack
           : teamState.tactic === "counter" ? -S.tactic.counterBack
           : teamState.tactic === "park" ? -S.tactic.parkBack : 0;
  return lh + tb;
}

// 팀 backLine 거리(자기 골문 기준). 오프사이드 참조용으로 분리 — 공격 front가 상대 back을 읽는다.
function backDistOf(team, ballU, sceneSide, state, S) {
  const role = roleOf(team, sceneSide);
  const C = S[role];
  const d = dBallOwnOf(team, ballU);
  return clamp(d - C.buffer, C.backClampLo, C.backClampHi) + cardBackShift(teamStateOf(team, state), S);
}

// 팀 라인/폭/중심y 원시 목표(미스무딩). backX/frontX는 0-100 x좌표.
function teamRawShape(team, ballU, sceneSide, state, S) {
  const role = roleOf(team, sceneSide);
  const ts = teamStateOf(team, state);
  const d = dBallOwnOf(team, ballU);
  const wMod = ts.tactic === "attack" ? S.tactic.attackWidth : 0;
  const lenMod = ts.tactic === "park" ? -S.tactic.parkLength : 0;
  const backDist = backDistOf(team, ballU, sceneSide, state, S);

  let frontDist, width, yGain;
  if (role === "defend") {
    frontDist = Math.min(backDist + S.defend.length + lenMod, d + S.defendFrontAhead);
    width = S.defend.width + wMod; yGain = S.defend.yGain;
  } else if (role === "attack") {
    // front = 상대 backLine x − offsideGap(오프사이드), back+minLength 이상 보장
    const defBack = backDistOf(otherTeam(team), ballU, sceneSide, state, S);
    frontDist = Math.max(100 - defBack - S.attack.offsideGap, backDist + S.attack.minLength);
    width = (d > S.attack.finalThirdDist ? S.attack.widthFinalThird : S.attack.width) + wMod;
    yGain = S.attack.yGain;
  } else { // neutral
    frontDist = backDist + S.neutral.length + lenMod;
    width = S.neutral.width + wMod; yGain = S.neutral.yGain;
  }
  const backX = team === "home" ? backDist : 100 - backDist;
  const frontX = team === "home" ? frontDist : 100 - frontDist;
  return { backX, frontX, cy: 50 + (ballU[1] - 50) * yGain, width };
}

// 알 앵커 = backX~frontX를 depthRank로 lerp, y=블록중심 + (기준y−50)×폭계수, [3,97] 클램프
function anchorFrom(id, shape, formations, depthRank) {
  const base = formations[teamOf(id)][id];
  const x = shape.backX + (shape.frontX - shape.backX) * depthRank[id];
  const y = shape.cy + (base[1] - 50) * shape.width;
  return [clamp(x, 3, 97), clamp(y, 3, 97)];
}
// 형상 라인 값 프레임률 독립 이징 (τ=2.5s)
function easeShape(cur, tgt, dt, tau) {
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return {
    backX: cur.backX + (tgt.backX - cur.backX) * k,
    frontX: cur.frontX + (tgt.frontX - cur.frontX) * k,
    cy: cur.cy + (tgt.cy - cur.cy) * k,
    width: cur.width + (tgt.width - cur.width) * k,
  };
}

// GK: 수비 GK 현행(박스 안 advance 전진, y는 공 추종). 공격 GK는 스위퍼 — backLine×ratio 전진(≤sweeperMaxX).
function gkTarget(id, ballU, raw, sceneSide, formations, M, ms) {
  const team = teamOf(id);
  const home = id === "h1";
  let x;
  if (roleOf(team, sceneSide) === "attack") {
    const backDist = home ? raw[team].backX : 100 - raw[team].backX; // 자기 골문 거리
    const advDist = Math.min(backDist * M.gk.sweeperRatio, M.gk.sweeperMaxX);
    x = home ? advDist : 100 - advDist;
  } else {
    const base = formations[team][id];
    const inBox = home ? ballU[0] <= M.gk.boxX : ballU[0] >= 100 - M.gk.boxX;
    const advanceU = (inBox ? M.gk.advance : 0) / ms[0]; // 미터 → x단위
    x = base[0] + (home ? advanceU : -advanceU);
  }
  const y = 50 + clamp(ballU[1] - 50, -M.gk.trackClampY, M.gk.trackClampY);
  return [x, y];
}

// shot: 골문 y 지점(장면별 해시 분산)
function shotGoalY(scene, M) {
  const [lo, hi] = M.ball.goalY;
  return lo + hash01((scene.id || "s") + "goal") * (hi - lo);
}

// ── positions 출력 (렌더러/린트가 읽는 유일한 원본) ─────────
function writePositions(motion) {
  const ms = motion.ms;
  const pos = {};
  for (const id of motion.onField) pos[id] = toU(motion.stones[id].pm, ms);
  pos.ball = toU(motion.ball.pos, ms);
  pos.ballZ = motion.ball.z;
  motion.positions = pos;
}
