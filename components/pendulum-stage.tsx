'use client';
import { useEffect, useRef } from 'react';
import type { Experiment } from '@/lib/experiment';
import { degrees, parameters } from '@/lib/physics';

export function PendulumStage({ engine }: { engine: Experiment }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ pointer: number; offset: number } | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    let width = 700, height = 400, raf = 0, grid = new Path2D();
    const observer = new ResizeObserver(entries => { const box = entries[0].contentRect; width = box.width; height = box.height; const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); grid = new Path2D(); for (let gx = 18; gx < width; gx += 22) for (let gy = 14; gy < height; gy += 22) { grid.moveTo(gx + .65, gy); grid.arc(gx, gy, .65, 0, Math.PI * 2); } });
    observer.observe(canvas);
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const p = parameters(engine.config.topology), s = engine.displayState();
      const scale = Math.min((width - 90) / 6, 105), center = width / 2, py = height * .53;
      const x = center + s[0] * scale;
      ctx.fillStyle = '#dae1d3';
      ctx.fill(grid);
      const line = (x1: number, y1: number, x2: number, y2: number, color: string, weight = 1) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.stroke(); };
      const circle = (cx: number, cy: number, radius: number, fill: string, stroke?: string) => { ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); } };
      if (engine.dragTarget !== null) { const target = center + engine.dragTarget * scale; ctx.setLineDash([3, 4]); line(x, py + 8, target, py + 8, '#c66b34', 2); ctx.setLineDash([]); circle(target, py + 8, 5, '#fff4e8', '#c66b34'); }
      ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.setLineDash([4, 5]); line(center, 42, center, height - 46, '#d0dac6'); ctx.setLineDash([]);
      const railY = py + 27;
      line(center - 2.4 * scale, railY, center + 2.4 * scale, railY, '#8d9e7d', 2);
      for (let i = -2; i <= 2; i++) { const tx = center + i * scale; line(tx, railY + 6, tx, railY + 12, '#aab5a0'); ctx.fillStyle = '#87917d'; ctx.fillText(`${i > 0 ? '+' : ''}${i}.0 m`, tx, railY + 30); }
      for (const end of [-1, 1]) { const ex = center + end * 2.4 * scale; line(ex, railY - 7, ex, railY + 7, '#b9a98d', 3); }
      // Faint trail is recorded physical motion, never a predicted model path.
      const endIndex = engine.replay ? engine.replayIndex : engine.frames.length - 1;
      const trail = engine.frames.slice(Math.max(0, endIndex - 100), endIndex + 1);
      ctx.beginPath(); trail.forEach((frame, i) => { let tx = center + frame.state[0] * scale, ty = py; p.lengths.forEach((l, j) => { tx += l * scale * Math.sin(frame.state[j + 1]); ty -= l * scale * Math.cos(frame.state[j + 1]); }); if (i === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty); }); ctx.strokeStyle = '#abc59977'; ctx.lineWidth = 1.5; ctx.stroke();
      // Upright target silhouette.
      ctx.setLineDash([4, 5]); line(x, py, x, py - p.lengths.reduce((a, b) => a + b) * scale, '#b2c99b', 2); ctx.setLineDash([]);
      circle(x, py - p.lengths.reduce((a, b) => a + b) * scale, 7, '#eff5e8', '#bdcdb1');
      ctx.fillStyle = '#9ba98e'; ctx.font = '9px monospace'; ctx.fillText('TARGET 0°', x, py - p.lengths.reduce((a, b) => a + b) * scale - 18);
      // Cart and massless links are the functional simulation diagram.
      ctx.fillStyle = '#315b42'; ctx.beginPath(); ctx.roundRect(x - 32, py - 2, 64, 22, 5); ctx.fill();
      line(x - 21, py + 5, x + 21, py + 5, '#5e7b60', 1);
      circle(x - 20, py + 23, 5, '#4f5c4d'); circle(x + 20, py + 23, 5, '#4f5c4d');
      ctx.font = '8px monospace'; ctx.fillStyle = '#dfe8d6'; ctx.fillText('M = 1.0 kg', x, py + 15);
      let px = x, ay = py;
      p.lengths.forEach((length, i) => {
        const ex = px + Math.sin(s[i + 1]) * length * scale, ey = ay - Math.cos(s[i + 1]) * length * scale;
        ctx.lineCap = 'round'; line(px, ay, ex, ey, i === 0 ? '#4e7050' : '#93a667', 7); ctx.lineCap = 'butt';
        circle(px, ay, 7, '#f9faf6', '#3f6245'); circle(px, ay, 2.3, '#3f6245');
        circle(ex, ey, i === p.lengths.length - 1 ? 11 : 9, i === 0 ? '#688b4f' : '#a7bb76', '#fff');
        ctx.font = '11px monospace'; ctx.fillStyle = '#486043'; ctx.textAlign = 'left'; ctx.fillText(`θ${i + 1} ${degrees(s[i + 1]).toFixed(1)}°`, ex + 19, ey + 4);
        px = ex; ay = ey;
      });
      const totalForce = engine.force + engine.disturbanceForce;
      if (Math.abs(totalForce) > .01) {
        const sign = Math.sign(totalForce), ax = x + sign * 44, end = ax + sign * Math.min(62, 14 + Math.abs(totalForce) * 3), yy = py + 8;
        line(ax, yy, end, yy, '#c68a44', 2); line(end, yy, end - sign * 6, yy - 4, '#c68a44', 2); line(end, yy, end - sign * 6, yy + 4, '#c68a44', 2);
        ctx.textAlign = 'center'; ctx.font = '10px monospace'; ctx.fillStyle = '#ad7a40'; ctx.fillText(`${totalForce.toFixed(1)} N`, (ax + end) / 2, yy - 13);
      }
      ctx.textAlign = 'left'; ctx.font = '10px monospace'; ctx.fillStyle = '#8c9782'; ctx.fillText('x →  /  θ : vertical up = 0°', 23, height - 21);
      ctx.textAlign = 'right'; ctx.fillText('g  9.81 m/s²', width - 23, height - 21);
      raf = requestAnimationFrame(draw);
    };
    draw(); return () => { observer.disconnect(); cancelAnimationFrame(raf); };
  }, [engine]);
  const release = () => { if (drag.current) { drag.current = null; engine.releaseCart(); } };
  return <canvas ref={canvasRef} className="pendulum-canvas interactive-cart" aria-label="실행 중 수레를 좌우로 드래그해 힘을 가할 수 있습니다. 아래 수레 밀기 버튼으로도 조작할 수 있습니다." role="img"
    onPointerDown={event => {
      if (event.button !== 0 || !engine.running || engine.replay) return;
      const rect = event.currentTarget.getBoundingClientRect(), scale = Math.min((rect.width - 90) / 6, 105);
      const px = event.clientX - rect.left, py = event.clientY - rect.top, cart = rect.width / 2 + engine.displayState()[0] * scale;
      if (Math.abs(px - cart) > 43 || Math.abs(py - rect.height * .53 - 10) > 29) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      const coordinate = (px - rect.width / 2) / scale;
      drag.current = { pointer: event.pointerId, offset: coordinate - engine.state[0] }; engine.dragCart(engine.state[0]);
    }}
    onPointerMove={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      const rect = event.currentTarget.getBoundingClientRect(), scale = Math.min((rect.width - 90) / 6, 105);
      engine.dragCart((event.clientX - rect.left - rect.width / 2) / scale - drag.current.offset);
    }} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} />;
}
