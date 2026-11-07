// 聚焦视点摄像机控制：WASD 平移视点、左键拖动旋转、中键拖动平移（松手带动能）、滚轮缩放
import * as THREE from 'three';

const PAN_SAMPLE_MS = 100; // 动能取样窗口：按最近 100ms 的拖动估算释放速度

export class FocusControls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3(4, 0, 3); // 聚焦视点（地面点）
    this.yaw = -Math.PI / 4;   // 方位角
    this.pitch = 0.9;          // 俯仰角（从地面算起）
    this.distance = 12;
    this.minDistance = 1;
    this.maxDistance = 60;
    this.keys = new Set();
    this.dragging = false;
    this.enabled = true;
    this.panning = false;                    // 中键拖拽平移中
    this.panAnchor = null;                   // 拖拽"抓住"的地面点
    this.panVelocity = new THREE.Vector3();  // 松手动能（XZ 平面，世界单位/秒）
    this.panSamples = [];                    // 取样窗口内的拖动采样 {t, x, z}

    dom.addEventListener('mousedown', e => {
      if (e.button === 0 && this.enabled && !e.shiftKey) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      } else if (e.button === 1 && this.enabled) {
        e.preventDefault(); // 阻止浏览器中键自动滚动
        this.panning = true;
        this.panVelocity.set(0, 0, 0);
        this.panSamples = [];
        this.panAnchor = this._cursorGroundPoint(e.clientX, e.clientY);
      }
    });
    window.addEventListener('mousemove', e => {
      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.yaw -= dx * 0.005;
        this.pitch = Math.min(1.55, Math.max(0.05, this.pitch + dy * 0.005));
        this.update();
      } else if (this.panning) {
        this._panMove(e.clientX, e.clientY);
      }
    });
    window.addEventListener('mouseup', e => {
      if (e.button === 1 && this.panning) {
        this.panning = false;
        this.panAnchor = null;
        this._releaseMomentum();
      }
      if (e.button === 0) this.dragging = false;
    });
    dom.addEventListener('wheel', e => {
      if (!this.enabled) return;
      e.preventDefault();
      this.distance *= Math.pow(1.0015, e.deltaY);
      this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance));
      this.update();
    }, { passive: false });

    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    this.update();
  }

  // 每帧调用：根据按键平移视点，并推进松手后的平移动能
  tick(dt) {
    if (!this.enabled) {
      this.panVelocity.set(0, 0, 0);
      return;
    }
    let moved = false;
    if (this.keys.size > 0) {
      const speed = this.distance * 0.7 * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      if (this.keys.has('KeyW')) { this.target.addScaledVector(fwd, speed); moved = true; }
      if (this.keys.has('KeyS')) { this.target.addScaledVector(fwd, -speed); moved = true; }
      if (this.keys.has('KeyA')) { this.target.addScaledVector(right, -speed); moved = true; }
      if (this.keys.has('KeyD')) { this.target.addScaledVector(right, speed); moved = true; }
    }
    if (!this.panning && this.panVelocity.lengthSq() > 0) {
      this.target.addScaledVector(this.panVelocity, dt);
      this.panVelocity.multiplyScalar(Math.exp(-3.0 * dt)); // 指数阻尼，约 1 秒停
      if (this.panVelocity.length() < this.distance * 0.01) this.panVelocity.set(0, 0, 0);
      moved = true;
    }
    if (moved) this.update();
  }

  update() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cx = this.target.x + this.distance * cp * Math.sin(this.yaw);
    const cy = this.target.y + this.distance * sp;
    const cz = this.target.z + this.distance * cp * Math.cos(this.yaw);
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(this.target.x, this.target.y + 1.0, this.target.z);
    this.camera.updateMatrixWorld(); // 同帧内连续平移时，保证 groundPoint 求交用最新矩阵
  }

  // 屏幕射线与地平面(y=0)求交
  groundPoint(ndc, out) {
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize();
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = -origin.y / dir.y;
    if (t < 0) return null;
    out.set(origin.x + dir.x * t, 0, origin.z + dir.z * t);
    return out;
  }

  // 光标处的地面点；视线近乎水平或朝上时返回 null
  _cursorGroundPoint(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this.groundPoint(ndc, new THREE.Vector3());
  }

  // 中键拖拽：抓住地面点 1:1 跟手平移（与 WASD 同一 XZ 平面）
  _panMove(clientX, clientY) {
    const gp = this._cursorGroundPoint(clientX, clientY);
    if (gp && this.panAnchor) {
      this.target.add(this.panAnchor).sub(gp);
      this.update();
    } else {
      this.panAnchor = gp; // 地面点失效期间不平移，恢复时重新抓取，避免跳变
    }
    const now = performance.now();
    this.panSamples.push({ t: now, x: this.target.x, z: this.target.z });
    while (this.panSamples.length > 1 && now - this.panSamples[0].t > PAN_SAMPLE_MS) this.panSamples.shift();
  }

  // 松开中键：按取样窗口首尾位移估算释放速度，作为动能
  _releaseMomentum() {
    this.panVelocity.set(0, 0, 0);
    const s = this.panSamples;
    const now = performance.now();
    while (s.length > 1 && now - s[0].t > PAN_SAMPLE_MS) s.shift();
    if (s.length < 2 || now - s[s.length - 1].t > PAN_SAMPLE_MS) return; // 停顿后松手：不滑
    const dt = (s[s.length - 1].t - s[0].t) / 1000;
    if (dt < 0.01) return;
    this.panVelocity.set((s[s.length - 1].x - s[0].x) / dt, 0, (s[s.length - 1].z - s[0].z) / dt);
    const maxSpeed = this.distance * 2.5;
    if (this.panVelocity.length() > maxSpeed) this.panVelocity.setLength(maxSpeed);
    if (this.panVelocity.length() < this.distance * 0.02) this.panVelocity.set(0, 0, 0);
  }

  // 中断平移并清除动能（切到户型编辑模式等场景时调用）
  cancelPan() {
    this.panning = false;
    this.panAnchor = null;
    this.panVelocity.set(0, 0, 0);
    this.panSamples = [];
  }
}
