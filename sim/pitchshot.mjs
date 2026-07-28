// 헤드리스 결정론 피치 스냅샷 (goal-harness 연출대).
// 시뮬 상태 → PNG. 브라우저·캔버스·외부 패키지 없이 node 내장 zlib 만 쓴다.
// 브라우저 캡처가 흔들려도(서버 다운·렌더 지연) 이 경로는 항상 같은 입력에 같은 그림을 낸다.
//
// 심판은 이 PNG 를 docs/reference/target-pitch.png 와 나란히 놓고 "판이 축구로 읽히는가"를 본다.
// 주의: 이 렌더러는 viewer.html 을 대신하지 않는다. 뷰어 캡처는 별도로 반드시 수행한다(§연출대).

import { deflateSync } from 'node:zlib';
import { FIELD } from '../js/game/field.js';

const PX = 8;                                    // m → px
const MARGIN = 6 * PX;                           // 라인 밖 여백(m 환산 6m)
export const W = Math.round(FIELD.length * PX) + MARGIN * 2;
export const H = Math.round(FIELD.width * PX) + MARGIN * 2;

const C = {
  grassA: [58, 122, 62], grassB: [53, 114, 57],  // 잔디 줄무늬
  line: [235, 240, 235],
  teamA: [58, 96, 200], teamB: [200, 66, 62],
  gkA: [232, 214, 92], gkB: [92, 208, 150],
  ball: [252, 252, 250], ballEdge: [30, 30, 30],
  out: [26, 30, 26],
};

// ── 래스터 ───────────────────────────────────────────────────
function makeBuf() {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inField = x >= MARGIN && x < W - MARGIN && y >= MARGIN && y < H - MARGIN;
      const stripe = Math.floor((x - MARGIN) / (PX * 8)) % 2 === 0;
      const c = !inField ? C.out : (stripe ? C.grassA : C.grassB);
      const i = (y * W + x) * 3;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    }
  }
  return buf;
}
const put = (buf, x, y, c) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = ((y | 0) * W + (x | 0)) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
};
// 월드(m) → 픽셀. x∈[-52.5,52.5] → 좌→우, z∈[-34,34] → 상→하.
const px = (x) => MARGIN + (x + FIELD.halfLength) * PX;
const py = (z) => MARGIN + (z + FIELD.halfWidth) * PX;

function line(buf, x0, y0, x1, y1, c, w = 2) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < w; dy++) put(buf, x + dx, y + dy, c);
  }
}
const rect = (buf, x0, y0, x1, y1, c, w = 2) => {
  line(buf, x0, y0, x1, y0, c, w); line(buf, x1, y0, x1, y1, c, w);
  line(buf, x1, y1, x0, y1, c, w); line(buf, x0, y1, x0, y0, c, w);
};
function circle(buf, cx, cy, r, c, fill = false, w = 2) {
  if (fill) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) put(buf, cx + x, cy + y, c);
    return;
  }
  for (let a = 0; a < 360 * 4; a++) {
    const t = a * Math.PI / 720;
    for (let k = 0; k < w; k++) put(buf, cx + Math.cos(t) * (r + k), cy + Math.sin(t) * (r + k), c);
  }
}

function drawPitch(buf) {
  const L = C.line;
  rect(buf, px(-52.5), py(-34), px(52.5), py(34), L);
  line(buf, px(0), py(-34), px(0), py(34), L);
  circle(buf, px(0), py(0), 9.15 * PX, L);
  circle(buf, px(0), py(0), 3, L, true);
  for (const s of [-1, 1]) {
    rect(buf, px(s * 52.5), py(-20.16), px(s * (52.5 - 16.5)), py(20.16), L);   // 페널티 박스
    rect(buf, px(s * 52.5), py(-9.16), px(s * (52.5 - 5.5)), py(9.16), L);      // 골 에어리어
    circle(buf, px(s * (52.5 - 11)), py(0), 3, L, true);                        // PK 스팟
    rect(buf, px(s * 52.5), py(-3.66), px(s * 54.5), py(3.66), L);              // 골대
  }
}

/** 상태를 그려 PNG Buffer 를 돌려준다. 같은 상태 → 바이트 단위로 같은 결과. */
export function renderPitch(state) {
  const buf = makeBuf();
  drawPitch(buf);
  for (const p of Object.values(state.players)) {
    if (p.sentOff) continue;
    const isGK = p.role === 'GK';
    const c = isGK ? (p.teamId === 'A' ? C.gkA : C.gkB) : (p.teamId === 'A' ? C.teamA : C.teamB);
    const x = px(p.position.x), y = py(p.position.z);
    circle(buf, x, y, 7, [20, 22, 20], true);    // 외곽(대비)
    circle(buf, x, y, 6, c, true);
    if (p.hasBall) circle(buf, x, y, 9, C.line, false, 2);
  }
  const b = state.ball.position;
  circle(buf, px(b.x), py(b.z), 4, C.ballEdge, true);
  circle(buf, px(b.x), py(b.z), 3, C.ball, true);
  return encodePng(buf);
}

// ── 최소 PNG 인코더 (RGB8, 필터 0) ───────────────────────────
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgb) {
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;                                     // 필터 None
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
