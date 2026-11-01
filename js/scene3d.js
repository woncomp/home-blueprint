// 3D 场景：墙体、房间、电线、设备、强电箱渲染与拾取
import * as THREE from 'three';
import { FocusControls } from './controls.js';
import {
  wallLen, wallDir, wallNormal, nodeWorldPos, detectRooms,
  computeCircuits, DEVICE_TYPES, pointInRoom, findBreakerBox,
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
    this.hoverGroup = new THREE.Group();   // 悬停墙面预览
    this.scene.add(this.staticGroup, this.wireGroup, this.nodeGroup, this.labelGroup, this.hoverGroup);

    this.data = null;
    this.rooms = [];
    this.circuits = { circuits: [], wireCircuit: new Map(), nodeCircuit: new Map(), wallsWithCircuit: new Set() };
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
    this._hovered = [];
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
    const footprints = computeWallFootprints(this.data.walls);
    for (const wall of this.data.walls) {
      const h = wall.height || 2.8;
      const fp = footprints.get(wall.id);
      if (!fp || fp.length < 3) continue;
      const shape = new THREE.Shape();
      fp.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z)));
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.rotateX(Math.PI / 2); // Shape 在 XY 平面，转到 XZ；拉伸方向变为 -Y
      geo.translate(0, h, 0);   // 抬起为 y ∈ [0, h]
      const mat = new THREE.MeshLambertMaterial({ color: 0xb8bcc4, transparent: true, opacity: 0.88 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { kind: 'wall', id: wall.id };
      this.staticGroup.add(mesh);
      this._pickables.push(mesh);
    }
  }

  // 墙面单面预览：只画边缘矩形框
  makeFaceOutline(wall, face, color) {
    const len = wallLen(wall);
    const h = wall.height || 2.8;
    const t = wall.thickness || 0.2;
    const hw = (len + t) / 2, hh = h / 2;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hw, -hh, 0),
      new THREE.Vector3(hw, -hh, 0),
      new THREE.Vector3(hw, hh, 0),
      new THREE.Vector3(-hw, hh, 0),
    ]);
    const mat = new THREE.LineBasicMaterial({ color });
    const frame = new THREE.LineLoop(geo, mat);
    const [dx, dz] = wallDir(wall);
    const [nx, nz] = wallNormal(wall, face);
    frame.position.set(
      wall.start[0] + dx * len / 2 + nx * (t / 2 + 0.005),
      h / 2,
      wall.start[1] + dz * len / 2 + nz * (t / 2 + 0.005),
    );
    frame.rotation.y = Math.atan2(nx, nz);
    frame.userData.noPick = true;
    return frame;
  }

  // 悬停轻微高亮，提示对象可点击；墙面显示单面预览（点击展开 2D）
  setHover(hit) {
    const key = hit ? `${hit.kind}:${hit.id}:${hit.face ?? ''}` : null;
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    this.clearHover();
    if (!hit) return;
    if (hit.kind === 'wall') {
      const wall = this.wallsById().get(hit.id);
      if (wall) this.hoverGroup.add(this.makeFaceOutline(wall, hit.face, 0x8fc3ee));
      return;
    }
    for (const g of [this.nodeGroup, this.wireGroup, this.staticGroup]) {
      for (const mesh of g.children) {
        const ud = mesh.userData;
        if (!ud || ud.kind !== hit.kind || ud.id !== hit.id) continue;
        const mat = mesh.material;
        this._hovered.push({ mesh, color: mat.color.getHex(), emissive: mat.emissive ? mat.emissive.getHex() : null });
        if (mat.emissive) mat.emissive.setHex(0x2e3c50);
        else mat.color.multiplyScalar(1.8);
      }
    }
  }

  clearHover() {
    clearGroup(this.hoverGroup);
    for (const h of this._hovered || []) {
      h.mesh.material.color.setHex(h.color);
      if (h.emissive != null && h.mesh.material.emissive) h.mesh.material.emissive.setHex(h.emissive);
    }
    this._hovered = [];
  }

  // ---------- 强电箱（特殊设备，拾取身份就是设备节点） ----------
  buildBreakerBox() {
    const box = findBreakerBox(this.data);
    if (!box) return;
    const walls = this.wallsById();
    const wall = walls.get(box.wall);
    if (!wall) return;
    const geo = new THREE.BoxGeometry(0.5, 0.7, 0.14);
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(DEVICE_TYPES.breakerBox.color) });
    const mesh = new THREE.Mesh(geo, mat);
    const pos = nodeWorldPos({ wall: box.wall, face: box.face, pos: box.pos, height: box.height }, walls);
    mesh.position.set(pos[0], pos[1], pos[2]);
    const [nx, nz] = wallNormal(wall, box.face);
    mesh.rotation.y = -Math.atan2(nz, nx) + Math.PI / 2;
    const isSel = this.selected && this.selected.kind === 'node' && this.selected.id === box.id;
    if (isSel) mat.color.set(0xffee55);
    mesh.userData = { kind: 'node', id: box.id };
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
      if (node.deviceType === 'breakerBox') continue; // 强电箱由 buildBreakerBox 单独渲染
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

// ---------- 墙体俯视轮廓（拐角直角对接、T 型平齐） ----------

const JOIN_EPS = 0.01;                    // 端点吸附阈值（米）
const MITER_MIN_SIN = Math.sin(Math.PI / 9); // 两墙接近共线时视为直墙延续

function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }

function pointSegDist(p, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / l2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + abz * t));
}

function signedArea2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

// 端部回退 back 后的平切角点（u 指向墙外）
function trimCorners(cur, P, u, back) {
  const cx = P[0] - u[0] * back, cz = P[1] - u[1] * back;
  return [
    [cx + cur.nu[0] * cur.s, cz + cur.nu[1] * cur.s],
    [cx - cur.nu[0] * cur.s, cz - cur.nu[1] * cur.s],
  ];
}

// 计算某墙某端以「指向墙外方向 u」为基准的左/右角点
function endCorners(cur, P, u, sharers, throughs) {
  const leftBase = [P[0] + cur.nu[0] * cur.s, P[1] + cur.nu[1] * cur.s];
  const rightBase = [P[0] - cur.nu[0] * cur.s, P[1] - cur.nu[1] * cur.s];

  // 有共线的接续墙（直墙延续）→ 平切
  const straight = sharers.some(sh => Math.abs(cross2(u, sh.v)) < MITER_MIN_SIN && u[0] * sh.v[0] + u[1] * sh.v[1] < 0);
  if (straight) return [leftBase, rightBase];

  if (sharers.length === 1) {
    const { oth, v } = sharers[0];
    if (Math.abs(cross2(u, v)) < MITER_MIN_SIN) return [leftBase, rightBase]; // 折叠尖角，平切
    // 直角对接：id 较小的墙贯通（端部外延对方半厚，填满角部方块），
    // 另一面墙回退对方半厚，端面平齐顶到贯通墙侧面
    if (cur.w.id < oth.w.id) {
      return [
        [leftBase[0] + u[0] * oth.s, leftBase[1] + u[1] * oth.s],
        [rightBase[0] + u[0] * oth.s, rightBase[1] + u[1] * oth.s],
      ];
    }
    return trimCorners(cur, P, u, Math.min(oth.s, cur.len / 2));
  }

  if (sharers.length >= 2) {
    // T 型（贯通墙为两段）或多墙交汇：回退平切，顶到对方墙面
    const s2 = Math.max(...sharers.map(sh => sh.oth.s));
    return trimCorners(cur, P, u, Math.min(s2, cur.len / 2));
  }

  if (throughs.length) {
    // T 型头：端点落在另一墙内部，回退该墙半厚
    const s2 = Math.max(...throughs.map(o => o.s));
    return trimCorners(cur, P, u, Math.min(s2, cur.len / 2));
  }

  return [leftBase, rightBase]; // 自由端
}

// 返回 Map<wallId, [[x,z], ...]>：每面墙的俯视轮廓多边形（逆时针）
function computeWallFootprints(walls) {
  const info = walls.map(w => {
    const len = wallLen(w);
    const d = len > 1e-6 ? wallDir(w) : [1, 0];
    return { w, len, d, s: (w.thickness || 0.2) / 2 };
  });
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN_EPS;

  const result = new Map();
  for (const cur of info) {
    if (cur.len < 1e-6) continue;
    const ends = [];
    for (let e = 0; e < 2; e++) {
      const P = e === 0 ? cur.w.start : cur.w.end;
      const u = e === 0 ? [-cur.d[0], -cur.d[1]] : cur.d; // 指向墙外
      cur.nu = [u[1], -u[0]];                             // 以 u 为基准的左法线
      const sharers = [], throughs = [];
      for (const oth of info) {
        if (oth === cur || oth.len < 1e-6) continue;
        const atStart = near(P, oth.w.start), atEnd = near(P, oth.w.end);
        if (atStart || atEnd) {
          const v = atStart ? oth.d : [-oth.d[0], -oth.d[1]]; // 沿对方墙指向节点外
          sharers.push({ oth, v });
        } else if (pointSegDist(P, oth.w.start, oth.w.end) < JOIN_EPS) {
          throughs.push(oth);
        }
      }
      const [leftU, rightU] = endCorners(cur, P, u, sharers, throughs);
      // 统一换算成以 cur.d 为基准的左/右角：终点处一致，起点处左右互换
      ends.push(e === 1 ? [leftU, rightU] : [rightU, leftU]);
    }
    let pts = [ends[0][0], ends[1][0], ends[1][1], ends[0][1]];
    if (signedArea2(pts) < 0) pts = pts.reverse();
    result.set(cur.w.id, pts);
  }
  return result;
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
