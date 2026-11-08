// 右侧信息栏：强电箱 2D 布局 + 选中实体信息/属性编辑
import { DEVICE_TYPES, NODE_TYPE_NAMES, wallLen, findBreakerBox } from './model.js';

export class Panel {
  constructor(dataProvider) {
    // dataProvider: () => data；编辑通过回调
    this.dataProvider = dataProvider;
    this.cbs = {};
    this.highlightedBreaker = null;
    this.mode = 'view';
    this.breakerListEl = document.getElementById('breaker-list');
    this.entityInfoEl = document.getElementById('entity-info');
  }

  on(event, cb) { this.cbs[event] = cb; }
  emit(event, arg) { if (this.cbs[event]) this.cbs[event](arg); }

  update(data, circuits, selection, mode, rooms) {
    this.mode = mode || 'view';
    this.rooms = rooms || [];
    this.renderBreakerBox(data, circuits);
    this.renderEntity(data, circuits, selection);
  }

  // ---------- 强电箱 2D 布局 ----------
  renderBreakerBox(data, circuits) {
    const box = findBreakerBox(data);
    this.breakerListEl.innerHTML = '';
    if (!box) {
      this.breakerListEl.innerHTML = '<p class="placeholder">尚未放置强电箱</p>';
      return;
    }
    // 2D 箱体示意
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 70');
    svg.style.cssText = 'width:100%;background:#3a4048;border-radius:6px;margin-bottom:8px;';
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', 4); rect.setAttribute('y', 4);
    rect.setAttribute('width', 192); rect.setAttribute('height', 62);
    rect.setAttribute('rx', 5);
    rect.setAttribute('fill', '#2c313a');
    rect.setAttribute('stroke', '#5a6472');
    svg.appendChild(rect);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', 14); text.setAttribute('y', 40);
    text.setAttribute('fill', '#9fb4d0');
    text.setAttribute('font-size', '13');
    text.textContent = '⚡ 强电箱';
    svg.appendChild(text);
    this.breakerListEl.appendChild(svg);

    box.breakers.forEach((br, i) => {
      const circuit = circuits.circuits[i];
      const item = document.createElement('div');
      item.className = 'breaker-item' + (this.highlightedBreaker === br.id ? ' highlighted' : '');

      const colorEl = document.createElement('span');
      colorEl.className = 'circuit-color';
      colorEl.style.background = circuit ? circuit.color : '#999';
      item.appendChild(colorEl);

      const labelEl = document.createElement('span');
      labelEl.className = 'breaker-label';
      labelEl.textContent = br.label || `断路器 ${i + 1}`;
      item.appendChild(labelEl);

      const countEl = document.createElement('span');
      countEl.className = 'breaker-count';
      countEl.textContent = circuit ? `${circuit.wireIds.size} 段线` : '未接线';
      item.appendChild(countEl);

      item.addEventListener('click', () => {
        if (this.highlightedBreaker === br.id) {
          this.highlightedBreaker = null;
          this.emit('highlightCircuit', null);
        } else {
          this.highlightedBreaker = br.id;
          this.emit('highlightCircuit', i);
        }
        this.emit('refresh');
      });
      this.breakerListEl.appendChild(item);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'add-breaker-btn';
    addBtn.textContent = '＋ 添加断路器';
    addBtn.addEventListener('click', () => this.emit('addBreaker'));
    this.breakerListEl.appendChild(addBtn);
  }

  // ---------- 选中实体信息 ----------
  renderEntity(data, circuits, selection) {
    this.entityInfoEl.innerHTML = '';
    if (!selection) {
      this.entityInfoEl.innerHTML = this.mode === 'plan'
        ? '<p class="placeholder">在顶视图中点击墙、门或房间地面查看详情</p>'
        : '<p class="placeholder">点击 3D 场景中的电线、设备或端点查看详情</p>';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'entity-detail';
    this.entityInfoEl.appendChild(wrap);

    const addRow = (k, v) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="k">${k}</span>`;
      const vv = document.createElement('span');
      vv.className = 'v';
      if (typeof v === 'string') vv.textContent = v;
      else vv.appendChild(v);
      row.appendChild(vv);
      wrap.appendChild(row);
      return vv;
    };
    const addLabelEditor = (obj, field, name) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = obj[field] || '';
      input.placeholder = `输入${name}`;
      input.addEventListener('change', () => {
        obj[field] = input.value;
        this.emit('edited');
      });
      addRow(name, input);
    };
    const circuitChip = (cIdx) => {
      if (cIdx == null) return document.createTextNode('未接入线路');
      const c = circuits.circuits[cIdx];
      const chip = document.createElement('span');
      chip.className = 'circuit-chip';
      chip.style.background = c.color;
      chip.textContent = c.label || `线路 ${cIdx + 1}`;
      return chip;
    };

    if (selection.kind === 'wall' && this.mode === 'plan') {
      // 户型编辑：墙长可精确编辑，高度/厚度只读；不显示电路相关操作
      const wall = data.walls.find(w => w.id === selection.id);
      if (!wall) return;
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '墙体';
      wrap.appendChild(title);
      const lenInput = document.createElement('input');
      lenInput.type = 'number';
      lenInput.step = '0.1';
      lenInput.min = '0.2';
      lenInput.value = wallLen(wall).toFixed(2);
      lenInput.addEventListener('change', () => {
        this.emit('wallLength', { id: wall.id, len: parseFloat(lenInput.value) });
      });
      addRow('长度 (m)', lenInput);
      addRow('高度 (m)', String(wall.height ?? 2.8));
      addRow('厚度 (m)', String(wall.thickness ?? 0.2));
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.style.marginTop = '6px';
      p.textContent = '修改长度保持墙的方向与起点不变；拖动墙身平移，拖动端点/交点调整形状。';
      wrap.appendChild(p);
    } else if (selection.kind === 'door' && this.mode === 'plan') {
      // 户型编辑：门宽可编辑，开门方向可翻面；不显示电路相关操作
      const door = (data.doors || []).find(d => d.id === selection.id);
      if (!door) return;
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '门';
      wrap.appendChild(title);
      const wInput = document.createElement('input');
      wInput.type = 'number';
      wInput.step = '0.1';
      wInput.min = '0.4';
      wInput.value = door.width;
      wInput.addEventListener('change', () => {
        this.emit('doorWidth', { id: door.id, width: parseFloat(wInput.value) });
      });
      addRow('宽度 (m)', wInput);
      const flipBtn = document.createElement('button');
      flipBtn.className = 'tool-btn';
      flipBtn.textContent = '⇄ 开门方向翻面';
      flipBtn.addEventListener('click', () => this.emit('doorFlip', door.id));
      addRow('开门方向', flipBtn);
      const wall = data.walls.find(w => w.id === door.wall);
      addRow('所在墙', wall ? `墙 ${wall.id}` : '-');
      addRow('门高 (m)', String(door.height ?? 2.0));
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.style.marginTop = '6px';
      p.textContent = '顶视图中拖动门沿墙移动，靠近其他墙可换墙；Delete 删除。';
      wrap.appendChild(p);
    } else if (selection.kind === 'wire') {
      const wire = data.wires.find(w => w.id === selection.id);
      if (!wire) return;
      const nodes = new Map(data.nodes.map(n => [n.id, n]));
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '电线';
      wrap.appendChild(title);
      const cIdx = circuits.wireCircuit.get(wire.id);
      addRow('所属线路', circuitChip(cIdx));
      addRow('起点', nodeDesc(nodes.get(wire.from)));
      addRow('终点', nodeDesc(nodes.get(wire.to)));
      addLabelEditor(wire, 'label', '说明');
      const del = document.createElement('button');
      del.className = 'tool-btn danger';
      del.style.marginTop = '8px';
      del.textContent = '删除电线';
      del.addEventListener('click', () => this.emit('deleteWire', wire.id));
      wrap.appendChild(del);
    } else if (selection.kind === 'node') {
      const node = data.nodes.find(n => n.id === selection.id);
      if (!node) return;
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = node.type === 'device' ? `设备 · ${(DEVICE_TYPES[node.deviceType] || {}).name || ''}` : (NODE_TYPE_NAMES[node.type] || node.type);
      wrap.appendChild(title);
      const cIdx = circuits.nodeCircuit.get(node.id);
      addRow('所属线路', circuitChip(cIdx));
      const wall = data.walls.find(w => w.id === node.wall);
      addRow('所在墙', wall ? `墙 ${wall.id} · ${node.face === 0 ? 'A 面' : 'B 面'}` : '-');
      const hInput = document.createElement('input');
      hInput.type = 'number';
      hInput.step = '0.05';
      hInput.min = '0';
      hInput.max = String(wall ? wall.height : 3);
      hInput.value = node.height;
      hInput.addEventListener('change', () => {
        node.height = Math.max(0, Math.min(wall ? wall.height : 3, parseFloat(hInput.value) || 0));
        this.emit('edited');
      });
      addRow('离地高度 (m)', hInput);
      if (node.type === 'device') {
        if (node.deviceType === 'breakerBox') {
          // 强电箱是特殊设备：类型固定，显示断路器信息
          addRow('断路器数量', String((node.breakers || []).length));
          const p = document.createElement('p');
          p.className = 'placeholder';
          p.style.marginTop = '6px';
          p.textContent = '在上方强电箱面板中管理断路器；编辑模式下可沿墙水平拖动箱体。';
          wrap.appendChild(p);
        } else {
          const sel = document.createElement('select');
          for (const [k, v] of Object.entries(DEVICE_TYPES)) {
            if (k === 'breakerBox') continue; // 强电箱不能由普通设备转换而来
            const op = document.createElement('option');
            op.value = k; op.textContent = v.name;
            if (node.deviceType === k) op.selected = true;
            sel.appendChild(op);
          }
          sel.addEventListener('change', () => { node.deviceType = sel.value; this.emit('edited'); });
          addRow('设备类型', sel);
        }
      }
      addLabelEditor(node, 'label', '说明');
      const links = (data.links || []).filter(l => l.a === node.id || l.b === node.id);
      if (links.length) addRow('连通', `${links.length} 处连通`);
      const del = document.createElement('button');
      del.className = 'tool-btn danger';
      del.style.marginTop = '8px';
      del.textContent = '删除节点';
      del.addEventListener('click', () => this.emit('deleteNode', node.id));
      wrap.appendChild(del);
    } else if (selection.kind === 'room') {
      const title = document.createElement('div');
      title.className = 'entity-title';
      title.textContent = '房间';
      wrap.appendChild(title);
      const room = (this.rooms || []).find(r => r.key === selection.id);
      if (room) addRow('面积', `${room.area.toFixed(2)} m²`);
      const name = (data.roomNames || {})[selection.id] || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = name;
      input.placeholder = '房间名称';
      input.addEventListener('change', () => {
        if (!data.roomNames) data.roomNames = {};
        if (input.value) data.roomNames[selection.id] = input.value;
        else delete data.roomNames[selection.id]; // 清空名称：回到提示名/默认名
        this.emit('edited');
      });
      addRow('名称', input);
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.style.marginTop = '6px';
      p.textContent = '名称显示在 3D 场景与顶视图的房间中心；清空名称可恢复默认命名。';
      wrap.appendChild(p);
    }
  }
}

function nodeDesc(node) {
  if (!node) return '（缺失）';
  if (node.type === 'terminal') return '强电箱端子';
  if (node.type === 'device') return `${(DEVICE_TYPES[node.deviceType] || {}).name || '设备'}${node.label ? ' · ' + node.label : ''}`;
  return (NODE_TYPE_NAMES[node.type] || node.type) + (node.label ? ' · ' + node.label : '');
}
