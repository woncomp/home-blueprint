// 聚焦视点摄像机控制：WASD 平移视点、左键拖动旋转、滚轮缩放
import * as THREE from 'three';

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

    dom.addEventListener('mousedown', e => {
      if (e.button === 0 && this.enabled && !e.shiftKey) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
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
      }
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });
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

  // 每帧调用：根据按键平移视点
  tick(dt) {
    if (!this.enabled || this.keys.size === 0) return;
    const speed = this.distance * 0.7 * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let moved = false;
    if (this.keys.has('KeyW')) { this.target.addScaledVector(fwd, speed); moved = true; }
    if (this.keys.has('KeyS')) { this.target.addScaledVector(fwd, -speed); moved = true; }
    if (this.keys.has('KeyA')) { this.target.addScaledVector(right, -speed); moved = true; }
    if (this.keys.has('KeyD')) { this.target.addScaledVector(right, speed); moved = true; }
    if (moved) this.update();
  }

  update() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cx = this.target.x + this.distance * cp * Math.sin(this.yaw);
    const cy = this.target.y + this.distance * sp;
    const cz = this.target.z + this.distance * cp * Math.cos(this.yaw);
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(this.target.x, this.target.y + 1.0, this.target.z);
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
}
