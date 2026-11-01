// 3D 场景：墙体、房间、电线、设备、强电箱渲染与拾取
import * as THREE from 'three';
import { FocusControls } from './controls.js';
import {
  wallLen, wallDir, wallNormal, nodeWorldPos, detectRooms,
  computeCircuits, DEVICE_TYPES, pointInRoom,
} from './model.js';

const ROOM_COLORS = ['#e8f0e3', '#e3ecf5', '#f5eee3', '#f0e3f5', '#e3f5f0', '#f5e3e8'];

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e2126);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
    this.controls = new FocusControls(this.camera, canvas);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10, 20, 5);
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    this.grid = new THREE.GridHelper(40, 40, 0x444444, 0x2c2f36);
    this.grid.position.y = -0.001;
    this.scene.add(this.grid);

    this.staticGroup = new THREE.Group();  // 墙、房间地面、强电箱
    this.wireGroup = new THREE.Group();    // 电线
    this.nodeGroup = new THREE.Group();    // 设备/端点
    this.labelGroup = new THREE.Group();
    this.tempGroup = new THREE.Group();    // 编辑预览
    this.hoverGroup = new THREE.Group();   // 悬停墙面预览
    this.scene.add(this.staticGroup, this.wireGroup, this.nodeGroup, this.labelGroup, this.tempGroup, this.hoverGroup);

    this.data = null;
    this.rooms = [];
    this.circuits = { circuits: [], wireCircuit: new Map(), nodeCircuit: new Map() };
    this.selected = null;        // { kind, id }
    this.highlightCircuit = null; // 线路索引或 null
    this.mode = 'view';
    this._pickables = [];

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode) {
    this.mode = mode;
    this.rebuild();
  }

  setSelection(sel) {
    this.selected = sel;
    this.rebuild();
  }

  setHighlight(idx) {
    this.highlightCircuit = idx;
    this.rebuild();
  }

  setData(data) {
    this.data = data;
    this.rebuild();
    this.fitView();
  }

  // 编辑后刷新（不重置摄像机）
  updateData(data) {
    this.data = data;
    this.rebuild();
  }

  fitView() {
    if (!this.data || !this.data.walls.length) {
      this.controls.target.set(0, 0, 0);
      this.controls.distance = 10;
      this.controls.update();
      return;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const w of this.data.walls) {
      for (const [x, z] of [w.start, w.end]) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    this.controls.target.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    this.controls.distance = Math.max(maxX - minX, maxZ - minZ) * 1.5 + 3;
    this.controls.pitch = 0.9;
    this.controls.update();
  }

  wallsById() { return new Map(this.data.walls.map(w => [w.id, w])); }
  nodesById() { return new Map(this.data.nodes.map(n => [n.id, n])); }

  rebuild() {
    if (!this.data) return;
    clearGroup(this.staticGroup);
    clearGroup(this.wireGroup);
    clearGroup(this.nodeGroup);
    clearGroup(this.labelGroup);
    clearGroup(this.hoverGroup);
    this._hoverKey = null;
    this._pickables = [];

    this.rooms = detectRooms(this.data.walls);
    this.circuits = computeCircuits(this.data);

    this.buildRooms();
    this.buildWalls();
    this.buildBreakerBox();
    this.buildWires();
    this.buildNodes();
  }

  // ---------- 房间 ----------
  buildRooms() {
    const names = this.data.roomNames || {};
    const hints = [...(this.data.roomNameHints || [])];
    const sorted = [...this.rooms].sort((a, b) => b.area - a.area);
    // 提示名按面积降序分配
    for (const room of sorted) {
      if (!names[room.key] && hints.length) names[room.key] = hints.shift();
    }
    this.rooms.forEach((room, i) => {
      const shape = new THREE.Shape();
      room.points.forEach(([x, z], j) => (j === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z)));
      const geo = new THREE.ShapeGeometry(shape);
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(ROOM_COLORS[i % ROOM_COLORS.length]),
        transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = Math.PI / 2; // ShapeGeometry 在 XY 平面，转到 XZ
      mesh.position.y = 0.012;
      mesh.userData = { kind: 'room', id: room.key };
      this.staticGroup.add(mesh);
      this._pickables.push(mesh);

      // 中心点与标签
      let cx = 0, cz = 0;
      for (const [x, z] of room.points) { cx += x; cz += z; }
      cx /= room.points.length; cz /= room.points.length;
      const label = makeTextSprite(names[room.key] || `房间${i + 1}`, '#ffffff', 'rgba(40,45,55,0.4)', 256, 56, 0.5);
      label.position.set(cx, 1.6, cz);
      this.labelGroup.add(label);
    });
  }

  // ---------- 墙 ----------
  buildWalls() {
    for (const wall of this.data.walls) {
      const len = wallLen(wall);
      const h = wall.height || 2.8;
      const t = wall.thickness || 0.2;
      const geo = new THREE.BoxGeometry(len, h, t);
      const mat = new THREE.MeshLambertMaterial({ color: 0xb8bcc4, transparent: true, opacity: 0.88 });
      const mesh = new THREE.Mesh(geo, mat);
      const mx = (wall.start[0] + wall.end[0]) / 2;
      const mz = (wall.start[1] + wall.end[1]) / 2;
      mesh.position.set(mx, h / 2, mz);
      mesh.rotation.y = -Math.atan2(wall.end[1] - wall.start[1], wall.end[0] - wall.start[0]);
      const isSel = this.selected && this.selected.kind === 'wall' && this.selected.id === wall.id;
      // 编辑模式高亮整面墙（用于删除）；查看模式只高亮选中的那一面
      if (isSel && this.mode === 'edit') mat.color.set(0x6fa8dc);
      mesh.userData = { kind: 'wall', id: wall.id };
      this.staticGroup.add(mesh);
      this._pickables.push(mesh);
      if (isSel && this.mode !== 'edit' && this.selected.face != null) {
        this.staticGroup.add(this.makeFaceOverlay(wall, this.selected.face, 0x6fa8dc, 0.5));
      }
    }
  }

  // 墙面单面高亮薄片
  makeFaceOverlay(wall, face, color, opacity) {
    const len = wallLen(wall);
    const h = wall.height || 2.8;
    const t = wall.thickness || 0.2;
    const geo = new THREE.PlaneGeometry(len + t, h);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const [dx, dz] = wallDir(wall);
    const [nx, nz] = wallNormal(wall, face);
    mesh.position.set(
      wall.start[0] + dx * len / 2 + nx * (t / 2 + 0.005),
      h / 2,
      wall.start[1] + dz * len / 2 + nz * (t / 2 + 0.005),
    );
    mesh.rotation.y = Math.atan2(nx, nz);
    mesh.userData.noPick = true;
    return mesh;
  }

  // 悬停墙面轻微预览（仅查看模式）
  setFaceHover(hit) {
    const key = hit && hit.kind === 'wall' ? `${hit.id}:${hit.face}` : null;
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    clearGroup(this.hoverGroup);
    if (!hit) return;
    const wall = this.wallsById().get(hit.id);
    if (wall) this.hoverGroup.add(this.makeFaceOverlay(wall, hit.face, 0x8fc3ee, 0.22));
  }

  // ---------- 强电箱 ----------
  buildBreakerBox() {
    const box = this.data.breakerBox;
    if (!box) return;
    const walls = this.wallsById();
    const wall = walls.get(box.wall);
    if (!wall) return;
    const geo = new THREE.BoxGeometry(0.5, 0.7, 0.14);
    const mat = new THREE.MeshLambertMaterial({ color: 0x3a4048 });
    const mesh = new THREE.Mesh(geo, mat);
    const pos = nodeWorldPos({ wall: box.wall, face: box.face, pos: box.pos, height: box.height }, walls);
    mesh.position.set(pos[0], pos[1], pos[2]);
    const [nx, nz] = wallNormal(wall, box.face);
    mesh.rotation.y = -Math.atan2(nz, nx) + Math.PI / 2;
    const isSel = this.selected && this.selected.kind === 'breakerBox';
    if (isSel) mat.color.set(0x6fa8dc);
    mesh.userData = { kind: 'breakerBox', id: box.id };
    this.staticGroup.add(mesh);
    this._pickables.push(mesh);
  }

  // ---------- 电线 ----------
  wireEndpoints(wire) {
    const walls = this.wallsById();
    const nodes = this.nodesById();
    const a = nodes.get(wire.from), b = nodes.get(wire.to);
    if (!a || !b) return null;
    return [nodeWorldPos(a, walls), nodeWorldPos(b, walls)];
  }

  buildWires() {
    for (const wire of this.data.wires) {
      const ends = this.wireEndpoints(wire);
      if (!ends) continue;
      const [p1, p2] = ends;
      const isSel = this.selected && this.selected.kind === 'wire' && this.selected.id === wire.id;
      const cIdx = this.circuits.wireCircuit.get(wire.id);
      let color = cIdx != null ? new THREE.Color(this.circuits.circuits[cIdx].color) : new THREE.Color(0x777777);
      let opacity = 1;
      if (this.highlightCircuit != null && cIdx !== this.highlightCircuit) opacity = 0.12;
      if (isSel) color = new THREE.Color(0xffee55);

      // 横平竖直：水平走到平面中点 → 垂直折角 → 水平到达
      const pts = orthoPath(p1, p2);
      if (pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        this.addWireSegment(pts[i], pts[i + 1], color, opacity, wire.id);
      }
      for (let i = 1; i < pts.length - 1; i++) {
        const geo = new THREE.SphereGeometry(0.018, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
        const joint = new THREE.Mesh(geo, mat);
        joint.position.set(pts[i][0], pts[i][1], pts[i][2]);
        joint.userData = { kind: 'wire', id: wire.id };
        this.wireGroup.add(joint);
        this._pickables.push(joint);
      }
    }
  }

  addWireSegment(a, b, color, opacity, wireId) {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    if (len < 0.001) return;
    const geo = new THREE.CylinderGeometry(0.018, 0.018, len, 6);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    mesh.userData = { kind: 'wire', id: wireId };
    this.wireGroup.add(mesh);
    this._pickables.push(mesh);
  }

  // ---------- 节点（设备与端点） ----------
  buildNodes() {
    const walls = this.wallsById();
    for (const node of this.data.nodes) {
      if (node.type === 'terminal') continue; // 端子在强电箱内部
      const pos = nodeWorldPos(node, walls);
      if (!pos) continue;
      const isSel = this.selected && this.selected.kind === 'node' && this.selected.id === node.id;
      const cIdx = this.circuits.nodeCircuit.get(node.id);
      let opacity = 1;
      if (this.highlightCircuit != null && cIdx !== this.highlightCircuit) opacity = 0.15;

      if (node.type === 'device') {
        const dt = DEVICE_TYPES[node.deviceType] || DEVICE_TYPES.socket;
        const geo = new THREE.BoxGeometry(0.14, 0.14, 0.06);
        const mat = new THREE.MeshLambertMaterial({
          color: isSel ? 0xffee55 : new THREE.Color(dt.color), transparent: true, opacity,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos[0], pos[1], pos[2]);
        const wall = walls.get(node.wall);
        const [nx, nz] = wallNormal(wall, node.face);
        mesh.rotation.y = -Math.atan2(nz, nx) + Math.PI / 2;
        mesh.userData = { kind: 'node', id: node.id };
        this.nodeGroup.add(mesh);
        this._pickables.push(mesh);
        if (node.label) {
          // 说明文字用贴在墙面上的薄贴牌表示，不用悬浮文字
          const pgeo = new THREE.BoxGeometry(0.14, 0.09, 0.012);
          const pmat = new THREE.MeshLambertMaterial({ color: 0xf2f4f6, transparent: true, opacity: 0.92 * opacity });
          const plate = new THREE.Mesh(pgeo, pmat);
          plate.position.set(pos[0] + nx * 0.012, pos[1] + 0.13, pos[2] + nz * 0.012);
          plate.rotation.y = Math.atan2(nx, nz);
          plate.userData.noPick = true;
          this.labelGroup.add(plate);
        }
      } else {
        // 转弯/分线端点：小圆点
        const color = cIdx != null ? new THREE.Color(this.circuits.circuits[cIdx].color) : new THREE.Color(0x999999);
        const geo = new THREE.SphereGeometry(0.045, 10, 10);
        const mat = new THREE.MeshBasicMaterial({ color: isSel ? 0xffee55 : color, transparent: true, opacity });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos[0], pos[1], pos[2]);
        mesh.userData = { kind: 'node', id: node.id };
        this.nodeGroup.add(mesh);
        this._pickables.push(mesh);
      }
    }
  }

  // ---------- 拾取 ----------
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.params.Line.threshold = 0.1;
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this._pickables, false);
    for (const hit of hits) {
      const ud = hit.object.userData;
      if (!ud || !ud.kind) continue;
      const result = { kind: ud.kind, id: ud.id };
      if (ud.kind === 'wall' && hit.face) {
        const wall = this.wallsById().get(ud.id);
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const [nx, nz] = wallNormal(wall, 0);
        result.face = (n.x * nx + n.z * nz) > 0 ? 0 : 1;
      }
      if (ud.kind === 'room') {
        // 房间只用于点选命名，优先级放低：若后面还有更近的非房间命中则取后者
        const later = hits.find(h => h.object.userData.kind !== 'room');
        if (later) continue;
      }
      return result;
    }
    return null;
  }

  groundPoint(clientX, clientY, out) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this.controls.groundPoint(ndc, out);
  }

  render(dt) {
    this.controls.tick(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (c.material.map) c.material.map.dispose();
      c.material.dispose();
    }
    g.remove(c);
  }
}

export function makeTextSprite(text, color = '#fff', bg = 'rgba(0,0,0,0.6)', w = 256, h = 56, scale = 0.9) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  roundRect(ctx, 2, 2, w - 4, h - 4, 10);
  ctx.fill();
  ctx.font = `${Math.floor(h * 0.5)}px "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale * w / h, scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

// 两节点间横平竖直的走线路径：水平到平面中点 → 垂直折角 → 水平到达
function orthoPath(p1, p2) {
  const mx = (p1[0] + p2[0]) / 2, mz = (p1[2] + p2[2]) / 2;
  const raw = [
    [p1[0], p1[1], p1[2]],
    [mx, p1[1], mz],
    [mx, p2[1], mz],
    [p2[0], p2[1], p2[2]],
  ];
  const pts = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 0.01) pts.push(p);
  }
  return pts;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
