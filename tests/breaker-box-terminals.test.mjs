import assert from 'node:assert/strict';
import test from 'node:test';
import { BREAKER_BOX_SIZE, breakerTerminalHeight } from '../js/model.js';

const H = BREAKER_BOX_SIZE.h;
const CENTER = 1.6;
const BOTTOM = CENTER - H / 2;

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('单条线路端子落在箱体中心', () => {
  assertClose(breakerTerminalHeight(0, 1, CENTER), CENTER);
});

test('两条线路关于箱体中心对称，间距为 h/3', () => {
  const h0 = breakerTerminalHeight(0, 2, CENTER);
  const h1 = breakerTerminalHeight(1, 2, CENTER);
  assertClose(h0, CENTER - H / 6);
  assertClose(h1, CENTER + H / 6);
  assertClose(h1 - h0, H / 3);
});

test('多条线路两端各预留 0.5 权重，端子严格递增', () => {
  const n = 5;
  const unit = H / (n + 1);
  const heights = Array.from({ length: n }, (_, i) => breakerTerminalHeight(i, n, CENTER));
  // 首末端子距箱边 1 权重（0.5 权重预留 + 0.5 权重半槽位）
  assertClose(heights[0] - BOTTOM, unit);
  assertClose(BOTTOM + H - heights[n - 1], unit);
  // 第一条线路的槽位起点距箱底边恰为 0.5 权重
  assertClose((heights[0] - unit / 2) - BOTTOM, unit / 2);
  for (let i = 1; i < n; i++) assert.ok(heights[i] > heights[i - 1]);
});
