import assert from 'node:assert/strict';
import test from 'node:test';
import { exposedFaceSpans } from '../js/wallgeometry.js';

// ---------- 构造工具 ----------

function wall(id, x1, z1, x2, z2, opts = {}) {
  return {
    id,
    start: [x1, z1],
    end: [x2, z2],
    height: opts.height ?? 2.8,
    thickness: opts.thickness ?? 0.2,
  };
}

// 区间数组比较：数量一致且每个端点接近（默认 1mm 容差）
function assertSpans(actual, expected, eps = 1e-3) {
  assert.equal(actual.length, expected.length, `span 数量不符：got ${JSON.stringify(actual)}`);
  actual.forEach((sp, i) => {
    assert.ok(
      Math.abs(sp[0] - expected[i][0]) < eps && Math.abs(sp[1] - expected[i][1]) < eps,
      `span[${i}]：got [${sp}], want [${expected[i]}]`,
    );
  });
}

// ---------- 用例 ----------

test('独立墙：整面露出，两端不外延', () => {
  const w = wall('w1', 0, 0, 3, 0);
  assertSpans(exposedFaceSpans([w], w, 0), [[0, 3]]);
  assertSpans(exposedFaceSpans([w], w, 1), [[0, 3]]);
});

test('L 拐角：朝外的一面延伸到拐角方块，贴着邻墙的一面止于墙身', () => {
  // w1 沿 x 从 (0,0) 到 (3,0)，w2 从拐角 (3,0) 向 +z 到 (3,2)，厚 0.2
  const w1 = wall('w1', 0, 0, 3, 0);
  const w2 = wall('w2', 3, 0, 3, 2);
  // w1 A 面（z<0 侧，朝外）：拐角方块外露 → 延伸到 x = 3 + 0.1
  assertSpans(exposedFaceSpans([w1, w2], w1, 0), [[0, 3.1]]);
  // w1 B 面（z>0 侧，贴着 w2 墙身）：止于 w2 墙面 x = 3 - 0.1
  assertSpans(exposedFaceSpans([w1, w2], w1, 1), [[0, 2.9]]);
  // w2 A 面（x>3 侧，朝外）：起点外延拐角方块 → u 从 -0.1 起
  assertSpans(exposedFaceSpans([w1, w2], w2, 0), [[-0.1, 2]]);
  // w2 B 面（x<3 侧，贴着 w1 墙身）：止于 w1 墙面 z = 0 + 0.1
  assertSpans(exposedFaceSpans([w1, w2], w2, 1), [[0.1, 2]]);
});

test('T 型穿透交叉：宿主墙两面各被 stem 切成两段，留出 stem 宽度缝隙', () => {
  const host = wall('host', 0, 0, 4, 0);
  const stem = wall('stem', 2, -1, 2, 1);
  // stem 厚 0.2，宿主墙面在 x∈[1.9,2.1] 被压住
  assertSpans(exposedFaceSpans([host, stem], host, 0), [[0, 1.9], [2.1, 4]]);
  assertSpans(exposedFaceSpans([host, stem], host, 1), [[0, 1.9], [2.1, 4]]);
  // stem 两面在宿主厚度范围内（z∈[-0.1,0.1]）同样被压住
  assertSpans(exposedFaceSpans([host, stem], stem, 0), [[0, 0.9], [1.1, 2]]);
  assertSpans(exposedFaceSpans([host, stem], stem, 1), [[0, 0.9], [1.1, 2]]);
});

test('T 型不穿透：墙端顶到宿主墙，端头止于宿主墙面', () => {
  const host = wall('host', 0, 0, 4, 0);
  const stem = wall('stem', 2, -1, 2, 0); // 端点 (2,0) 落在宿主中心线上，端头外延 s 与宿主并集
  // stem 两面止于宿主近侧面 z = -0.1（u 从 (2,-1) 起算 = 0.9）
  assertSpans(exposedFaceSpans([host, stem], stem, 0), [[0, 0.9]]);
  assertSpans(exposedFaceSpans([host, stem], stem, 1), [[0, 0.9]]);
  // 宿主 A 面（stem 所在侧）在接头处被 stem 压住成两段；B 面侧 stem 端头与墙面齐平，不露缝
  assertSpans(exposedFaceSpans([host, stem], host, 0), [[0, 1.9], [2.1, 4]]);
  assertSpans(exposedFaceSpans([host, stem], host, 1), [[0, 4]]);
});

test('相邻墙更矮：墙高台阶处上段仍计入露出区间', () => {
  const w1 = wall('w1', 0, 0, 3, 0, { height: 2.8 });
  const w2 = wall('w2', 3, 0, 3, 2, { height: 2.0 });
  // w1 B 面在拐角区（x∈[2.9,3.1]）邻侧只有 2.0m 高 → 2.0m 以上的上段露出，区间延伸到 3.1
  assertSpans(exposedFaceSpans([w1, w2], w1, 1), [[0, 3.1]]);
  // w1 A 面（朝外）不受影响
  assertSpans(exposedFaceSpans([w1, w2], w1, 0), [[0, 3.1]]);
});

test('斜交墙：端部按投影裁剪，不外延', () => {
  // 45° 斜墙端点落在水平墙中心线上
  const h = wall('h', 0, 0, 4, 0);
  const d = wall('d', 2, -1, 3, 0); // 端点 (3,0) 在 h 中心线上
  const spans = exposedFaceSpans([h, d], d, 0);
  assert.equal(spans.length, 1);
  // 斜墙长 √2，A 面边线止于宿主远侧面 z=-0.1：u = (1 - 0.1 + s/√2) / (1/√2)，s = 0.1
  const len = Math.SQRT2;
  const uEnd = (1 - 0.1 + 0.1 / Math.SQRT2) * Math.SQRT2; // = (1 - 0.1 + s/√2) / (1/√2)
  assert.ok(Math.abs(spans[0][0]) < 1e-6, `斜墙露出应起于 u=0，got ${spans[0][0]}`);
  assert.ok(Math.abs(spans[0][1] - uEnd) < 1e-3 && uEnd < len,
    `斜墙露出应止于对方墙面投影，got ${spans[0][1]}，want ${uEnd}`);
});
