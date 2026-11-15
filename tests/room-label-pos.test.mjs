import assert from 'node:assert/strict';
import test from 'node:test';
import { roomLabelPoint, roomLabelUV, roomBBox } from '../js/model.js';

// 2m × 4m 矩形房间：bbox [10,12]×[20,24]，质心即包围盒中心 (11, 22)
const room = {
  key: 'k1',
  points: [[10, 20], [12, 20], [12, 24], [10, 24]],
};
const rectData = {};

test('无记录时名称位置取多边形质心', () => {
  assert.deepEqual(roomLabelPoint(room, rectData), [11, 22]);
});

test('roomBBox 返回包围盒与宽高', () => {
  assert.deepEqual(roomBBox(room), { minX: 10, minZ: 20, w: 2, d: 4 });
});

test('offsetx/offsety 为相对质心的包围盒比例偏移（角点与中心）', () => {
  // 质心恰为包围盒中心：偏移 ±0.5 即到达包围盒角点
  const data = { rooms: { k1: { offsetx: -0.5, offsety: -0.5 } } };
  assert.deepEqual(roomLabelPoint(room, data), [10, 20]);
  data.rooms.k1 = { offsetx: 0.5, offsety: 0.5 };
  assert.deepEqual(roomLabelPoint(room, data), [12, 24]);
  data.rooms.k1 = { offsetx: -0.25, offsety: 0.25 };
  assert.deepEqual(roomLabelPoint(room, data), [10.5, 23]);
});

test('rooms 记录只有 name 时标签仍在质心（名称与偏移互不干扰）', () => {
  const data = { rooms: { k1: { name: '客厅' } } };
  assert.deepEqual(roomLabelPoint(room, data), [11, 22]);
});

test('roomLabelUV 与 roomLabelPoint 互逆；质心对矩形房间为 0.5/0.5', () => {
  const data = { rooms: { k1: { offsetx: -0.2, offsety: 0.1 } } };
  const uv = roomLabelUV(room, data);
  assert.ok(Math.abs(uv[0] - 0.3) < 1e-12 && Math.abs(uv[1] - 0.6) < 1e-12);
  const d2 = {};
  const uv2 = roomLabelUV(room, d2);
  assert.ok(Math.abs(uv2[0] - 0.5) < 1e-12 && Math.abs(uv2[1] - 0.5) < 1e-12);
});

test('非矩形房间：无记录取质心（非包围盒中心）', () => {
  // 直角三角形：(0,0)-(4,0)-(0,2)，质心 (4/3, 2/3)，包围盒中心 (2, 1)
  const tri = { key: 'k2', points: [[0, 0], [4, 0], [0, 2]] };
  const [x, z] = roomLabelPoint(tri, {});
  assert.ok(Math.abs(x - 4 / 3) < 1e-12 && Math.abs(z - 2 / 3) < 1e-12);
  // 偏移为 0 时归一化坐标即质心 UV（相对包围盒，非 0.5/0.5）
  const uv = roomLabelUV(tri, { rooms: { k2: {} } });
  assert.ok(Math.abs(uv[0] - 1 / 3) < 1e-12 && Math.abs(uv[1] - 1 / 3) < 1e-12);
  // 有偏移时 UV = 质心 UV + 偏移
  const uv2 = roomLabelUV(tri, { rooms: { k2: { offsetx: 0.1, offsety: -0.2 } } });
  assert.ok(Math.abs(uv2[0] - (1 / 3 + 0.1)) < 1e-12 && Math.abs(uv2[1] - (1 / 3 - 0.2)) < 1e-12);
});
