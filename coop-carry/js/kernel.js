/*
 * coop-carry 联合搬运协调内核
 * ------------------------------------------------------------------
 * 内核只依赖 world 接口（由场景层实现），不依赖 DOM，可在 Node 中直接测试。
 *
 * 协调阶段（显式协议，不允许跳跃）：
 *   IDLE -> PREPARING（双方就位/声明姿态 READY）
 *        -> COMMITTED（双方承诺 COMMIT）
 *        -> LIFTING （双方施力 FORCE，共同抬起，单次幂等）
 *        -> CARRYING （共同移动）
 *        -> PLACING （双方 RELEASE，完成放置）
 *        -> DONE
 *   异常分支：RECOVERING（失去一侧支撑，按剩余空间裁决 就地放下 / 共同回滚）
 *
 * 消息可延迟或重复；每条消息带 epoch + 唯一 id，重复消息绝不重复施加效果。
 */
(function (global) {
  'use strict';

  const Phase = Object.freeze({
    IDLE: 'IDLE',
    PREPARING: 'PREPARING',
    COMMITTED: 'COMMITTED',
    LIFTING: 'LIFTING',
    CARRYING: 'CARRYING',
    RECOVERING: 'RECOVERING',
    PLACING: 'PLACING',
    DONE: 'DONE',
    ABORTED: 'ABORTED',
  });

  const PropState = Object.freeze({
    GROUNDED: 'GROUNDED',
    LIFTED: 'LIFTED',
    PLACED: 'PLACED',
    DROPPED: 'DROPPED',
  });

  let MSG_SEQ = 0;

  class CoopKernel {
    /**
     * @param {object} world 场景层实现，必须提供：
     *   agentPose(a)            -> {x,y,ready,contactOK,grip}
     *   canPlaceHere(x,y)       -> boolean  当前道具所在处是否有空间就地放下
     *   startCarry() / startRollback() / stopMotion()
     *   placePropAt(x,y) / dropPropHere()
     *   resetPropToOrigin()
     */
    constructor(world, opts = {}) {
      this.world = world;
      this.agents = ['A', 'B'];
      this.listeners = new Set();
      this.bus = [];                 // 待投递消息（可延迟）
      this.msgDelay = 0;            // 每条消息的固定延迟（tick 数）
      this.duplicateEvery = 0;      // >0 时，每 N 条消息额外重复投递一次
      this._sentCount = 0;
      this.commitWindow = opts.commitWindow ?? 600;
      this.recoverTimeout = opts.recoverTimeout ?? 600;
      this.prepWindow = opts.prepWindow ?? 900;
      this.reset();
    }

    /* ---------------- 事件 ---------------- */
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, data) {
      for (const fn of [...this.listeners]) {
        try { fn(type, data); } catch (e) { console.error('listener error', e); }
      }
    }

    /* ---------------- 生命周期 ---------------- */
    reset() {
      this.epoch = 0;
      this.phase = Phase.IDLE;
      this.propState = PropState.GROUNDED;
      this.bus.length = 0;
      this._sentCount = 0;
      this.attempt = null;
      this.tickNo = 0;
      this._watchdog = null;
      this._newAttempt();
      this._setPhase(Phase.IDLE, true);
      this._setPropState(PropState.GROUNDED, true);
    }

    _newAttempt() {
      const mk = () => ({
        pose: null,
        ready: false,
        committed: false,
        forced: false,
        released: false,
        knowledge: { phase: Phase.IDLE, prop: PropState.GROUNDED },
        attached: false,
      });
      this.attempt = { A: mk(), B: mk(), origin: null, leader: null, startedAt: 0 };
    }

    /* ---------------- 协议入口：发起协作 ---------------- */
    start(leader) {
      if (!this.agents.includes(leader)) throw new Error('unknown agent ' + leader);
      if (this.phase !== Phase.IDLE && this.phase !== Phase.DONE &&
          this.phase !== Phase.ABORTED) {
        return this._reject('START_BUSY', '当前已有联合动作在进行，不能重复发起');
      }
      if (this.world.destinationOccupied && this.world.destinationOccupied()) {
        return this._reject('DEST_OCCUPIED', '目的地已被占用，联合搬运无法启动');
      }
      this.epoch += 1;
      this._seen = new Set();
      this.bus.length = 0;
      this._newAttempt();
      this.world.resetPropToOrigin();
      this.attempt.leader = leader;
      this.attempt.origin = this.world.propOrigin();
      this.attempt.startedAt = this.tickNo;
      this._watchdog = { type: 'prep', until: this.tickNo + this.prepWindow };
      this._setPhase(Phase.PREPARING);
      const other = leader === 'A' ? 'B' : 'A';
      this._send(leader, other, 'INVITE', { epoch: this.epoch });
      this.emit('attempt:start', { epoch: this.epoch, leader });
      return { ok: true, epoch: this.epoch };
    }

    /* 角色声明：我已就位且姿态满足接触点约束 */
    declareReady(a) {
      if (this.phase !== Phase.PREPARING) {
        return this._reject('READY_WRONG_PHASE', `${a} 就绪声明被拒：当前阶段 ${this.phase}`);
      }
      const st = this.attempt[a];
      if (st.ready) return { ok: true, duplicate: true };
      const pose = this.world.agentPose(a);
      if (!pose.ready || !pose.contactOK) {
        return this._reject('NOT_IN_POSITION',
          `${a} 实际姿态未满足接触点约束（就位=${pose.ready} 接触=${pose.contactOK}），不能宣告就绪`);
      }
      st.pose = { x: pose.x, y: pose.y };
      st.ready = true;
      this.emit('agent:ready', { agent: a, epoch: this.epoch });
      const other = a === 'A' ? 'B' : 'A';
      this._send(a, other, 'READY', { epoch: this.epoch, pose: st.pose });
      if (this.attempt.A.ready && this.attempt.B.ready) {
        this._watchdog = { type: 'commit', until: this.tickNo + this.commitWindow };
        this.emit('both:ready', { epoch: this.epoch });
      }      return { ok: true };
    }

    /* 角色承诺（也可由内核在双方就绪后自动驱动） */
    commit(a) {
      if (this.phase !== Phase.PREPARING) {
        return this._reject('COMMIT_WRONG_PHASE', `${a} 承诺被拒：当前阶段 ${this.phase}`);
      }
      const st = this.attempt[a];
      if (st.committed) return { ok: true, duplicate: true };
      if (!st.ready) return this._reject('NOT_READY', `${a} 尚未就绪，不能承诺`);
      const pose = this.world.agentPose(a);
      if (!pose.ready || !pose.contactOK) {
        return this._failAttempt('LOST_POSTURE', `${a} 承诺时姿态已偏离接触点，动作中止`);
      }
      st.committed = true;
      const other = a === 'A' ? 'B' : 'A';
      this._send(a, other, 'COMMIT', { epoch: this.epoch });
      this.emit('agent:commit', { agent: a });
      if (this.attempt.A.committed && this.attempt.B.committed) {
        this._watchdog = null;
        this._setPhase(Phase.COMMITTED);
        this.emit('both:committed', {});
      }
      return { ok: true };
    }

    /* 角色开始施力（抬起）。单方施力永远无法移动道具 */
    applyForce(a) {
      if (this.phase === Phase.IDLE || this.phase === Phase.PREPARING) {
        return this._reject('SOLO_LIFT_BLOCKED',
          `${a} 另一方尚未承诺，禁止独自抬起/瞬移道具`);
      }
      if (this.phase !== Phase.COMMITTED && this.phase !== Phase.LIFTING) {
        return this._reject('FORCE_WRONG_PHASE', `${a} 施力被拒：当前阶段 ${this.phase}`);
      }
      const st = this.attempt[a];
      if (st.forced) return { ok: true, duplicate: true }; // 幂等：不重复施加抬升
      const pose = this.world.agentPose(a);
      if (!pose.contactOK) {
        return this._reject('NO_CONTACT', `${a} 未握住接触点，施力无效`);
      }
      st.forced = true;
      st.attached = true;
      const other = a === 'A' ? 'B' : 'A';
      this._send(a, other, 'FORCE', { epoch: this.epoch });
      this.emit('agent:force', { agent: a });
      if (this.attempt.A.forced && this.attempt.B.forced) {
        this._setPhase(Phase.LIFTING);
        this._setPropState(PropState.LIFTED); // 唯一的抬升生效点（一次）
        this.world.startCarry();
        this._setPhase(Phase.CARRYING);
        this.emit('lift:done', { epoch: this.epoch });
      }
      return { ok: true };
    }

    /* 角色松开（到达目的地后的放置，或中途放弃） */
    release(a) {
      const st = this.attempt[a];
      if (st.released) return { ok: true, duplicate: true };
      if (this.phase !== Phase.CARRYING && this.phase !== Phase.PLACING &&
          this.phase !== Phase.RECOVERING) {
        return this._reject('RELEASE_WRONG_PHASE', `${a} 松开被拒：当前阶段 ${this.phase}`);
      }
      st.released = true;
      st.attached = false;
      const other = a === 'A' ? 'B' : 'A';
      this._send(a, other, 'RELEASE', { epoch: this.epoch });
      this.emit('agent:release', { agent: a });

      if (this.phase === Phase.RECOVERING) {
        // 回滚/就地放下过程中角色松手：剩余一方无法独自支撑，紧急就地放下
        this._emergencyDrop(`回滚过程中 ${a} 松手，剩余支撑不足，紧急放下`);
        return { ok: true };
      }

      if (this.attempt.A.released && this.attempt.B.released) {
        this._finishPlacement();
      } else {
        this._setPhase(Phase.PLACING);
      }
      return { ok: true };
    }

    /* 中途失去一侧支撑（角色故障/姿态脱离），按剩余空间裁决 */
    loseSupport(a, reason) {
      if (this.phase !== Phase.CARRYING && this.phase !== Phase.LIFTING &&
          this.phase !== Phase.PLACING) {
        return { ok: false, ignored: true };
      }
      const st = this.attempt[a];
      st.attached = false;
      this.emit('support:lost', { agent: a, reason });

      const here = this.world.propPosition();
      if (this.world.canPlaceHere(here.x, here.y)) {
        // 剩余空间足够：就地放下
        this.world.stopMotion();
        this._setPhase(Phase.PLACING);
        this.world.dropPropHere();
        this._setPropState(PropState.DROPPED);
        this.emit('arbitration', {
          verdict: 'DROP_IN_PLACE', reason, at: { ...here },
          detail: '当前位置剩余空间允许就地放下，不再移动道具',
        });
        this._finishAfterInterrupt('DROPPED_IN_PLACE');
      } else {
        // 空间不足：共同回滚到抬起点（双方重新就位），超时则紧急放下
        this.world.stopMotion();
        this._setPhase(Phase.RECOVERING);
        this._watchdog = { type: 'recover', until: this.tickNo + this.recoverTimeout };
        this.world.startRollback();
        this.emit('arbitration', {
          verdict: 'ROLLBACK', reason, at: { ...here },
          detail: '当前位置无放下空间，双方共同回滚到抬起点',
        });
      }
      return { ok: true };
    }

    /* 回滚到位：双方重新就位，恢复共同搬运 */
    rollbackArrived() {
      if (this.phase !== Phase.RECOVERING) return;
      this._watchdog = null;
      for (const a of this.agents) this.attempt[a].attached = true;
      this.world.startCarry();
      this._setPhase(Phase.CARRYING);
      this.emit('recover:resume', {});
    }

    /* 任一方主动中止 */
    abort(a, reason) {
      if (this.phase === Phase.IDLE || this.phase === Phase.DONE ||
          this.phase === Phase.ABORTED) return { ok: false };
      this.emit('agent:abort', { agent: a, reason });
      this._failAttempt('ABORTED', reason || `${a} 中止了联合动作`);
      return { ok: true };
    }

    /* 外部移动了道具：使姿态/接触点失效，按当前阶段处理 */
    externalMove(to) {
      this.emit('prop:external', { to });
      if (this.phase === Phase.PREPARING || this.phase === Phase.COMMITTED) {
        // _failAttempt 内部已负责 stopMotion + 道具复位
        return this._failAttempt('PROP_MOVED_EXTERNALLY', '道具被外部移动，接触点承诺失效，动作中止并复位');
      } else if (this.phase === Phase.CARRYING || this.phase === Phase.LIFTING) {
        this.loseSupport('A', '外部移动道具');
        this.attempt.B.attached = false;
      } else {
        this.world.resetPropToOrigin();
      }
      return { ok: true };
    }

    /* ---------------- 内核驱动（每 tick） ---------------- */
    tick() {
      this.tickNo += 1;
      this._deliverBus();
      this._runWatchdog();
    }

    _runWatchdog() {
      if (!this._watchdog) return;
      const w = this._watchdog;
      if (this.tickNo < w.until) return;
      this._watchdog = null;
      if (w.type === 'prep') {
        const waiting = this.agents.filter(a => !this.attempt[a].ready);
        this._failAttempt('READY_TIMEOUT',
          `准备窗口内角色 ${waiting.join('/')} 未就位，联合动作中止`);
      } else if (w.type === 'commit') {
        this._failAttempt('COMMIT_TIMEOUT', '承诺窗口内未收到双方 COMMIT，联合动作中止');
      } else if (w.type === 'recover') {
        this._emergencyDrop('共同回滚超时，紧急放下道具');
      }
    }

    /* ---------------- 消息总线（延迟 / 重复 / 去重） ---------------- */
    _send(from, to, type, payload) {
      this._sentCount += 1;
      const id = `m${++MSG_SEQ}`;
      const deliverAt = this.tickNo + this.msgDelay;
      this.bus.push({ id, from, to, type, payload: { ...payload }, deliverAt, epoch: this.epoch });
      // 配置化重复投递：同一 id 再发一份，验证接收端幂等
      if (this.duplicateEvery > 0 && this._sentCount % this.duplicateEvery === 0) {
        this.bus.push({ id: id + '#dup', sameAs: id, from, to, type,
          payload: { ...payload }, deliverAt: deliverAt + 1, epoch: this.epoch });
      }
    }

    _deliverBus() {
      const due = this.bus.filter(m => m.deliverAt <= this.tickNo);
      this.bus = this.bus.filter(m => m.deliverAt > this.tickNo);
      for (const m of due) this.handleDelivered(m);
    }

    /* 接收端：epoch 过滤 + id 去重，重复消息绝不重复施加效果 */
    handleDelivered(m) {
      if (m.epoch !== this.epoch) {
        this.emit('msg:stale', { id: m.id, type: m.type });
        return;
      }
      if (!this._seen) this._seen = new Set();
      const dedupId = m.sameAs || m.id;
      if (this._seen.has(dedupId)) {
        this.emit('msg:duplicate', { id: dedupId, type: m.type });
        return;
      }
      this._seen.add(dedupId);
      const st = this.attempt[m.to];
      if (st) {
        st.knowledge.lastFrom = m.from;
        st.knowledge.lastMsg = m.type;
      }
      this.emit('msg:deliver', { ...m, id: dedupId });

      switch (m.type) {
        case 'INVITE':
        case 'READY':
        case 'COMMIT':
        case 'FORCE':
        case 'RELEASE':
          break; // 状态已在发送方动作中落库；消息用于同步另一方认知
        case 'PHASE':
          this.attempt[m.to].knowledge.phase = m.payload.phase;
          break;
        case 'PROP':
          this.attempt[m.to].knowledge.prop = m.payload.state;
          break;
        default:
          this.emit('msg:unknown', { type: m.type });
      }
    }

    /* ---------------- 内部状态机 ---------------- */
    _setPhase(p, silent) {
      this.phase = p;
      for (const a of this.agents) {
        this.attempt[a].knowledge.phase = p;
      }
      if (!silent) this.emit('phase:change', { phase: p });
    }

    _setPropState(s, silent) {
      this.propState = s;
      for (const a of this.agents) {
        this.attempt[a].knowledge.prop = s;
      }
      if (!silent) this.emit('prop:state', { state: s });
    }

    _finishPlacement() {
      this._setPhase(Phase.PLACING);
      const at = this.world.propPosition();
      this.world.placePropAt(at.x, at.y);
      this._setPropState(PropState.PLACED);
      this._finishAfterInterrupt('PLACED_AT_DESTINATION');
    }

    _finishAfterInterrupt(result) {
      this._setPhase(Phase.DONE);
      this._watchdog = null;
      this.emit('attempt:done', {
        result,
        prop: this.propState,
        at: this.world.propPosition(),
      });
    }

    _emergencyDrop(reason) {
      if (this.phase === Phase.DONE || this.phase === Phase.ABORTED) return;
      this.world.stopMotion();
      this.world.dropPropHere();
      this._setPropState(PropState.DROPPED);
      this.emit('arbitration', { verdict: 'EMERGENCY_DROP', reason });
      this._finishAfterInterrupt('EMERGENCY_DROP');
    }

    _failAttempt(code, detail) {
      this.world.stopMotion();
      this.world.resetPropToOrigin();
      for (const a of this.agents) this.attempt[a].attached = false;
      this._setPropState(PropState.GROUNDED);
      this._setPhase(Phase.ABORTED);
      this._watchdog = null;
      this.emit('attempt:failed', { code, detail });
      return { ok: false, code, detail };
    }

    _reject(code, detail) {
      this.emit('action:rejected', { code, detail });
      return { ok: false, code, detail };
    }

    /* ---------------- 调试视图数据：每个参与者“各自知道的阶段” ---------------- */
    debugSnapshot() {
      return {
        epoch: this.epoch,
        tick: this.tickNo,
        phase: this.phase,
        propState: this.propState,
        busDepth: this.bus.length,
        agents: this.agents.map(a => {
          const st = this.attempt[a];
          const pose = this.world.agentPose(a);
          return {
            agent: a,
            isLeader: this.attempt.leader === a,
            ready: st.ready,
            committed: st.committed,
            forced: st.forced,
            released: st.released,
            attached: st.attached,
            knowsPhase: st.knowledge.phase,
            knowsProp: st.knowledge.prop,
            lastMsg: st.knowledge.lastMsg || '-',
            pose: { x: Math.round(pose.x), y: Math.round(pose.y),
                    contactOK: pose.contactOK, ready: pose.ready },
          };
        }),
      };
    }
  }

  const api = { CoopKernel, Phase, PropState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CoopCarry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
