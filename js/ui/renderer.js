// 피치 렌더러. 상태를 갖지 않는다 — 매 프레임 positions를 받아 그릴 뿐이다 (계획서 §4).
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  // 피치 좌표(0-100) → 캔버스 픽셀
  px(p) {
    const mx = 24, my = 18;
    return [mx + (p[0] / 100) * (this.w - mx * 2), my + (p[1] / 100) * (this.h - my * 2)];
  }

  draw(positions, sentOff) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    // 피치
    c.fillStyle = "#1d4a2a";
    c.fillRect(0, 0, this.w, this.h);
    c.strokeStyle = "rgba(255,255,255,0.35)";
    c.lineWidth = 1.5;
    const [x0, y0] = this.px([0, 0]);
    const [x1, y1] = this.px([100, 100]);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // 센터라인·서클
    const [cx, cy] = this.px([50, 50]);
    c.beginPath(); c.moveTo(cx, y0); c.lineTo(cx, y1); c.stroke();
    c.beginPath(); c.arc(cx, cy, (x1 - x0) * 0.08, 0, Math.PI * 2); c.stroke();
    // 페널티 박스
    for (const [bx, dir] of [[0, 1], [100, -1]]) {
      const [px0, py0] = this.px([bx, 24]);
      const [px1, py1] = this.px([bx + dir * 14, 76]);
      c.strokeRect(Math.min(px0, px1), py0, Math.abs(px1 - px0), py1 - py0);
    }
    // 골문
    c.fillStyle = "rgba(255,255,255,0.5)";
    for (const gx of [0, 100]) {
      const [gx0, gy0] = this.px([gx, 44]);
      const [, gy1] = this.px([gx, 56]);
      c.fillRect(gx0 - 3, gy0, 6, gy1 - gy0);
    }

    // 바둑알 22개
    const r = Math.max(7, (x1 - x0) * 0.013);
    for (const [id, p] of Object.entries(positions)) {
      if (id === "ball" || id === "ballZ") continue; // ballZ는 공 높이 스칼라, 알이 아니다
      const [sx, sy] = this.px(p);
      const isHome = id.startsWith("h");
      c.beginPath();
      c.arc(sx, sy, r, 0, Math.PI * 2);
      c.fillStyle = isHome ? "#3b82f6" : "#ef4444";
      c.fill();
      if (id === "h1" || id === "a1") { // GK 링
        c.strokeStyle = "rgba(255,255,255,0.9)";
        c.lineWidth = 2;
        c.stroke();
      }
    }

    // 공: 흰 점. ballZ(로프트 높이 0..1)에 따라 반지름 스케일 + 그림자 (계획서 §2.5).
    // 지상 공(z≈0)은 현행 흰 점 그대로. 크로스/로프트만 커지고 그림자가 분리된다.
    if (positions.ball) {
      const [bx, by] = this.px(positions.ball);
      const z = positions.ballZ || 0;
      const rad = r * 0.45 * (1 + 0.5 * z);
      const lift = z * r * 1.2; // 높이만큼 위로 띄우고 그림자는 지면에 남긴다
      if (z > 0.02) {
        c.beginPath();
        c.ellipse(bx, by, rad * (1 + 0.4 * z), rad * 0.55, 0, 0, Math.PI * 2);
        c.fillStyle = `rgba(0,0,0,${0.28 - 0.12 * z})`;
        c.fill();
      }
      c.beginPath();
      c.arc(bx, by - lift, rad, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.strokeStyle = "rgba(0,0,0,0.4)";
      c.lineWidth = 1;
      c.stroke();
    }
  }
}
