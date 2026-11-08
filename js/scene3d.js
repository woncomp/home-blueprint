// 3D 场景：墙体、房间、电线、设备、强电箱渲染与拾取
import * as THREE from 'three';
import { FocusControls } from './controls.js';
import {
  wallLen, wallDir, wallNormal, nodeWorldPos, detectRooms,
  computeCircuits, DEVICE_TYPES, pointInRoom, findBreakerBox, BREAKER_BOX_SIZE, resolveRoomNames, roomLabelPoint,
  buildWallSegments, segmentsForWall, faceSegOf, wirePathPoints,
} from './model.js';
import { buildWallShell, locateWall, exposedFaceSpans } from './wallgeometry.js';

const ROOM_COLORS = ['#e8f0e3', '#e3ecf5', '#f5eee3', '#f0e3f5', '#e3f5f0', '#f5e3e8'];

// 拾取代理半径：设备/电线本体细小不易点中，用隐形放大网格提高鼠标容错
const PICK_RADIUS = { device: 0.13, point: 0.1, wire: 0.055, joint: 0.05 };

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
    this.wallSegments = new Map(); // 逻辑墙段（派生拆分），rebuild 时缓存
    this.circuits = { circuits: [], wireCircuit: new Map(), nodeCircuit: new Map(), wallsWithCircuit: new Set() };
    this.selected = null;        // { kind, id }
    this.highlightCircuit = null; // 线路索引或 null
    this.mode = 'view';
    this.roomLabelFloor = true; // 房间标签贴地平面；false 时用始终面向相机的悬浮 Sprite
    this._pickables = [];

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return; // 面板隐藏/尚未布局时跳过，避免相机宽高比变成 NaN
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode) {
    this.mode = mode;
    this.rebuild();
  }

  // 房间标签显示方式：true 贴地 / false 悬浮 billboard
  setRoomLabelMode(floor) {
    if (this.roomLabelFloor === floor) return;
    this.roomLabelFloor = floor;
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
    this._spanCache = null;

    const { rooms, segRooms } = detectRooms(this.data.walls);
    this.rooms = rooms;
    this.wallSegments = buildWallSegments(segRooms, this.data.walls);
    this.circuits = computeCircuits(this.data);

    this.buildRooms();
    this.buildWalls();
    this.buildDoors();
    this.buildBreakerBox();
    this.buildWires();
    this.buildNodes();
  }

  // ---------- 房间 ----------
  buildRooms() {
    const names = resolveRoomNames(this.data, this.rooms);
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

      // 名称标签位置（与户型编辑拖动共用 roomLabelPos 0~1 归一化坐标）
      const [lx, lz] = roomLabelPoint(room, this.data);
      const name = names.get(room.key);
      let label;
      if (this.roomLabelFloor) {
        label = makeFloorTextMesh(name, '#ffffff', 'rgba(40,45,55,0.4)', 256, 56, 0.5);
        label.position.set(lx, 0.02, lz);
      } else {
        label = makeTextSprite(name, '#ffffff', 'rgba(40,45,55,0.4)', 256, 56, 0.5);
        label.position.set(lx, 0.3, lz); // 略高于地面悬浮（标签高 0.5，底边约离地 5cm）
      }
      this.labelGroup.add(label);
    });
  }

  // ---------- 墙 ----------
  // 全屋墙面一体壳网格（拓扑干净：无重叠、无内部隐藏面、无贴地底面）；
  // 单一 mesh 不带 wall id，拾取经 locateWall 反解
  buildWalls() {
    const { positions, normals } = buildWallShell(this.data.walls, this.data.doors || []);
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    const mat = new THREE.MeshLambertMaterial({ color: 0xb8bcc4, transparent: true, opacity: 0.88 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { kind: 'wall' };
    this.staticGroup.add(mesh);
    this._pickables.push(mesh);
  }

  // ---------- 门（门框 + 半开门扇，不参与拾取） ----------
  buildDoors() {
    const walls = this.wallsById();
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x8a6f4d });
    const leafMat = new THREE.MeshLambertMaterial({ color: 0xc9a877 });
    for (const door of (this.data.doors || [])) {
      const wall = walls.get(door.wall);
      if (!wall) continue;
      const L = wallLen(wall);
      if (L < 1e-9) continue;
      const w = Math.min(door.width, L);
      const dh = Math.min(door.height || 2.0, wall.height || 2.8);
      const t = (wall.thickness || 0.2) + 0.04;
      const [dx, dz] = wallDir(wall);
      const at = u => [wall.start[0] + dx * u, wall.start[1] + dz * u];
      const yaw = -Math.atan2(dz, dx); // 局部 +x 沿墙方向时的 rotation.y

      // 门框：两侧门梃 + 顶部横梁
      for (const u of [door.pos - w / 2, door.pos + w / 2]) {
        const [px, pz] = at(u);
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.05, dh, t), frameMat);
        jamb.position.set(px, dh / 2, pz);
        jamb.rotation.y = yaw;
        jamb.userData.noPick = true;
        this.staticGroup.add(jamb);
      }
      const [cx, cz] = at(door.pos);
      const head = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, t), frameMat);
      head.position.set(cx, dh - 0.03, cz);
      head.rotation.y = yaw;
      head.userData.noPick = true;
      this.staticGroup.add(head);

      // 门扇：铰链在门洞起始侧，朝 face 侧开约 75°
      const [hx, hz] = at(door.pos - w / 2);
      const lw = Math.max(w - 0.06, 0.05), lh = Math.max(dh - 0.06, 0.1);
      const geo = new THREE.BoxGeometry(lw, lh, 0.035);
      geo.translate(lw / 2, 0, 0); // 铰链边移到原点
      const leaf = new THREE.Mesh(geo, leafMat);
      const nrm = wallNormal(wall, door.face || 0);
      const ang = 1.3; // 75°
      const tx = dx * Math.cos(ang) + nrm[0] * Math.sin(ang);
      const tz = dz * Math.cos(ang) + nrm[1] * Math.sin(ang);
      leaf.rotation.y = -Math.atan2(tz, tx);
      leaf.position.set(hx, lh / 2 + 0.02, hz);
      leaf.userData.noPick = true;
      this.staticGroup.add(leaf);
    }
  }

  // 墙面单面预览：只画边缘矩形框；seg 存在时只画该逻辑墙段范围。
  // 框宽按 exposedFaceSpans 裁剪到实际露出的墙面：T/L 接头处不再画进被邻墙压住的区段，
  // 自由端恰好止于墙端（不多悬空半墙厚）；露出区间在段边界处首尾相接，相邻段线框无缝。
  makeFaceOutline(wall, face, color, seg) {
    const len = wallLen(wall);
    const h = wall.height || 2.8;
    const t = wall.thickness || 0.2;
    const [dx, dz] = wallDir(wall);
    const [nx, nz] = wallNormal(wall, face);
    const group = new THREE.Group();

    const mkFrame = (u0, u1) => {
      const mid = (u0 + u1) / 2, hw = (u1 - u0) / 2, hh = h / 2;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, -hh, 0),
        new THREE.Vector3(hw, -hh, 0),
        new THREE.Vector3(hw, hh, 0),
        new THREE.Vector3(-hw, hh, 0),
      ]);
      const frame = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color }));
      frame.position.set(
        wall.start[0] + dx * mid + nx * (t / 2 + 0.005),
        h / 2,
        wall.start[1] + dz * mid + nz * (t / 2 + 0.005),
      );
      frame.rotation.y = Math.atan2(nx, nz);
      frame.userData.noPick = true;
      return frame;
    };

    const u0 = seg ? seg.t0 * len : 0, u1 = seg ? seg.t1 * len : len;
    let drew = false;
    for (const [a, b] of this._faceSpans(wall, face)) {
      const lo = Math.max(a, u0), hi = Math.min(b, u1);
      if (hi - lo < 0.01) continue;
      group.add(mkFrame(lo, hi));
      drew = true;
    }
    if (!drew) group.add(mkFrame(u0, u1)); // 防御：无露出数据时回退整段
    group.userData.noPick = true;
    return group;
  }

  // 悬停线框的露出区间缓存（key: wallId:face），rebuild 时随 _spanCache 清空
  _faceSpans(wall, face) {
    if (!this._spanCache) this._spanCache = new Map();
    const key = wall.id + ':' + face;
    if (!this._spanCache.has(key)) {
      this._spanCache.set(key, exposedFaceSpans(this.data.walls, wall, face));
    }
    return this._spanCache.get(key);
  }

  // 悬停轻微高亮，提示对象可点击；墙面显示单面预览（点击展开 2D）
  setHover(hit) {
    const key = hit ? `${hit.kind}:${hit.id}:${hit.face ?? ''}:${hit.seg ? hit.seg.id : ''}` : null;
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    this.clearHover();
    if (!hit) return;
    if (hit.kind === 'wall') {
      const wall = this.wallsById().get(hit.id);
      if (wall) this.hoverGroup.add(this.makeFaceOutline(wall, hit.face, 0x8fc3ee, hit.seg));
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
    const geo = new THREE.BoxGeometry(BREAKER_BOX_SIZE.w, BREAKER_BOX_SIZE.h, BREAKER_BOX_SIZE.d);
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
  buildWires() {
    for (const wire of this.data.wires) {
      const na = this.nodesById().get(wire.from);
      const nb = this.nodesById().get(wire.to);
      if (!na || !nb) continue;
      const isSel = this.selected && this.selected.kind === 'wire' && this.selected.id === wire.id;
      const cIdx = this.circuits.wireCircuit.get(wire.id);
      let color = cIdx != null ? new THREE.Color(this.circuits.circuits[cIdx].color) : new THREE.Color(0x777777);
      let opacity = 1;
      if (this.highlightCircuit != null && cIdx !== this.highlightCircuit) opacity = 0.12;
      if (isSel) color = new THREE.Color(0xffee55);

      // 同墙横平竖直；跨墙且几何相邻经公共墙面角点走线；否则回退旧路径
      const pts = wirePathPoints(this.wallsById(), na, nb);
      if (!pts || pts.length < 2) continue;
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
        const proxy = new THREE.Mesh(new THREE.SphereGeometry(PICK_RADIUS.joint, 8, 8));
        proxy.position.copy(joint.position);
        this.addPickProxy(proxy, { kind: 'wire', id: wire.id });
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
    // 隐形加粗代理，让细电线更容易被鼠标点中
    const proxy = new THREE.Mesh(new THREE.CylinderGeometry(PICK_RADIUS.wire, PICK_RADIUS.wire, len, 6));
    proxy.position.copy(mesh.position);
    proxy.quaternion.copy(mesh.quaternion);
    this.addPickProxy(proxy, { kind: 'wire', id: wireId });
  }

  // 隐形拾取代理：不加入渲染场景（无 GPU 资源），只进拾取列表
  addPickProxy(mesh, userData) {
    mesh.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    mesh.updateMatrixWorld(true); // 代理无父节点，需手动刷新矩阵
    mesh.userData = userData;
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
        const proxy = new THREE.Mesh(new THREE.SphereGeometry(PICK_RADIUS.device, 8, 8));
        proxy.position.set(pos[0], pos[1], pos[2]);
        this.addPickProxy(proxy, { kind: 'node', id: node.id });
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
        const proxy = new THREE.Mesh(new THREE.SphereGeometry(PICK_RADIUS.point, 8, 8));
        proxy.position.set(pos[0], pos[1], pos[2]);
        this.addPickProxy(proxy, { kind: 'node', id: node.id });
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
      if (ud.kind === 'wall') {
        // 墙壳是单一 mesh：由命中点反解所在墙与面（顶盖/门楣底面命中同样稳健）
        const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
        const loc = locateWall(this.data.walls, [hit.point.x, hit.point.y, hit.point.z], 0.05, n ? [n.x, n.y, n.z] : null);
        if (!loc) continue;
        result.id = loc.wall.id;
        result.face = loc.face;
        // 命中点投影到墙线得 0~1 坐标，按命中面取"面范围段"：T/X 拆分只作用于
        // 被接触的一面（该侧房间变化处拆分），未接触的一面整面一个范围
        const L = wallLen(loc.wall);
        if (L > 1e-9) {
          const [dx, dz] = wallDir(loc.wall);
          const t01 = ((hit.point.x - loc.wall.start[0]) * dx + (hit.point.z - loc.wall.start[1]) * dz) / L;
          result.seg = faceSegOf(segmentsForWall(this.wallSegments, loc.wall.id), loc.face, Math.min(1, Math.max(0, t01)));
        }
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
    if (c.children && c.children.length) clearGroup(c); // 嵌套 Group（如悬停线框组）先清理内部
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

// 平铺在地面的文字贴片：贴地、法线朝上，文字上方向指向 -Z（与平面图阅读方向一致）
export function makeFloorTextMesh(text, color = '#fff', bg = 'rgba(0,0,0,0.6)', w = 256, h = 56, scale = 0.9) {
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
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scale * w / h, scale), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
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
