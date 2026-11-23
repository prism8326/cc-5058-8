/*
 * 无头逻辑测试：MockWorld 实现内核要求的 world 接口，
 * 在 Node 中直接驱动联合搬运内核，验证协议、姿态约束、幂等与裁决。
 * 运行：node tests/kernel.test.js
 */
'use strict';

const path = require('path');
const { CoopKernel, Phase, PropState } = require(path.join(__dirname, '..', 'js', 'kernel.js'));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
}
function section(name) { console.log(`\n[${name}]`); }

/**
 * 确定性模拟世界：
 *  - readyA/readyB 控制真实姿态是否满足接触点约束（不是全局布尔开关）
 *  - allowPlacement 控制道具当前位置是否有剩余空间
 *  - 支持在指定 tick 注入脱离/外部移动
 */
class MockWorld {
  constructor(opts = {}) {
    this.readyA = opts.readyA ?? true;
    this.readyB = opts.readyB ?? true;
    this.allowPlacement = opts.allowPlacement ?? true;
    this.destOccupied = opts.destOccupied ?? false;
    this.prop = { x: 100, y: 200, grounded: true };
    this.origin = { x: 100, y: 200 };
    this.slot = { x: 700, y: 200 };
    this.events = [];
    this.carryStarted = 0;
    this.rollbackStarted = 0;
    this.liftCalls = 0;
    this.atTick = {}; // tick -> fn(kernel, world)
  }

  agentPose(a) {
    const ready = a === 'A' ? this.readyA : this.readyB;
    return { x: 0, y: 0, ready, contactOK: ready, grip: { x: 0, y: 0 } };
  }
  canPlaceHere() { return this.allowPlacement; }
  propOrigin() { return { ...this.origin }; }
  propPosition() { return { ...this.prop }; }
  destinationOccupied() { return this.destOccupied; }

  startCarry() {
    this.carryStarted += 1;
    this.prop.grounded = false;
  }
  startRollback() { this.rollbackStarted += 1; }
  stopMotion() { /* no-op */ }
  placePropAt(x, y) { this.prop.x = x; this.prop.y = y; this.prop.grounded = true; this.destOccupied = true; }
  dropPropHere() { this.prop.grounded = true; }
  resetPropToOrigin() { this.prop = { ...this.origin, grounded: true }; }

  // 测试辅助：模拟共同搬运的物理推进
  advanceCarry(kernel, ticks = 200) {
    for (let i = 0; i < ticks; i++) {
      kernel.tick();
      if (kernel.phase === Phase.CARRYING && !this.prop.grounded) {
        this.prop.x = Math.min(this.slot.x, this.prop.x + 4);
      }
      const f = this.atTick[kernel.tickNo];
      if (f) f(kernel, this);
    }
  }
}

function runIdle(kernel, ticks) {
  for (let i = 0; i < ticks; i++) kernel.tick();
}

// 标准推进：发起 -> 双方 READY/COMMIT/FORCE
function bootstrap(kernel, world, leader = 'A') {
  kernel.start(leader);
  runIdle(kernel, 2);
  kernel.declareReady('A');
  kernel.declareReady('B');
  kernel.commit('A');
  kernel.commit('B');
  const fa = kernel.applyForce('A');
  const fb = kernel.applyForce('B');
  return { fa, fb };
}

/* ============ S1 标准协作全流程 ============ */
section('S1 标准协作：完整协议 -> 成功放置，目的地占用');
{
  const w = new MockWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 600 });
  const r = bootstrap(k, w);
  assert(r.fa.ok && r.fb.ok, '双方 FORCE 均被接受');
  assert(k.phase === Phase.CARRYING, '双方施力后进入 CARRYING');
  assert(w.prop.grounded === false, '道具处于抬起状态');
  assert(w.carryStarted === 1, 'startCarry 仅被调用一次');

  w.advanceCarry(k, 180);
  assert(w.prop.x === w.slot.x, '道具移动到目的地槽位');
  const relA = k.release('A');
  const relADup = k.release('A');
  assert(relA.ok && relADup.duplicate, '重复 RELEASE 幂等，不产生第二次放置');
  k.release('B');
  assert(k.phase === Phase.DONE, '双方 RELEASE 后 DONE');
  assert(k.propState === PropState.PLACED, '道具状态 PLACED');
  assert(w.destOccupied === true, '目的地标记为已占用');
  assert(w.prop.grounded === true, '道具已落地');
}

/* ============ S2 单方强抬必须被拒绝 ============ */
section('S2 启动条件：一方未承诺时另一方不能独自瞬移道具');
{
  const w = new MockWorld();
  const k = new CoopKernel(w);

  // 协作尚未发起
  const before = k.applyForce('A');
  assert(before.ok === false && before.code === 'SOLO_LIFT_BLOCKED',
    'IDLE 阶段单方施力被拒（SOLO_LIFT_BLOCKED）');
  assert(w.prop.x === 100 && w.prop.grounded === true, '道具留在原地，未被瞬移');

  k.start('A');
  runIdle(k, 2);
  k.declareReady('A'); // 只有 A 就位，B 未 READY
  const solo = k.applyForce('A');
  assert(solo.ok === false && solo.code === 'SOLO_LIFT_BLOCKED',
    'PREPARING 阶段单方施力同样被拒');
  assert(w.prop.grounded === true, '道具仍在地面');

  // 目的地占用时不允许启动
  const w2 = new MockWorld({ destOccupied: true });
  const k2 = new CoopKernel(w2);
  const blocked = k2.start('A');
  assert(blocked.ok === false && blocked.code === 'DEST_OCCUPIED',
    '目的地占用时发起协作被拒绝');
  assert(k2.phase === Phase.IDLE, '阶段保持 IDLE');
}

/* ============ S3 延迟 + 重复消息：不重复施加抬升 ============ */
section('S3 消息可延迟/重复：去重且抬升效果只生效一次');
{
  const w = new MockWorld();
  const k = new CoopKernel(w, { prepWindow: 2000, commitWindow: 2000 });
  k.msgDelay = 20;
  k.duplicateEvery = 1; // 每条消息都复制一份
  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A');
  k.declareReady('B');
  k.commit('A');
  k.commit('B');

  // 延迟期间消息尚未投递，但协议状态由发送方动作落库，仍可推进
  assert(k.bus.length >= 8, '消息在总线中排队等待延迟投递');
  for (let i = 0; i < 30; i++) k.tick();
  assert(k.phase === Phase.COMMITTED, '延迟消息投递后双方承诺成立 -> COMMITTED');

  k.applyForce('A');
  k.applyForce('B');
  for (let i = 0; i < 30; i++) k.tick();
  assert(w.carryStarted === 1, '即使每条消息重复，抬升仅生效一次');
  assert(k.propState === PropState.LIFTED, '道具 LIFTED（无第二次抬升）');

  // 直接灌入同一 id 的重复投递
  const seenBefore = k._seen.size;
  k.handleDelivered({ id: 'dup-x1', from: 'A', to: 'B', type: 'FORCE',
    payload: { epoch: k.epoch }, epoch: k.epoch });
  k.handleDelivered({ id: 'dup-x1', from: 'A', to: 'B', type: 'FORCE',
    payload: { epoch: k.epoch }, epoch: k.epoch });
  assert(k._seen.size === seenBefore + 1, '相同消息 id 第二次被去重丢弃');

  // 过期 epoch 消息被丢弃
  const staleSeen = k._seen.size;
  k.handleDelivered({ id: 'old-1', from: 'A', to: 'B', type: 'FORCE',
    payload: {}, epoch: k.epoch - 1 });
  assert(k._seen.size === staleSeen, '旧 epoch 的消息不参与当前动作');
}

/* ============ S4 就位失败：姿态不满足不能宣告 READY，超时中止 ============ */
section('S4 就位失败：真实姿态不满足 -> READY 被拒 -> 准备窗口超时中止');
{
  const w = new MockWorld({ readyA: true, readyB: false }); // B 被障碍挡住
  const k = new CoopKernel(w, { prepWindow: 60 });
  k.start('A');
  runIdle(k, 2);
  const okA = k.declareReady('A');
  const badB = k.declareReady('B');
  assert(okA.ok, 'A 姿态满足，READY 接受');
  assert(badB.ok === false && badB.code === 'NOT_IN_POSITION',
    'B 接触点未满足，READY 被协议拒绝（不能假装就绪）');
  assert(k.attempt.B.ready === false, 'B 的就绪位保持 false');

  for (let i = 0; i < 70; i++) k.tick();
  assert(k.phase === Phase.ABORTED, '准备窗口超时 -> ABORTED');
  assert(k.propState === PropState.GROUNDED, '失败后道具回到地面原点');
  assert(w.prop.x === w.origin.x, '道具位置已复位');

  // 承诺时姿态突然偏离也必须中止
  const w2 = new MockWorld();
  const k2 = new CoopKernel(w2, { prepWindow: 400 });
  k2.start('A');
  runIdle(k2, 2);
  k2.declareReady('A'); k2.declareReady('B');
  w2.readyA = false; // A 在 COMMIT 前被撞离接触点
  const commitRes = k2.commit('A');
  assert(commitRes.ok === false && commitRes.code === 'LOST_POSTURE', '承诺时姿态偏离 -> LOST_POSTURE 中止');
  assert(k2.phase === Phase.ABORTED, '动作进入 ABORTED');
}

/* ============ S5 外部移动道具 ============ */
{
  section('S5 道具被外部移动：按阶段使承诺失效并复位');
  // 准备/承诺阶段：直接中止复位
  const w = new MockWorld();
  const k = new CoopKernel(w, { prepWindow: 500, commitWindow: 500 });
  k.start('A');
  runIdle(k, 2);
  k.declareReady('A'); k.declareReady('B');
  w.prop.x = 400; // 外部拖动
  k.externalMove({ x: 400, y: 200 });
  assert(k.phase === Phase.ABORTED, 'PREPARING 中外部移动 -> ABORTED');
  assert(w.prop.x === w.origin.x, '道具复位到原点');

  // 搬运阶段：外部移动触发失去支撑裁决（有空间 -> 就地放下）
  const w2 = new MockWorld({ allowPlacement: true });
  const k2 = new CoopKernel(w2, { prepWindow: 500, commitWindow: 500 });
  bootstrap(k2, w2);
  w2.advanceCarry(k2, 40);
  assert(k2.phase === Phase.CARRYING, '进入搬运后注入外部移动');
  w2.prop.x += 90;
  k2.externalMove({ x: w2.prop.x, y: 200 });
  assert(k2.phase === Phase.DONE, '外部移动导致支撑丢失并完成中断处理');
  assert(k2.propState === PropState.DROPPED, '有剩余空间 -> 就地放下 DROPPED');
}

/* ============ S6a 失去支撑：剩余空间足够 -> 就地放下 ============ */
section('S6a 失去一侧支撑：有剩余空间 -> 就地放下，不再移动');
{
  const w = new MockWorld({ allowPlacement: true });
  const k = new CoopKernel(w, { prepWindow: 500, commitWindow: 500 });
  bootstrap(k, w);
  w.advanceCarry(k, 50);
  const midX = w.prop.x;
  const r = k.loseSupport('B', '测试注入：B 脱离');
  assert(r.ok, '失去支撑被受理');
  assert(k.propState === PropState.DROPPED, '裁决为就地放下 DROPPED');
  assert(w.prop.x === midX, '道具停在中断位置，没有继续移动');
  assert(k.phase === Phase.DONE, '动作以中断结果 DONE 收尾');
  assert(w.rollbackStarted === 0, '有空间时不触发回滚');
}

/* ============ S6b 失去支撑：无空间 -> 共同回滚 -> 恢复搬运 ============ */
section('S6b 失去一侧支撑：无剩余空间 -> 共同回滚到抬起点');
{
  const w = new MockWorld({ allowPlacement: false });
  const k = new CoopKernel(w, { prepWindow: 500, commitWindow: 500, recoverTimeout: 300 });
  bootstrap(k, w);
  w.advanceCarry(k, 50);
  const farX = w.prop.x;
  assert(farX > w.origin.x + 50, '道具已离开抬起点');

  k.loseSupport('A', '测试注入：A 脱离');
  assert(k.phase === Phase.RECOVERING, '无空间 -> 进入 RECOVERING 共同回滚');
  assert(w.rollbackStarted === 1, '场景收到 startRollback 指令');
  assert(w.prop.grounded === false, '回滚期间道具仍被抬起，不能原地掉落');

  // 模拟回滚物理：道具回到原点
  for (let i = 0; i < 60; i++) {
    k.tick();
    if (k.phase === Phase.RECOVERING) {
      w.prop.x = Math.max(w.origin.x, w.prop.x - 5);
    }
  }
  assert(w.prop.x === w.origin.x, '道具回滚到抬起点');
  // 双方重新就位后内核恢复
  w.readyA = true; w.readyB = true;
  k.rollbackArrived();
  assert(k.phase === Phase.CARRYING, '回滚完成 -> 恢复 CARRYING');
  assert(w.carryStarted === 2, '恢复后第二次共同搬运启动（与首次抬升区分）');
}

/* ============ S6c 回滚超时 -> 紧急放下 ============ */
section('S6c 共同回滚超时未就位 -> 紧急放下');
{
  const w = new MockWorld({ allowPlacement: false });
  const k = new CoopKernel(w, { prepWindow: 500, commitWindow: 500, recoverTimeout: 40 });
  bootstrap(k, w);
  w.advanceCarry(k, 30);
  k.loseSupport('B', '测试注入');
  assert(k.phase === Phase.RECOVERING, '进入回滚');
  for (let i = 0; i < 60; i++) k.tick(); // 不触发 rollbackArrived
  assert(k.phase === Phase.DONE, '回滚超时 -> DONE');
  assert(k.propState === PropState.DROPPED, '紧急放下 DROPPED');
}

/* ============ S7 参与者认知：延迟下各自知道的阶段 ============ */
section('S7 调试认知模型：角色认知随消息更新，内核为权威阶段');
{
  const w = new MockWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  k.msgDelay = 10;
  k.start('A');
  const snap0 = k.debugSnapshot();
  assert(snap0.agents.every(s => s.knowsPhase === Phase.PREPARING),
    '发起后双方认知进入 PREPARING');
  runIdle(k, 2);
  k.declareReady('A');
  k.declareReady('B');
  k.commit('A');
  k.commit('B');
  // 消息延迟期间：内核权威已推进，但 B 收件箱里的 READY/COMMIT 可能尚未处理
  const snap = k.debugSnapshot();
  assert(snap.phase === Phase.COMMITTED, '内核权威阶段 COMMITTED');
  assert(snap.agents.length === 2 && snap.agents[0].pose, '快照包含两名角色真实姿态');
  for (let i = 0; i < 15; i++) k.tick();
  const snap2 = k.debugSnapshot();
  assert(snap2.agents.every(s => s.knowsPhase === Phase.COMMITTED),
    '延迟消息排空后双方认知与权威阶段一致');
}

/* ============ S8 主动中止 ============ */
section('S8 主动中止：动作复位且道具回原点');
{
  const w = new MockWorld();
  const k = new CoopKernel(w);
  k.start('B');
  runIdle(k, 2);
  k.declareReady('A');
  const r = k.abort('A', '情况变化');
  assert(r.ok, 'ABORT 被受理');
  assert(k.phase === Phase.ABORTED, '阶段 ABORTED');
  assert(w.prop.x === w.origin.x && w.prop.grounded, '道具复位且落地');
  const again = k.abort('A');
  assert(again.ok === false, '已结束的动作不能重复中止');
  // 中止后可以重新发起（新 epoch）
  const oldEpoch = k.epoch;
  const restart = k.start('A');
  assert(restart.ok && k.epoch === oldEpoch + 1, '复位后可重新发起，epoch 递增');
}

/* ============ 汇总 ============ */
console.log(`\n========================================`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('全部联合搬运内核用例通过');
