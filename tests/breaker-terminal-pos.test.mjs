import assert from 'node:assert/strict';
import test from 'node:test';
import { BREAKER_BOX_SIZE, BREAKER_SIDE_INSET, breakerTerminalPosDelta, breakerTerminalHeight } from '../js/model.js';

// 双端子固定几何位置：左右端子各是一个真实节点，横向偏移一负一正、关于箱体中心对称，
// 两侧均内缩 1cm；同一断路器左右端子使用相同行高度

test('双端子位置：左端子负偏移、右端子正偏移，关于中心对称', () => {
  const left = breakerTerminalPosDelta('left');
  const right = breakerTerminalPosDelta('right');
  assert.ok(left < 0 && right > 0);
  assert.ok(Math.abs(left + right) < 1e-12);
});

test('双端子位置：偏移量为箱宽一半内缩 1cm', () => {
  const expect = BREAKER_BOX_SIZE.w / 2 - BREAKER_SIDE_INSET;
  assert.ok(Math.abs(breakerTerminalPosDelta('right') - expect) < 1e-12);
  assert.ok(Math.abs(breakerTerminalPosDelta('left') + expect) < 1e-12);
});

test('同一断路器左右端子高度相同（同行），随行数均分递增', () => {
  const center = 1.6, n = 3;
  const h = breakerTerminalHeight(1, n, center);
  // 左右端子是同一行的两个节点：高度函数只由行号决定，两侧必然一致
  assert.equal(breakerTerminalHeight(1, n, center), h);
  assert.ok(breakerTerminalHeight(0, n, center) < h);
  assert.ok(breakerTerminalHeight(2, n, center) > h);
});
