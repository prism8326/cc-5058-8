/*
 * 场景层：维护真实的角色与道具状态（位置、朝向、接触点、碰撞、占用），
 * 实现 kernel 要求的 world 接口，并负责 Canvas 渲染与鼠标外部拖动。
 * 内核不直接改坐标；场景也不跳过协议直接搬道具。
 */
(function (global) {
  'use strict';

  const TOL_READY = 7;      // 就位容差
  const TOL_CONTACT = 13;   // 接触点保持容差
  const AGENT_R = 14;
  const SPEED = 1.7;
  const CARRY_SPEED = 1.5;

  const COLORS = {
    A: '#3b82f6',
    B: '#f59e0b',
    prop: '#a16207',
    propLift: '#ca8a04',
    slot: '#22c55e',
    obstacle: '#475569',
    footprint: '#94a3b8',
    path: 'rgba(148,163,184,0.55)',
  };

  class CarryScene {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.W = canvas.width;
      this.H = canvas.height;
      this.eventHandlers = new Set();
      this.shelfPresent = true;          // 货架是否在承托道具（与内核物理事实同步）
      this._bindMouse();
      this.applyScenario(CarryScene.SCENIOS.balanced);
    }

    on(fn) { this.eventHandlers.add(fn); return () => this.eventHandlers.delete(fn); }
    emit(type, data) { for (const fn of [...this.eventHandlers]) fn(type, data); }

    /* ---------------- 场景配置 ---------------- */
    static get SCENIOS() {
      return {
        balanced: {
          name: '标准协作',
          starts: { A: { x: 70, y: 110 }, B: { x: 70, y: 470 } },
          waypoints: { A: [], B: [] },
          obstacles: [],
        },
        longPath: {
          name: 'B 路径较长',
          starts: { A: { x: 70, y: 110 }, B: { x: 24, y: 528 } },
          waypoints: {
            A: [],
            B: [{ x: 260, y: 528 }, { x: 260, y: 430 }],
          },
          obstacles: [],
        },
        blocked: {
          name: 'A 就位失败（接触点被堵）',
          starts: { A: { x: 70, y: 110 }, B: { x: 70, y: 470 } },
          waypoints: { A: [], B: [] },
          // 压在 A 的上侧接触点上：A 永远无法满足接触约束
          obstacles: [{ x: 152, y: 218, w: 36, h: 26 }],
        },
        external: {
          name: '道具被外部移动',
          starts: { A: { x: 70, y: 110 }, B: { x: 70, y: 470 } },
          waypoints: { A: [], B: [] },
          obstacles: [],
        },
        spaceDrop: {
          name: '失去支撑·有空间就地放下',
          starts: { A: { x: 70, y: 110 }, B: { x: 70, y: 470 } },
          waypoints: { A: [], B: [] },
          obstacles: [],
        },
        noSpace: {
          name: '失去支撑·无空间共同回滚',
          starts: { A: { x: 70, y: 110 }, B: { x: 70, y: 470 } },
          waypoints: { A: [], B: [] },
          // 走廊中段两侧封堵：道具到这里时足迹与障碍相交（无放下空间），
          // 但障碍不越过走廊边线，搬运路径仍可通行
          // 几何约束：障碍必须与道具足迹（半高 28）相交才“无放下空间”，
          // 同时不能越过角色走廊边线（上 250 / 下 334），保证搬运仍可通行
          // 几何约束：障碍只与道具足迹（y 264..320）相交，不越过角色走廊
          // （A 碰撞下沿 264 / B 碰撞上沿 320），因此道具到此无放下空间但搬运可通行
          obstacles: [
            { x: 449, y: 264, w: 20, h: 8 },
            { x: 449, y: 312, w: 20, h: 8 },
          ],
        },
      };
    }

    applyScenario(cfg) {
      this.cfg = cfg;
      this.propW = 78;
      this.propH = 56;
      this.origin = { x: 175, y: 292 };
      this.slot = { x: 728, y: 292, w: 104, h: 84 };
      this.prop = { x: this.origin.x, y: this.origin.y, grounded: true };
      this.destinationOccupiedFlag = false;
      this.obstacles = cfg.obstacles.map(o => ({ ...o }));
      this.agents = {
        A: this._mkAgent('A', cfg.starts.A, cfg.waypoints.A),
        B: this._mkAgent('B', cfg.starts.B, cfg.waypoints.B),
      };
      this.carryDir = 0;       // +1 前进，-1 回滚
      this.rollbackDone = false;
      this.faults = { A: null, B: null }; // 'detach' | 'stuck'
      this.dragInfo = null;
      this.shelfPresent = true;
      this._notifyArrived = { A: false, B: false };
    }

    _mkAgent(id, start, waypoints) {
      return {
        id,
        x: start.x, y: start.y,
        facing: 0,
        mode: 'IDLE',           // IDLE/APPROACH/HOLD/CARRY/ROLLBACK/DETACHED/DONE
        waypoints: waypoints.map(w => ({ ...w })),
        target: null,
        speed: SPEED,
      };
    }

    reset() { this.applyScenario(this.cfg); }

    /* ---------------- 几何：接触点 / 足迹 ---------------- */
    gripOffset(id) {
      const d = this.propH / 2 + AGENT_R + 2;
      return id === 'A' ? { x: 0, y: -d } : { x: 0, y: d };
    }

    gripPoint(id, propPos) {
      const o = this.gripOffset(id);
      return { x: propPos.x + o.x, y: propPos.y + o.y };
    }

    footprintRect(pos) {
      return { x: pos.x - this.propW / 2, y: pos.y - this.propH / 2,
               w: this.propW, h: this.propH };
    }

    rectsOverlap(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x &&
             a.y < b.y + b.h && a.y + a.h > b.y;
    }

    /* 道具在 (x,y) 处是否有放下的剩余空间（不与障碍相交） */
    canPlaceHere(x, y) {
      const fp = this.footprintRect({ x, y });
      return !this.obstacles.some(o => this.rectsOverlap(fp, o));
    }

    /* ---------------- kernel 需要的 world 接口 ---------------- */
    agentPose(id) {
      const ag = this.agents[id];
      const grip = this.gripPoint(id, this.prop);
      const dist = Math.hypot(ag.x - grip.x, ag.y - grip.y);
      const faceDx = this.prop.x - ag.x;
      const faceDy = this.prop.y - ag.y;
      const wantFace = Math.atan2(faceDy, faceDx);
      let df = Math.abs(ag.facing - wantFace);
      while (df > Math.PI) df = Math.abs(df - 2 * Math.PI);
      const contactOK = dist <= TOL_CONTACT;
      const ready = dist <= TOL_READY && df < 0.9 && this._agentBlocked(id) === false;
      return { x: ag.x, y: ag.y, ready, contactOK, grip, dist: Math.round(dist) };
    }

    _agentBlocked(id) {
      // 接触点落在障碍物内时，姿态不可能成立
      const g = this.gripPoint(id, this.prop);
      return this.obstacles.some(o =>
        g.x > o.x - AGENT_R && g.x < o.x + o.w + AGENT_R &&
        g.y > o.y - AGENT_R && g.y < o.y + o.h + AGENT_R);
    }

    propOrigin() { return { ...this.origin }; }
    propPosition() { return { x: this.prop.x, y: this.prop.y }; }
    destinationOccupied() { return this.destinationOccupiedFlag; }

    startCarry() {
      this.carryDir = +1;
      this.rollbackDone = false;
      for (const id of ['A', 'B']) {
        if (this.agents[id].mode !== 'DETACHED') this.agents[id].mode = 'CARRY';
      }
      this.prop.grounded = false;
    }

    startRollback() {
      this.carryDir = -1;
      this.rollbackDone = false;
      // 共同回滚：脱离一侧在回滚启动时重新握住接触点（双方共同把道具抬回原点）
      for (const id of ['A', 'B']) {
        const ag = this.agents[id];
        if (ag.mode === 'DETACHED') {
          const g = this.gripPoint(id, this.prop);
          ag.x = g.x; ag.y = g.y;
        }
        ag.mode = 'ROLLBACK';
      }
    }

    stopMotion() {
      for (const id of ['A', 'B']) {
        if (this.agents[id].mode === 'CARRY' || this.agents[id].mode === 'ROLLBACK') {
          this.agents[id].mode = 'HOLD';
        }
      }
    }

    placePropAt(x, y) {
      this.prop.x = x; this.prop.y = y; this.prop.grounded = true;
      this.destinationOccupiedFlag = true;
      for (const id of ['A', 'B']) this.agents[id].mode = 'DONE';
    }

    dropPropHere() {
      this.prop.grounded = true;
      for (const id of ['A', 'B']) {
        if (this.agents[id].mode !== 'DETACHED') this.agents[id].mode = 'HOLD';
      }
    }

    resetPropToOrigin() {
      this.prop.x = this.origin.x;
      this.prop.y = this.origin.y;
      this.prop.grounded = true;
      for (const id of ['A', 'B']) this.agents[id].mode = 'IDLE';
    }

    /* 货架是否在承托道具：由内核物理事实驱动，仅影响渲染 */
    setShelfPresent(present) { this.shelfPresent = !!present; }

    /* ---------------- 角色行为控制（由控件驱动） ---------------- */
    beginApproach(id) {
      const ag = this.agents[id];
      if (ag.mode === 'IDLE' || ag.mode === 'DETACHED') ag.mode = 'APPROACH';
    }

    injectFault(id, kind) { this.faults[id] = kind; }
    clearFaults() { this.faults = { A: null, B: null }; }

    /* 故障/恢复：角色脱离或重新握住接触点（由控件触发，真实改变角色状态） */
    detachAgent(id) {
      const ag = this.agents[id];
      if (ag.mode === 'CARRY' || ag.mode === 'ROLLBACK' || ag.mode === 'HOLD') {
        ag.mode = 'DETACHED';
      }
    }

    reattachAgent(id) {
      const ag = this.agents[id];
      if (ag.mode !== 'DETACHED') return;
      const g = this.gripPoint(id, this.prop);
      ag.x = g.x; ag.y = g.y;
      ag.mode = this.prop.grounded ? 'HOLD' : 'CARRY';
      ag.facing = Math.atan2(this.prop.y - ag.y, this.prop.x - ag.x);
    }

    /* ---------------- 每帧更新 ---------------- */
    update() {
      for (const id of ['A', 'B']) this._updateAgent(id);
      this._updateCarry();
      this._checkContactViolation();
    }

    _updateAgent(id) {
      const ag = this.agents[id];
      if (this.faults[id] === 'detach') { ag.mode = 'DETACHED'; return; }

      if (ag.mode === 'APPROACH') {
        // 先走完声明的途径点，再去当前接触点
        if (ag.waypoints.length) {
          ag.target = ag.waypoints[0];
          if (this._steer(ag, ag.target, SPEED) < 4) ag.waypoints.shift();
        } else {
          ag.target = this.gripPoint(id, this.prop);
          const arrived = this._steer(ag, ag.target, SPEED) < TOL_READY;
          if (arrived && !this._agentBlocked(id)) {
            ag.mode = 'HOLD';
            if (!this._notifyArrived[id]) {
              this._notifyArrived[id] = true;
              this.emit('agent:arrived', { agent: id });
            }
          }
        }
      } else if (ag.mode === 'HOLD') {
        // 握住不动，朝向道具
        ag.facing = Math.atan2(this.prop.y - ag.y, this.prop.x - ag.x);
      }
    }

    _steer(ag, target, speed) {
      const dx = target.x - ag.x;
      const dy = target.y - ag.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.5) return 0;
      const step = Math.min(speed, d);
      const nx = ag.x + (dx / d) * step;
      const ny = ag.y + (dy / d) * step;
      if (!this._collides(nx, ny, ag)) {
        ag.x = nx; ag.y = ny;
      } else {
        // 被障碍挡住：沿单轴尝试，仍不行则原地停滞（就位失败的真实表现）
        if (!this._collides(ag.x + (dx / d) * step, ag.y, ag)) ag.x += (dx / d) * step;
        else if (!this._collides(ag.x, ag.y + (dy / d) * step, ag)) ag.y += (dy / d) * step;
      }
      ag.facing = Math.atan2(dy, dx);
      return Math.hypot(target.x - ag.x, target.y - ag.y);
    }

    _collides(x, y, ag) {
      if (x < AGENT_R || x > this.W - AGENT_R || y < AGENT_R || y > this.H - AGENT_R) return true;
      return this.obstacles.some(o =>
        x > o.x - AGENT_R && x < o.x + o.w + AGENT_R &&
        y > o.y - AGENT_R && y < o.y + o.h + AGENT_R);
    }

    _updateCarry() {
      const moving = this.agents.A.mode === 'CARRY' || this.agents.A.mode === 'ROLLBACK' ||
                     this.agents.B.mode === 'CARRY' || this.agents.B.mode === 'ROLLBACK';
      if (!moving || this.prop.grounded) return;

      const attached = id => this.agents[id].mode === 'CARRY' || this.agents[id].mode === 'ROLLBACK';
      // 只有双方都附着时道具才随接触点移动；单方附着无法拖动道具
      if (!attached('A') || !attached('B')) return;

      const speed = CARRY_SPEED * this.carryDir;
      for (const id of ['A', 'B']) {
        const ag = this.agents[id];
        const g = this.gripPoint(id, this.prop);
        const nx = ag.x + speed;
        if (!this._collides(nx, ag.y, ag)) ag.x = nx;
        ag.target = g;
        ag.facing = Math.atan2(this.prop.y - ag.y, this.prop.x - ag.x);
      }
      // 道具位置由两个真实接触点的锚点共同决定（非瞬移）
      const gA = this.gripPoint('A', this.prop);
      const gB = this.gripPoint('B', this.prop);
      const avgDx = ((this.agents.A.x - gA.x) + (this.agents.B.x - gB.x)) / 2;
      const avgDy = ((this.agents.A.y - gA.y) + (this.agents.B.y - gB.y)) / 2;
      this.prop.x += avgDx;
      this.prop.y += avgDy;

      if (this.carryDir === -1 &&
          Math.abs(this.prop.x - this.origin.x) < 2 &&
          Math.abs(this.prop.y - this.origin.y) < 2) {
        this.prop.x = this.origin.x; this.prop.y = this.origin.y;
        if (!this.rollbackDone) {
          this.rollbackDone = true;
          this.emit('rollback:arrived', {});
        }
      }
      if (this.carryDir === +1 &&
          Math.abs(this.prop.x - this.slot.x) < 3 &&
          Math.abs(this.prop.y - this.slot.y) < 4) {
        this.prop.x = this.slot.x; this.prop.y = this.slot.y;
        this.emit('carry:arrived', {});
      }
    }

    /* 姿态约束的真实校验：搬运中接触点脱离即上报，而不是靠全局开关 */
    _checkContactViolation() {
      for (const id of ['A', 'B']) {
        const ag = this.agents[id];
        if (ag.mode !== 'CARRY' && ag.mode !== 'ROLLBACK') continue;
        const pose = this.agentPose(id);
        if (!pose.contactOK) this.emit('contact:lost', { agent: id, dist: pose.dist });
      }
    }

    /* ---------------- 鼠标拖动：道具落地时=外部移动；握住阶段=拖动取消事件 ---------------- */
    _bindMouse() {
      const pos = e => {
        const r = this.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (this.W / r.width),
                 y: (e.clientY - r.top) * (this.H / r.height) };
      };
      this.canvas.addEventListener('mousedown', e => {
        const p = pos(e);
        const fp = this.footprintRect(this.prop);
        this.dragInfo = null;
        // 握点/把手命中优先：即使点在道具足迹之外也识别为取消事件
        const onGrip = ['A', 'B'].some(id => {
          const g = this.gripPoint(id, this.prop);
          return Math.hypot(g.x - p.x, g.y - p.y) <= AGENT_R + 10;
        });
        const onProp = this.rectsOverlap(fp, { x: p.x, y: p.y, w: 1, h: 1 });
        if (!onGrip && !onProp) return;
        this.dragInfo = {
          dx: this.prop.x - p.x,
          dy: this.prop.y - p.y,
          mode: onGrip ? 'cancel' : 'move',
          startX: this.prop.x,
          startY: this.prop.y,
        };
        this.emit('drag:start', { mode: this.dragInfo.mode });
      });
      this.canvas.addEventListener('mousemove', e => {
        if (!this.dragInfo || this.dragInfo.mode !== 'move') return;
        const p = pos(e);
        this.prop.x = p.x + this.dragInfo.dx;
        this.prop.y = p.y + this.dragInfo.dy;
      });
      this.canvas.addEventListener('mouseup', () => {
        if (!this.dragInfo) return;
        const info = this.dragInfo;
        this.dragInfo = null;
        if (info.mode === 'cancel') {
          // 拖动取消事件：不搬动道具，交给应用层决定在什么时点撤销
          this.emit('cancel:requested', { via: 'drag' });
          return;
        }
        this.emit('prop:dragged', { x: this.prop.x, y: this.prop.y });
      });
    }

    /* ---------------- 渲染 ---------------- */
    render(phase, propState) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);
      this._drawGrid();
      this._drawSlot();
      this._drawPaths();
      this._drawFootprints(phase);
      for (const o of this.obstacles) this._drawObstacle(o);
      this._drawShelf(propState);
      this._drawProp(propState);
      this._drawContactRays(phase);
      this._drawAgent('A');
      this._drawAgent('B');
    }

    _drawGrid() {
      const ctx = this.ctx;
      ctx.strokeStyle = '#eef2f7';
      ctx.lineWidth = 1;
      for (let x = 0; x < this.W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H); ctx.stroke();
      }
      for (let y = 0; y < this.H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.W, y); ctx.stroke();
      }
    }

    _drawSlot() {
      const ctx = this.ctx;
      const s = this.slot;
      ctx.save();
      ctx.strokeStyle = this.destinationOccupiedFlag ? '#16a34a' : COLORS.slot;
      ctx.fillStyle = this.destinationOccupiedFlag ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.08)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.fillRect(s.x - s.w / 2, s.y - s.h / 2, s.w, s.h);
      ctx.strokeRect(s.x - s.w / 2, s.y - s.h / 2, s.w, s.h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#15803d';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this.destinationOccupiedFlag ? '目的地·已占用' : '目的地（放置槽）', s.x, s.y - s.h / 2 - 8);
      ctx.restore();
    }

    _drawPaths() {
      const ctx = this.ctx;
      for (const id of ['A', 'B']) {
        const ag = this.agents[id];
        const pts = [this.cfg.starts[id], ...this.cfg.waypoints[id], this.gripPoint(id, this.prop)];
        ctx.strokeStyle = COLORS.path;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 搬运走廊（两接触点的平行运动路径）
      const gA0 = this.gripPoint('A', this.origin);
      const gB0 = this.gripPoint('B', this.origin);
      const gA1 = this.gripPoint('A', this.slot);
      const gB1 = this.gripPoint('B', this.slot);
      ctx.strokeStyle = 'rgba(59,130,246,0.35)';
      ctx.beginPath(); ctx.moveTo(gA0.x, gA0.y); ctx.lineTo(gA1.x, gA1.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(245,158,11,0.35)';
      ctx.beginPath(); ctx.moveTo(gB0.x, gB0.y); ctx.lineTo(gB1.x, gB1.y); ctx.stroke();
    }

    _drawFootprints(phase) {
      const ctx = this.ctx;
      for (const id of ['A', 'B']) {
        const g = this.gripPoint(id, this.prop);
        const pose = this.agentPose(id);
        ctx.beginPath();
        ctx.arc(g.x, g.y, AGENT_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = pose.ready ? '#16a34a' : COLORS.footprint;
        ctx.lineWidth = pose.ready ? 3 : 1.5;
        ctx.stroke();
        ctx.fillStyle = pose.ready ? 'rgba(22,163,74,0.12)' : 'rgba(148,163,184,0.10)';
        ctx.fill();
        ctx.fillStyle = '#64748b';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${id} 接触点`, g.x, g.y + (id === 'A' ? -22 : 30));
      }
    }

    _drawObstacle(o) {
      const ctx = this.ctx;
      ctx.fillStyle = COLORS.obstacle;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = '#1e293b';
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    }

    /* 货架承托：在场时道具重量由它承担；撤走后双握点承重 */
    _drawShelf(propState) {
      if (!this.shelfPresent) return;
      const ctx = this.ctx;
      const p = this.prop;
      const halfW = this.propW / 2 + 14;
      ctx.save();
      ctx.strokeStyle = '#0ea5e9';
      ctx.fillStyle = 'rgba(14,165,233,0.08)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(p.x - halfW, p.y + this.propH / 2 + 12);
      ctx.lineTo(p.x + halfW, p.y + this.propH / 2 + 12);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillRect(p.x - halfW, p.y + this.propH / 2 + 12, halfW * 2, 8);
      ctx.fillStyle = '#0369a1';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('货架承托（重量在货架）', p.x, p.y + this.propH / 2 + 34);
      ctx.restore();
    }

    _drawProp(propState) {
      const ctx = this.ctx;
      const p = this.prop;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (!p.grounded) ctx.translate(0, -3);
      ctx.fillStyle = p.grounded ? COLORS.prop : COLORS.propLift;
      ctx.fillRect(-this.propW / 2, -this.propH / 2, this.propW, this.propH);
      ctx.strokeStyle = '#451a03';
      ctx.lineWidth = 2;
      ctx.strokeRect(-this.propW / 2, -this.propH / 2, this.propW, this.propH);
      ctx.strokeStyle = 'rgba(69,26,3,0.6)';
      ctx.beginPath();
      ctx.moveTo(-this.propW / 2 + 10, 0); ctx.lineTo(this.propW / 2 - 10, 0);
      ctx.stroke();
      ctx.fillStyle = '#fff7ed';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('大型道具', 0, 5);
      ctx.font = '11px sans-serif';
      ctx.fillText(p.grounded ? `[${propState}]` : '[LIFTED]', 0, this.propH / 2 - 6);
      ctx.restore();
    }

    _drawContactRays(phase) {
      const ctx = this.ctx;
      const show = ['COMMITTED', 'LIFTING', 'CARRYING', 'PLACING', 'RECOVERING'].includes(phase);
      if (!show) return;
      for (const id of ['A', 'B']) {
        const ag = this.agents[id];
        const g = this.gripPoint(id, this.prop);
        const ok = this.agentPose(id).contactOK;
        ctx.strokeStyle = ok ? 'rgba(22,163,74,0.7)' : 'rgba(220,38,38,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ag.x, ag.y); ctx.lineTo(g.x, g.y); ctx.stroke();
      }
    }

    _drawAgent(id) {
      const ctx = this.ctx;
      const ag = this.agents[id];
      const detached = ag.mode === 'DETACHED';
      ctx.beginPath();
      ctx.arc(ag.x, ag.y, AGENT_R, 0, Math.PI * 2);
      ctx.fillStyle = detached ? '#94a3b8' : COLORS[id];
      ctx.fill();
      ctx.strokeStyle = detached ? '#64748b' : '#0f172a';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 朝向
      ctx.beginPath();
      ctx.moveTo(ag.x, ag.y);
      ctx.lineTo(ag.x + Math.cos(ag.facing) * (AGENT_R + 6),
                 ag.y + Math.sin(ag.facing) * (AGENT_R + 6));
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(id, ag.x, ag.y + 4);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText(ag.mode, ag.x, ag.y + AGENT_R + 12);
    }
  }

  global.CarryScene = CarryScene;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CarryScene };
})(typeof globalThis !== 'undefined' ? globalThis : this);
