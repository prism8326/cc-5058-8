/*
 * 角色状态与物件轨迹测试（取消 + 承重 + 物权）
 * ------------------------------------------------------------------
 * 覆盖需求：
 *  - 为两角色就位、抬升、放置建立“状态轨迹”，并注入任一角色迟到与动作失败；
 *  - 拖动取消事件：取消发生在两人刚握住把手时，重量仍由货架承担；
 *  - 把取消推迟到货架已撤走，同一份回执必须触发双人放下或继续承重；
 *  - 用“物件支撑面”和“握点载荷”作独立判据（不回读 phase 字符串）；
 *  - 重复提交、任意丢弃迟到确认各暴露一次错误。
 * 运行：node tests/cancel.trajectory.test.js
 */
'use strict';

const path = require('path');
const {
  CoopKernel, Phase, PropState, Support, Ownership, WEIGHT,
} = require(path.join(__dirname, '..', 'js', 'kernel.js'));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
}
function section(name) { console.log(`\n[${name}]`); }

/* 可编排的世界：姿态、空间、道具坐标都可控，并记录调用次数以审计“效果只施加一次” */
class TrackWorld {
  constructor(opts = {}) {
    this.ready = { A: opts.readyA ?? true, B: opts.readyB ?? true };
    this.allowPlacement = opts.allowPlacement ?? true;
    this.destOccupied = false;
    this.prop = { x: 100, y: 200, grounded: true };
    this.origin = { x: 100, y: 200 };
    this.carryStarts = 0;
    this.placeCalls = 0;
    this.dropCalls = 0;
    this.resetCalls = 0;
  }
  agentPose(a) {
    const ok = this.ready[a];
    return { x: 0, y: 0, ready: ok, contactOK: ok, grip: { x: 0, y: 0 } };
  }
  canPlaceHere() { return this.allowPlacement; }
  propOrigin() { return { ...this.origin }; }
  propPosition() { return { ...this.prop }; }
  destinationOccupied() { return this.destOccupied; }
  startCarry() { this.carryStarts += 1; this.prop.grounded = false; }
  startRollback() {}
  stopMotion() {}
  placePropAt(x, y) {
    this.placeCalls += 1;
    this.prop.x = x; this.prop.y = y; this.prop.grounded = true; this.destOccupied = true;
  }
  dropPropHere() { this.dropCalls += 1; this.prop.grounded = true; }
  resetPropToOrigin() { this.resetCalls += 1; this.prop = { ...this.origin, grounded: true }; }
}

/* 把双方推进到“刚握住把手”（COMMITTED，尚未施力抬起），此时货架仍在承重 */
function toGrip(kernel, world, { lateAgent = null, lateDelay = 0 } = {}) {
  kernel.start('A');
  for (let i = 0; i < 2; i++) kernel.tick();
  for (const a of ['A', 'B']) {
    if (a === lateAgent) {
      // 迟到：先不声明就绪，稍后补上
      continue;
    }
    kernel.declareReady(a);
    kernel.commit(a);
  }
  return kernel;
}

function finishGrip(kernel, lateAgent, world) {
  // 迟到角色现在才就位并承诺
  kernel.declareReady(lateAgent);
  kernel.commit(lateAgent);
}

function bootstrapToCarry(world, opts = {}) {
  const k = new CoopKernel(world, { prepWindow: 900, commitWindow: 900, ...opts });
  k.start('A');
  for (let i = 0; i < 2; i++) k.tick();
  k.declareReady('A'); k.declareReady('B');
  k.commit('A'); k.commit('B');
  const fa = k.applyForce('A');
  const fb = k.applyForce('B');
  return { k, fa, fb };
}

/* ============================================================
 * T1 状态轨迹：两角色就位 / 抬升 / 放置，注入任一角色迟到
 * ============================================================ */
section('T1 角色状态轨迹：B 迟到不影响协议顺序，道具只被合法阶段驱动');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  // 记录每个角色与道具的轨迹（阶段、就绪、施力、姿态）
  const trace = [];
  k.on((type, d) => trace.push({ type, d, phase: k.phase }));

  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A');
  k.commit('A');
  // 关键：B 迟到 —— 尚未 READY，内核不得推进到 COMMITTED
  assert(k.phase === Phase.PREPARING, 'A 已就绪/承诺，但 B 迟到 -> 仍停在 PREPARING');
  assert(k.attempt.B.ready === false, 'B 的就绪位为 false');

  // 迟到注入：把 B 的就位推迟若干 tick，直至 A 的准备窗口仍有余量
  for (let i = 0; i < 20; i++) k.tick();
  assert(k.phase === Phase.PREPARING, '迟到期间阶段未跃迁');

  k.declareReady('B');
  k.commit('B');
  assert(k.phase === Phase.COMMITTED, 'B 补齐后进入 COMMITTED');
  k.applyForce('A');
  assert(w.carryStarts === 0, '单方施力不触发抬升');
  assert(k.propPose().support === Support.SHELF, '单方施力时仍由货架承重');
  k.applyForce('B');
  assert(w.carryStarts === 1, '双方施力后抬升一次');
  assert(k.propPose().support === Support.PAIR, '抬升后由双握点承重');
  assert(k.propPose().ownership === Ownership.PAIR, '抬升后物权归双人');

  // 放置：双方松手
  k.release('A'); k.release('B');
  assert(k.phase === Phase.DONE && w.placeCalls === 1, '双方松手后完成放置一次');
  assert(k.propPose().support === Support.GROUND, '放置后由地面承重');

  const phaseSeq = trace.filter(t => t.type === 'phase:change').map(t => t.d.phase);
  const order = [Phase.PREPARING, Phase.COMMITTED, Phase.LIFTING, Phase.CARRYING, Phase.PLACING,
    Phase.DONE];
  let cursor = 0;
  for (const p of phaseSeq) {
    while (cursor < order.length && order[cursor] !== p) cursor += 1;
    assert(cursor < order.length, `阶段 ${p} 出现在合法顺序中`);
  }
  assert(k.auditInvariants().length === 0, '标准轨迹无任何不变量违规');
}

/* ============================================================
 * T2 动作失败注入：迟到角色到准备窗口超时仍不就位 -> 中止且道具未动
 * ============================================================ */
section('T2 动作失败注入：迟到者超时 -> READY_TIMEOUT 中止，道具未被抬起');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 40, commitWindow: 900 });
  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A');
  k.commit('A');
  // B 始终迟到：不 READY
  for (let i = 0; i < 60; i++) k.tick();
  assert(k.phase === Phase.ABORTED, '准备窗口超时 -> ABORTED');
  assert(w.carryStarts === 0, '从未抬升');
  assert(k.propPose().support === Support.SHELF, '失败后重量仍由货架承担');
  assert(k.propPose().ownership === Ownership.SHELF, '失败后物权仍归货架');
  assert(w.prop.grounded === true, '道具落地未抬起');
  assert(k.auditInvariants().length === 0, '失败路径不产生不变量违规');
}

/* ============================================================
 * T3 取消发生在刚握住把手：重量仍由货架承担，道具不落地
 * ============================================================ */
section('T3 拖动取消：两人刚握住把手时取消，重量仍由货架承担');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  k.msgDelay = 5; // 取消回执延迟投递，模拟拖动/网络
  toGrip(k, w);
  // 双方就位承诺后，尚未施力：货架仍在
  assert(k.phase === Phase.COMMITTED, '停在 COMMITTED（刚握住把手，未抬起）');
  const beforePose = k.propPose();
  assert(beforePose.support === Support.SHELF, '取消前由货架承重');
  assert(beforePose.loads.A === 0 && beforePose.loads.B === 0, '取消前两握点载荷为 0');

  const r = k.requestCancel('A');
  assert(r.ok, '取消请求被受理');
  // 请求方自己的回执立刻裁决：货架仍在 -> 就地取消
  assert(k.phase === Phase.ABORTED, '取消后 ABORTED（货架承重）');
  assert(w.dropCalls === 0, '道具没有被放下（始终在货架上）');
  const pose = k.propPose();
  assert(pose.support === Support.SHELF, '取消后仍由货架承重');
  assert(pose.ownership === Ownership.SHELF, '取消后物权归货架');
  assert(pose.loads.A === 0 && pose.loads.B === 0, '取消后两握点载荷保持 0');
  assert(pose.state === PropState.GROUNDED, '道具仍在货架原位（GROUNDED）');

  // 另一方的回执延迟到达：对象已在 ABORTED，不得二次施加
  for (let i = 0; i < 10; i++) k.tick();
  assert(w.dropCalls === 0, '迟到的取消回执不造成下落');
  assert(k.auditInvariants().length === 0, '货架上取消无不变量违规');
}

/* ============================================================
 * T4 取消推迟到货架已撤走：同一回执 -> 双人放下
 * ============================================================ */
section('T4 取消推迟到货架已撤走：同一回执触发双人共同放下');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  k.msgDelay = 6;
  const { k: kk } = bootstrapToCarry(w);
  // 上面 bootstrapToCarry 已把道具抬起（货架撤走）
  assert(kk.propPose().support === Support.PAIR, '货架已撤走，双握点承重');
  const loadsBefore = kk.propPose().loads;
  assert(Math.abs(loadsBefore.A - WEIGHT / 2) < 1e-9 &&
    Math.abs(loadsBefore.B - WEIGHT / 2) < 1e-9, '货架撤走后两握点各承一半');

  // 用真正的内核（相同 init 才会延迟投递）。这里直接用 kk。
  const before = kk.propPose();
  const r = kk.requestCancel('A');
  assert(r.ok, '取消请求受理');
  // 请求方回执到达时货架已不在：单方回执 -> 继续承重（尚不能放下）
  assert(kk.phase === Phase.CANCELLING, '单方回执 -> CANCELLING（另一方继续承重）');
  const mid = kk.propPose();
  assert(mid.support === Support.SINGLE, '仅剩一方承重（SINGLE）');
  assert(mid.loads.B === WEIGHT, '仍在握的 B 独自承担整重');
  assert(mid.loads.A === 0, '已松手的 A 载荷为 0');
  assert(mid.ownership === Ownership.PAIR, '此时物权仍在双人（未交给地面）');
  assert(mid.state === PropState.LIFTED, '道具保持 LIFTED，没有掉落');
  assert(w.dropCalls === 0, '单方回执尚未放下');

  // 第二份回执（延迟到达）-> 双人共同放下
  for (let i = 0; i < 12; i++) kk.tick();
  assert(w.dropCalls === 1, '双方回执齐备 -> 恰好放下一次');
  const after = kk.propPose();
  assert(after.support === Support.GROUND, '放下后由地面承重');
  assert(after.ownership === Ownership.GROUND, '放下后物权交给地面');
  assert(after.loads.A === 0 && after.loads.B === 0, '放下后两握点载荷归零');
  assert(after.state === PropState.DROPPED, '道具 DROPPED');
  assert(kk.auditInvariants().length === 0, '共同放下路径无不变量违规');
  assert(before.support === Support.PAIR, '（对照）取消前确为双人承重');
}

/* ============================================================
 * T5 同一份回执被“任意丢弃”：只到一份 -> 必须继续承重而非坠落
 * ============================================================ */
section('T5 丢弃迟到确认：只保留单方回执时继续承重，不伪报放下');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A'); k.declareReady('B');
  k.commit('A'); k.commit('B');
  k.applyForce('A'); k.applyForce('B');
  assert(k.propPose().support === Support.PAIR, '已抬起，双人承重');

  k.requestCancel('B');
  // 不投递另一方的回执（模拟“任意丢弃”）：持续推进 tick，但清空总线里该回执
  const cancelledReceipts = k.bus.filter(m => m.type === 'CANCEL');
  k.bus = k.bus.filter(m => m.type !== 'CANCEL');
  assert(cancelledReceipts.length === 1, '另一方的取消回执确实在总线中');
  for (let i = 0; i < 30; i++) k.tick();
  assert(w.dropCalls === 0, '缺少第二份回执时绝不放下');
  const pose = k.propPose();
  assert(pose.state === PropState.LIFTED, '道具仍被托住（LIFTED）');
  assert(pose.support === Support.SINGLE && pose.loads.A === WEIGHT,
    '未回执的 A 独自承担整重，绝不坠落');
  assert(k.phase === Phase.CANCELLING, '停格在 CANCELLING，等待第二份回执');
  assert(k.auditInvariants().length === 0, '缺回执的继续承重无不变量违规');

  // 补上第二份回执（重新投递）-> 才共同放下
  k._settleCancelFor('A');
  assert(w.dropCalls === 1, '第二份回执到达后才放下一次');
  assert(k.propPose().ownership === Ownership.GROUND, '物权随放下交给地面');
}

/* ============================================================
 * T6 重复提交：重复取消回执只产生一次放下
 * ============================================================ */
section('T6 重复提交：重复的取消回执只暴露一次错误、只放下一次');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  k.duplicateEvery = 1; // 每条消息都复制一份，制造重复回执
  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A'); k.declareReady('B');
  k.commit('A'); k.commit('B');
  k.applyForce('A'); k.applyForce('B');
  k.requestCancel('A');
  for (let i = 0; i < 20; i++) k.tick();
  assert(w.dropCalls === 1, '重复回执下仍只共同放下一次');
  assert(k.propPose().loads.A === 0 && k.propPose().loads.B === 0, '载荷只清零一次');
  // 强行灌入“同一 id”的重复取消，接收端必须去重
  const seenBefore = k._seen.size;
  k.handleDelivered({ id: 'c-dup', from: 'B', to: 'A', type: 'CANCEL',
    payload: {}, epoch: k.epoch });
  k.handleDelivered({ id: 'c-dup', from: 'B', to: 'A', type: 'CANCEL',
    payload: {}, epoch: k.epoch });
  assert(k._seen.size === seenBefore + 1, '相同 id 的取消回执第二次被去重');
  assert(w.dropCalls === 1, '重复取消不会二次放下');
  assert(k.auditInvariants().length === 0, '重复提交下不产生不变量违规');
}

/* ============================================================
 * T7 独立判据交叉验证：支撑面 + 握点载荷
 * ============================================================ */
section('T7 独立判据：支撑面与握点载荷交叉核对（不以阶段串自证）');
{
  const w = new TrackWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  // 各阶段取一个样本，用 (支撑面, 载荷和) 独立推断，不读 phase 字符串
  const samples = [];
  k.start('A');
  k.tick(); k.tick();
  samples.push(k.propPose());
  k.declareReady('A'); k.declareReady('B'); k.commit('A'); k.commit('B');
  samples.push(k.propPose());
  k.applyForce('A'); k.applyForce('B');
  samples.push(k.propPose());

  const [prep, committed, lifted] = samples;
  assert(prep.support === Support.SHELF && prep.loads.A + prep.loads.B === 0,
    '就位阶段：支撑面=货架，载荷和=0');
  assert(committed.support === Support.SHELF && committed.loads.A + committed.loads.B === 0,
    '承诺阶段：支撑面=货架，载荷和=0');
  assert(lifted.support === Support.PAIR &&
    Math.abs(lifted.loads.A + lifted.loads.B - WEIGHT) < 1e-9,
    '抬起阶段：支撑面=双握点，载荷和=整重');

  // 关键反例：把 phase 强行改成 CARRYING，但物理事实未变 —— 独立判据仍能识别
  const physicalBefore = { support: k.support, sum: k.gripLoads.A + k.gripLoads.B };
  k.phase = Phase.CARRYING;
  assert(k.propPose().support === physicalBefore.support, '改阶段串不影响支撑面事实');
  assert(Math.abs(k.propPose().loads.A + k.propPose().loads.B -
    physicalBefore.sum) < 1e-9, '改阶段串不影响握点载荷事实');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('取消/承重/物权轨迹测试全部通过');
