import assert from 'node:assert/strict';
import test from 'node:test';
import { clipDoorToSeg } from '../js/model.js';

const L = 4; // 墙长 4m

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('整墙（段参数为 null）门洞完整保留', () => {
  const r = clipDoorToSeg({ pos: 2.4, width: 0.9 }, null, null, L);
  assert.deepEqual(r, [2.4 - 0.45, 2.4 + 0.45]);
});

test('段内门完整保留', () => {
  // 段 [0, 3m]，门 [1.95, 2.85] 完全在段内
  const r = clipDoorToSeg({ pos: 2.4, width: 0.9 }, 0, 0.75, L);
  assertClose(r[0], 1.95);
  assertClose(r[1], 2.85);
});

test('跨段边界的门裁剪到段内', () => {
  // 段 [0, 2m]，门 [1.95, 2.85] → 裁剪为 [1.95, 2]
  const r = clipDoorToSeg({ pos: 2.4, width: 0.9 }, 0, 0.5, L);
  assertClose(r[0], 1.95);
  assertClose(r[1], 2.0);
});

test('段外门返回 null', () => {
  assert.equal(clipDoorToSeg({ pos: 3.9, width: 0.9 }, 0, 0.5, L), null);
  assert.equal(clipDoorToSeg({ pos: 0.4, width: 0.9 }, 0.5, 1, L), null);
});

test('仅边界相切返回 null（零宽度无意义）', () => {
  // 门 [1.5, 2.4]，段从 2.4m 起
  assert.equal(clipDoorToSeg({ pos: 1.95, width: 0.9 }, 0.6, 1, L), null);
});
