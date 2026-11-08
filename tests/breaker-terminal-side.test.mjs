import assert from 'node:assert/strict';
import test from 'node:test';
import { BREAKER_BOX_SIZE, BREAKER_SIDE_INSET, breakerTerminalPosDelta } from '../js/model.js';

test('左出线为负偏移、右出线为正偏移，关于中心对称', () => {
  const left = breakerTerminalPosDelta('left');
  const right = breakerTerminalPosDelta('right');
  assert.ok(left < 0 && right > 0);
  assert.ok(Math.abs(left + right) < 1e-12);
});

test('偏移量为箱宽一半内缩 3cm', () => {
  const expect = BREAKER_BOX_SIZE.w / 2 - BREAKER_SIDE_INSET;
  assert.ok(Math.abs(breakerTerminalPosDelta('right') - expect) < 1e-12);
  assert.ok(Math.abs(breakerTerminalPosDelta('left') + expect) < 1e-12);
});

test('side 缺省视为左侧', () => {
  assert.equal(breakerTerminalPosDelta(undefined), breakerTerminalPosDelta('left'));
  assert.equal(breakerTerminalPosDelta(null), breakerTerminalPosDelta('left'));
});
