import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeWorldPos, wallDir, wallLen, wallNormal } from '../js/model.js';
import { WallFaceDialog } from '../js/wallface.js';

const walls = [
  { id: 'east', start: [2, 3], end: [8, 3], thickness: 0.2 },
  { id: 'west', start: [8, 3], end: [2, 3], thickness: 0.3 },
  { id: 'south', start: [2, 3], end: [2, 9], thickness: 0.4 },
  { id: 'north', start: [2, 9], end: [2, 3], thickness: 0.2 },
  { id: 'diagonal', start: [-2, 1], end: [4, 9], thickness: 0.25 },
];

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

for (const wall of walls) {
  for (const face of [0, 1]) {
    test(`${wall.id}: face ${face} positions nodes on its outward normal`, () => {
      const pos = wallLen(wall) * 0.4;
      const node = { wall: wall.id, face, pos, height: 1.25 };
      const [x, y, z] = nodeWorldPos(node, new Map([[wall.id, wall]]));
      const [dx, dz] = wallDir(wall);
      const [nx, nz] = wallNormal(wall, face);
      const offsetX = x - (wall.start[0] + dx * pos);
      const offsetZ = z - (wall.start[1] + dz * pos);

      assertClose(offsetX * nx + offsetZ * nz, wall.thickness / 2);
      assertClose(offsetX * dx + offsetZ * dz, 0);
      assert.equal(y, node.height);
    });
  }

  test(`${wall.id}: corresponding A/B nodes are one wall thickness apart`, () => {
    const byId = new Map([[wall.id, wall]]);
    const node = { wall: wall.id, pos: 1, height: 0.3 };
    const a = nodeWorldPos({ ...node, face: 0 }, byId);
    const b = nodeWorldPos({ ...node, face: 1 }, byId);

    assertClose(Math.hypot(a[0] - b[0], a[2] - b[2]), wall.thickness);
    assert.equal(a[1], b[1]);
  });
}

test('missing wall thickness uses the same 0.2m default as the 3D wall', () => {
  const wall = { id: 'default', start: [0, 0], end: [4, 0] };
  const byId = new Map([[wall.id, wall]]);
  const node = { wall: wall.id, pos: 2, height: 1 };

  assert.deepEqual(nodeWorldPos({ ...node, face: 0 }, byId), [2, 1, -0.1]);
  assert.deepEqual(nodeWorldPos({ ...node, face: 1 }, byId), [2, 1, 0.1]);
});

test('a node with a missing wall has no world position', () => {
  assert.equal(nodeWorldPos({ wall: 'missing', face: 1, pos: 1, height: 1 }, new Map()), null);
});

for (const mode of ['view', 'edit']) {
  for (const face of [0, 1]) {
    test(`${mode}: opening face ${face} shows only its nodes and clears previous selections`, () => {
      const data = {
        nodes: [
          { id: 'a', wall: 'wall', face: 0 },
          { id: 'b', wall: 'wall', face: 1 },
          { id: 'other', wall: 'other-wall', face },
        ],
      };
      let renderedNodes;
      const dialog = Object.assign(Object.create(WallFaceDialog.prototype), {
        dialog: { classList: { remove() {} } },
        selectedNodeId: 'previous-node',
        selectedWireId: 'previous-wire',
        dragging: { nodeId: 'previous-node' },
        setTool(tool) { this.tool = tool; },
        render() { renderedNodes = this.nodesOnFace(); },
      });

      dialog.open(data, 'wall', face, mode);

      assert.equal(dialog.wallId, 'wall');
      assert.equal(dialog.face, face);
      assert.equal(dialog.mode, mode);
      assert.equal(dialog.tool, 'select');
      assert.deepEqual(renderedNodes, [data.nodes[face]]);
      assert.equal(dialog.selectedNodeId, null);
      assert.equal(dialog.selectedWireId, null);
      assert.equal(dialog.dragging, null);
    });
  }
}
