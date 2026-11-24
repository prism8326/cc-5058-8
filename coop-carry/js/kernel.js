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
 *            CANCELLING（货架撤走后收到取消回执，双方继续承重直至共同放下）
 *
 * 货架承重语义：
 *   - 抬起完成前，道具重量由货架承担（shelfPresent === true），
 *     双方即使握住把手，握点载荷仍为 0。
 *   - 双方 FORCE 齐备的那一刻撤走货架（shelfPresent = false），重量转移给两个握点，
 *     物权由 SHELF 转给 PAIR —— 每个 epoch 只发生一次（幂等）。
 *
 * 取消回执语义：
 *   - 取消是请求 + 回执的握手。请求方先松手，另一方的 CANCEL 回执由消息
 *     总线延迟投递；回执到达时按“重量是否已在握点上”裁决：
 *       · 未抬起（货架/地面承重）-> 双方松手，道具不落地（ABORTED）；
 *       · 已抬起且回执齐备 -> 双人共同放下（DROPPED）；
 *       · 已抬起但仅单方回执 -> 另一方独自承重（保持 LIFTED，SINGLE），绝不坠落。
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
    CANCELLING: 'CANCELLING',
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

  // 谁在承担道具重量；SHELF 货架，PAIR 两只握点，SINGLE 仅剩一只握点，GROUND 已落地
  const Support = Object.freeze({
    SHELF: 'SHELF',
    PAIR: 'PAIR',
    SINGLE: 'SINGLE',
    GROUND: 'GROUND',
  });

  // 物权：抬起前归货架，双人抬起后归双方，落地后交给地面/目的地
  const Ownership = Object.freeze({
    SHELF: 'SHELF',
    PAIR: 'PAIR',
    GROUND: 'GROUND',
  });

  const WEIGHT = 1; // 归一化重量，双人各承担 0.5

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
      this._audit = [];
      this._propTransitions = [];
      this._trace = [];
      this._newAttempt();
      this._resetPhysics();
      this._setPhase(Phase.IDLE, true);
      this._setPropState(PropState.GROUNDED, true);
    }

    /* 身体之外的物理事实：谁在承载、各握点多重的载荷、物权归谁。
     * 与 phase 字符串相互独立，供审计做交叉判据。 */
    _resetPhysics() {
      this.shelfPresent = true;
      this.support = Support.SHELF;
      this.ownership = Ownership.SHELF;
      this.gripLoads = { A: 0, B: 0 };
      this.ownershipLog = [];
      this.cancel = null;
      this._epochTransferDone = false;
      this._transfersThisEpoch = 0;
      this._clientObs = { A: [], B: [] };
    }

    _newAttempt() {
      const mk = () => ({
        pose: null,
        ready: false,
        committed: false,
        forced: false,
        released: false,
        knowledge: {
          phase: Phase.IDLE,
          prop: PropState.GROUNDED,
          ownership: Ownership.SHELF,
          cancelled: false,
        },
        attached: false,
      });
      this.attempt = { A: mk(), B: mk(), origin: null, leader: null, startedAt: 0 };
    }

    /* 记录一次审计问题；同一 code 默认只保留一次，避免重复噪声。 */
    _auditError(code, detail, onceKey) {
      const key = onceKey || code;
      if (this._audit.some(e => e.key === key)) return;
      this._audit.push({ key, code, detail, at: this.tickNo, epoch: this.epoch });
      this.emit('audit:error', { code, detail });
    }

    auditIssues() { return this._audit.map(e => ({ ...e })); }

    /* 独立判据 1：道具的“姿态事实”。刻意不复述 phase，而给出支撑面、物权、
     * 两握点载荷与落地位姿，供调用方拿它与自己的参照模型交叉核对。 */
    propPose() {
      return {
        epoch: this.epoch,
        pos: this.world.propPosition(),
        state: this.propState,
        support: this.support,
        shelfPresent: this.shelfPresent,
        ownership: this.ownership,
        loads: { A: this.gripLoads.A, B: this.gripLoads.B },
        attached: { A: this.attempt.A.attached, B: this.attempt.B.attached },
      };
    }

    /* 独立判据 2：某角色在当前阶段“有没有资格”执行每种动作。
     * 只由阶段与角色协议位推导，绝不回读界面上显示的状态串。 */
    phaseEligibility(a) {
      const st = this.attempt[a];
      const ph = this.phase;
      return {
        phase: ph,
        expectedProp: CoopKernel.PROP_FOR_PHASE[ph] || null,
        canReady: ph === Phase.PREPARING && !st.ready,
        canCommit: ph === Phase.PREPARING && st.ready && !st.committed,
        canForce: (ph === Phase.COMMITTED || ph === Phase.LIFTING) && !st.forced,
        canRelease: ph === Phase.CARRYING || ph === Phase.PLACING,
        canCancel: !(ph === Phase.IDLE || ph === Phase.DONE || ph === Phase.ABORTED),
      };
    }

    /* 两客户端各自观察到的物权转移序列（共享道具的权属是同一个事实，
     * 每个客户端都应在自己的视图里看到且只看到一次 “SHELF->PAIR”）。 */
    clientOwnershipLog(a) { return (this._clientObs[a] || []).map(e => ({ ...e })); }

    /* 受控错误注入：仅用于验收，故意制造非法事实，随后必须由
     * auditInvariants()/审计记录捕获，而不是被悄悄吞掉。 */
    faultInject(kind) {
      if (kind === 'double_transfer') {
        this._setOwnership(Ownership.PAIR, 'FAULT_DOUBLE');
        this._setOwnership(Ownership.SHELF, 'FAULT_RESET');
        this._setOwnership(Ownership.PAIR, 'FAULT_DOUBLE_AGAIN');
      } else if (kind === 'prop_wrong_phase') {
        // 在错误阶段直接伪造道具姿态：审计必须拒绝，姿态判据也须暴露
        this._checkPropTransition(PropState.GROUNDED, PropState.LIFTED);
        this.propState = PropState.LIFTED;
      } else if (kind === 'pair_one_hand') {
        this.support = Support.PAIR;
        this.gripLoads = { A: WEIGHT / 2, B: WEIGHT / 2 };
        this.attempt.B.attached = false;
      }
      return { ok: true, kind };
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
      this._resetPhysics();
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
        this._raiseProp();
        this._setPhase(Phase.CARRYING);
        this.emit('lift:done', { epoch: this.epoch });
      }
      return { ok: true };
    }

    /* 唯一的抬升生效点：货架撤走 -> 物权转给双人 -> 双握点各承担一半。
     * 每个 epoch 只允许一次；重复调用视为幂等，不再转移物权。 */
    _raiseProp() {
      const alreadyLifted = this.propState === PropState.LIFTED ||
        this.propState === PropState.PLACED;
      if (this._epochTransferDone || alreadyLifted) return;
      this._epochTransferDone = true;
      this.shelfPresent = false;
      this.support = Support.PAIR;
      this._setOwnership(Ownership.PAIR, 'LIFT');
      this.gripLoads = { A: WEIGHT / 2, B: WEIGHT / 2 };
      this._setPropState(PropState.LIFTED);
      this.world.startCarry();
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

    /* ---------------- 取消握手（request + receipt） ---------------- */
    /* 取消请求：请求方立刻松手，另一方的 CANCEL 回执经总线延迟投递。
     * 每个回执到达时按“重量是否已在握点上”裁决，因此可以把撤销时点分别落在：
     *   · 刚握住把手（未抬起）-> 双方松手，重量仍由货架承担，道具不落地；
     *   · 货架已撤走（双人已承重）-> 双方共同放下，或未齐回执时继续承重。 */
    requestCancel(by) {
      if (this.phase === Phase.IDLE || this.phase === Phase.DONE ||
          this.phase === Phase.ABORTED) {
        return this._reject('CANCEL_WRONG_PHASE', `${by} 取消被拒：当前阶段 ${this.phase}`);
      }
      if (this.cancel) return { ok: true, duplicate: true };
      const other = by === 'A' ? 'B' : 'A';
      this.cancel = {
        by, other,
        receipts: [],
        startedAt: this.tickNo,
      };
      // 请求方脱手；裁决在 _settleCancelFor 内完成（含 released/attached 落库）
      this.emit('cancel:request', { by, epoch: this.epoch });
      this._settleCancelFor(by);
      // 另一方的回执由总线延迟投递：投递到 to 时视作 to 的回执
      this._send(by, other, 'CANCEL', { epoch: this.epoch, by });
      return { ok: true };
    }

    _releaseHand(a) {
      const st = this.attempt[a];
      st.released = true;
      st.attached = false;
    }

    /* 每个回执到达只处理一次；重复回执直接丢弃，绝不二次施加。
     * 裁决依据是“重量是否已在握点上”这一物理事实，不回读 support 字符串。 */
    _settleCancelFor(by) {
      if (!this.cancel) return;
      if (this.phase === Phase.DONE || this.phase === Phase.ABORTED) return;
      if (this.cancel.receipts.includes(by)) return;
      this.cancel.receipts.push(by);
      this._releaseHand(by);
      this.emit('cancel:receipt', { by });

      const bothAcked = this.cancel.receipts.length >= 2;
      // 裁决依据：重量是否已经落在握点上（等价于“货架已撤走且已抬起”）。
      // 未抬起时即便手动撤走货架，重量仍在地面/货架上，取消不涉及双人承重。
      const weightOnHands = this.propState === PropState.LIFTED ||
        this.support === Support.PAIR || this.support === Support.SINGLE;

      if (!weightOnHands) {
        // 重量尚未交给握点：松手不落地，按货架/地面承重收尾
        this._applyPreLiftCancel();
        return;
      }
      if (bothAcked) {
        this._cooperativeDrop('货架已撤走且双方回执齐备');
      } else {
        // 仅单方回执：另一方仍在承重，继续托住整重，绝不让道具掉落
        this._setPhase(Phase.CANCELLING);
        const holder = this.agents.find(a => !this.cancel.receipts.includes(a));
        this.support = Support.SINGLE;
        this.gripLoads = { A: 0, B: 0 };
        if (holder) this.gripLoads[holder] = WEIGHT;
        this.emit('cancel:hold', { awaiting: holder });
      }
    }

    _applyPreLiftCancel() {
      // 重量尚未交给握点：松手不落地，道具回到原位、仍由货架/地面承担
      this.world.stopMotion();
      this.gripLoads = { A: 0, B: 0 };
      this.support = Support.SHELF;
      // shelfPresent 保持真实值（测试台可能已手动撤走货架），不在此处伪造
      this._setOwnership(Ownership.SHELF, 'CANCEL_BEFORE_LIFT');
      this._setPropState(PropState.GROUNDED);
      for (const a of this.agents) this.attempt[a].attached = false;
      this._watchdog = null;
      this._setPhase(Phase.ABORTED);
      this.emit('cancel:done', { result: 'CANCELLED_ON_SHELF', shelfLoaded: true });
      this.emit('attempt:done', { result: 'CANCELLED_ON_SHELF', prop: this.propState,
        at: this.world.propPosition() });
    }

    _cooperativeDrop(reason) {
      this.world.stopMotion();
      this.world.dropPropHere();
      this._setOwnership(Ownership.GROUND, reason);
      this.support = Support.GROUND;
      this.gripLoads = { A: 0, B: 0 };
      this._setPropState(PropState.DROPPED);
      for (const a of this.agents) this.attempt[a].attached = false;
      this._watchdog = null;
      this.emit('cancel:done', { result: 'CANCELLED_COOPERATIVE_DROP', shelfLoaded: false });
      this.emit('arbitration', {
        verdict: 'CANCELLED_COOPERATIVE_DROP', reason,
        detail: '货架已撤走，收到取消后双方共同放下',
      });
      this._finishAfterInterrupt('CANCELLED_COOPERATIVE_DROP');
    }

    /* 由测试台拖动决定“撤销时点”，显式撤走或放回货架 */
    setShelf(present) {
      const was = this.shelfPresent;
      this.shelfPresent = !!present;
      if (this.shelfPresent) {
        // 货架重新承托：仅在仍在地面/未抬起时一致
        if (this.support === Support.GROUND) this.support = Support.SHELF;
      }
      this.emit('shelf:change', { present: this.shelfPresent, was });
      return { ok: true, present: this.shelfPresent };
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
      // 失支撑即有一只握点离开：不再可能由双人承重
      if (this.support === Support.PAIR) {
        const holder = a === 'A' ? 'B' : 'A';
        this.support = Support.SINGLE;
        this.gripLoads = { A: 0, B: 0 };
        this.gripLoads[holder] = WEIGHT;
      }

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
        case 'CANCEL':
          // 取消回执：到达时按“此刻货架是否仍在”裁决（幂等）
          if (this.cancel && this.cancel.receipts.includes(m.to)) break;
          this._settleCancelFor(m.to);
          break;
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
      const from = this.phase;
      if (!silent && from !== p) this._checkPhaseTransition(from, p);
      this.phase = p;
      for (const a of this.agents) {
        this.attempt[a].knowledge.phase = p;
      }
      if (!silent && from !== p) this._trace.push({ epoch: this.epoch, tick: this.tickNo,
        kind: 'phase', from, to: p });
      if (!silent) this.emit('phase:change', { phase: p, from });
    }

    _checkPhaseTransition(from, to) {
      const legal = CoopKernel.LEGAL_PHASE_TRANSITIONS;
      const allowed = legal[from] || [];
      if (!allowed.includes(to)) {
        this._auditError('ILLEGAL_PHASE_TRANSITION',
          `阶段 ${from} -> ${to} 不在合法转移表中`, 'ILLEGAL_PHASE:' + from + '>' + to);
      }
    }

    _setPropState(s, silent) {
      const from = this.propState;
      if (!silent && from !== s) this._checkPropTransition(from, s);
      this.propState = s;
      for (const a of this.agents) {
        this.attempt[a].knowledge.prop = s;
      }
      if (!silent && from !== s) {
        this._propTransitions.push({ epoch: this.epoch, tick: this.tickNo, from, to: s,
          phase: this.phase });
        this._trace.push({ epoch: this.epoch, tick: this.tickNo, kind: 'prop', from, to: s,
          phase: this.phase });
      }
      if (!silent) this.emit('prop:state', { state: s, from });
    }

    /* 道具姿态只能由合法阶段驱动：这是独立于 phase 字符串的硬约束 */
    _checkPropTransition(from, to) {
      const legal = CoopKernel.LEGAL_PROP_DRIVERS[from + '>' + to];
      const phase = this.phase;
      if (!legal) {
        this._auditError('ILLEGAL_PROP_TRANSITION',
          `道具 ${from} -> ${to} 不是受支持的转移`, 'ILLEGAL_PROP:' + from + '>' + to);
        return;
      }
      if (!legal.includes(phase)) {
        this._auditError('PROP_DRIVEN_BY_WRONG_PHASE',
          `道具 ${from} -> ${to} 发生在 ${phase}，合法阶段应为 ${legal.join('/')}`,
          'PROP_PHASE:' + from + '>' + to + '@' + phase);
      }
    }

    _setOwnership(next, reason) {
      if (this.ownership === next) return;
      const from = this.ownership;
      this.ownership = next;
      const entry = { epoch: this.epoch, tick: this.tickNo, from, to: next, reason,
        phase: this.phase };
      this.ownershipLog.push(entry);
      this._trace.push({ epoch: this.epoch, tick: this.tickNo, kind: 'ownership', from, to: next,
        reason, phase: this.phase });
      // 两个客户端各自看到同一次物权转移（共享道具的权属是同一事实）
      this._clientObs.A.push({ ...entry, seenBy: 'A' });
      this._clientObs.B.push({ ...entry, seenBy: 'B' });
      for (const a of this.agents) {
        this.attempt[a].knowledge.ownership = next;
      }
      // 物权转给双人只能由“双人抬升生效点”驱动，且每 epoch 至多一次
      if (next === Ownership.PAIR) {
        this._transfersThisEpoch += 1;
        if (!['LIFTING', 'CARRYING'].includes(this.phase)) {
          this._auditError('OWNERSHIP_WRONG_PHASE',
            `物权在 ${this.phase} 转给双人，合法阶段应为 LIFTING/CARRYING`,
            'OWNERSHIP_PHASE:' + this.phase);
        }
        if (this._transfersThisEpoch > 1) {
          this._auditError('OWNERSHIP_DOUBLE_TRANSFER',
            '同一 epoch 内物权被重复转移给双人', 'OWNERSHIP_DOUBLE');
        }
      }
      this.emit('ownership:change', { from, to: next, reason, phase: this.phase });
    }

    /* 独立不变量审计：不依赖 phase 字符串自洽，而用物理事实互相校验。
     * 返回问题列表；空数组表示“共同道具只被合法阶段驱动、载荷与物权一致”。 */
    auditInvariants() {
      const problems = [];
      const add = (code, detail) => problems.push({ code, detail });

      // 1) 重量守恒：双人承重时两握点载荷之和必须等于整重
      const loadSum = this.gripLoads.A + this.gripLoads.B;
      if (this.support === Support.PAIR && Math.abs(loadSum - WEIGHT) > 1e-9) {
        add('PAIR_LOAD_SUM', `双人承重时握点载荷和=${loadSum}，应为 ${WEIGHT}`);
      }
      // 2) 货架在场时握点不应承担重量
      if (this.shelfPresent && this.support === Support.PAIR) {
        add('SHELF_PAIR_CONFLICT', '货架仍在场却声称由双人承重');
      }
      // 3) 权属与承重必须一致：物权归双人时至少有一只握点在承重，
      //    物权归货架时重量必须在货架上，交给地面后不得仍被托住。
      if (this.ownership === Ownership.PAIR &&
          !(this.support === Support.PAIR || this.support === Support.SINGLE)) {
        add('OWNERSHIP_SUPPORT_MISMATCH',
          `物权归双人但承重=${this.support}，不在任一握点上`);
      }
      if (this.ownership === Ownership.SHELF && this.support !== Support.SHELF) {
        add('OWNERSHIP_SHELF_MISMATCH', `物权归货架但承重=${this.support}`);
      }
      if (this.ownership === Ownership.GROUND && this.support !== Support.GROUND) {
        add('OWNERSHIP_GROUND_MISMATCH', `物权已交给地面但承重=${this.support}`);
      }
      // 4) 抬起后凡由双人承重，则两只握点都必须附着（单方脱手即失重）
      if (this.support === Support.PAIR) {
        for (const a of this.agents) {
          if (!this.attempt[a].attached) {
            add('LIFTED_ONE_HAND', `${a} 已松手但道具仍声称双人承重`);
          }
        }
      }
      // 4b) SINGLE 承重时，整重必须落在唯一仍附着的握点上
      if (this.support === Support.SINGLE) {
        const holders = this.agents.filter(a => this.attempt[a].attached);
        if (holders.length !== 1) {
          add('SINGLE_HOLDER_COUNT', `单方承重时附着握点数=${holders.length}，应为 1`);
        } else if (Math.abs(this.gripLoads[holders[0]] - WEIGHT) > 1e-9) {
          add('SINGLE_LOAD', `单方承重者载荷=${this.gripLoads[holders[0]]}，应为整重`);
        }
      }
      // 5) 物权转移次数：每个 epoch 至多一次转给双人
      const pairTransfers = this.ownershipLog.filter(e => e.to === Ownership.PAIR &&
        e.epoch === this.epoch).length;
      if (pairTransfers > 1) {
        add('OWNERSHIP_TRANSFER_COUNT', `本 epoch 物权转给双人 ${pairTransfers} 次，应为 1`);
      }
      // 6) 已落地的道具不得再声称被抬起
      if ((this.propState === PropState.PLACED || this.propState === PropState.DROPPED) &&
          this.support === Support.PAIR) {
        add('GROUNDED_WITH_LIFT_LOAD', `道具 ${this.propState} 却仍由握点承重`);
      }
      return problems;
    }

    _finishPlacement() {
      this._setPhase(Phase.PLACING);
      const at = this.world.propPosition();
      this.world.placePropAt(at.x, at.y);
      this._setPropState(PropState.PLACED);
      this._setOwnership(Ownership.GROUND, 'PLACED');
      this.support = Support.GROUND;
      this.gripLoads = { A: 0, B: 0 };
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
      this._setOwnership(Ownership.GROUND, 'EMERGENCY_DROP');
      this.support = Support.GROUND;
      this.gripLoads = { A: 0, B: 0 };
      this._setPropState(PropState.DROPPED);
      this.emit('arbitration', { verdict: 'EMERGENCY_DROP', reason });
      this._finishAfterInterrupt('EMERGENCY_DROP');
    }

    _failAttempt(code, detail) {
      this.world.stopMotion();
      this.world.resetPropToOrigin();
      for (const a of this.agents) this.attempt[a].attached = false;
      this.shelfPresent = true;
      this.support = Support.SHELF;
      this._setOwnership(Ownership.SHELF, 'FAIL:' + code);
      this.gripLoads = { A: 0, B: 0 };
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

  /* 合法阶段转移表；显式声明，供审计独立校验（不依赖状态机自证）。 */
  CoopKernel.LEGAL_PHASE_TRANSITIONS = Object.freeze({
    IDLE: ['PREPARING'],
    PREPARING: ['COMMITTED', 'ABORTED'],
    COMMITTED: ['LIFTING', 'ABORTED'],
    LIFTING: ['CARRYING', 'ABORTED'],
    CARRYING: ['PLACING', 'RECOVERING', 'CANCELLING', 'DONE'],
    RECOVERING: ['CARRYING', 'DONE', 'ABORTED'],
    CANCELLING: ['DONE', 'ABORTED'],
    PLACING: ['DONE', 'ABORTED'],
    DONE: ['PREPARING'],
    ABORTED: ['PREPARING'],
  });

  /* 道具姿态转移 -> 允许驱动它的阶段集合。非法组合会被审计记录。 */
  CoopKernel.LEGAL_PROP_DRIVERS = Object.freeze({
    'GROUNDED>LIFTED': ['LIFTING'],
    'LIFTED>PLACED': ['PLACING'],
    'LIFTED>DROPPED': ['PLACING', 'RECOVERING', 'CARRYING', 'CANCELLING'],
    'LIFTED>GROUNDED': ['PREPARING', 'COMMITTED', 'LIFTING', 'CARRYING', 'RECOVERING',
      'CANCELLING', 'PLACING'],
    'DROPPED>GROUNDED': ['PREPARING', 'COMMITTED', 'LIFTING', 'CARRYING', 'RECOVERING',
      'CANCELLING', 'PLACING'],
  });

  /* 每个阶段道具“应有”的姿态；供独立对照，而不是从 propState 自证。 */
  CoopKernel.PROP_FOR_PHASE = Object.freeze({
    IDLE: PropState.GROUNDED,
    PREPARING: PropState.GROUNDED,
    COMMITTED: PropState.GROUNDED,
    LIFTING: PropState.LIFTED,
    CARRYING: PropState.LIFTED,
    RECOVERING: PropState.LIFTED,
    CANCELLING: PropState.LIFTED,
    PLACING: null,
    DONE: null,
    ABORTED: PropState.GROUNDED,
  });

  const api = { CoopKernel, Phase, PropState, Support, Ownership, WEIGHT };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CoopCarry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
