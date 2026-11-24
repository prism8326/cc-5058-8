/*
 * 协作阶段验收（acceptance）
 * ------------------------------------------------------------------
 * 目的：为“协作阶段”建立可验收的正反例，期望值一律独立推导，不复述实现：
 *  - 用单方迟到 + 重复完成构造正例与反例；
 *  - 断言“读取道具姿态（propPose）”和“阶段资格（phaseEligibility）”，
 *    二者都对照本地独立参照模型，而不是回读被测内核的 phase 字符串；
 *  - 对联合搬运引入受控错误，让道具姿态与阶段资格明确暴露坏结果；
 *  - 把道具姿态和阶段资格对应到“执行证据”（场景/世界调用 + 事件序列），
 *    不允许伪报成功。
 * 运行：node tests/coop.acceptance.test.js
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

/* 记录型世界：所有副作用都计数，作为“执行证据” */
class EvidenceWorld {
  constructor(opts = {}) {
    this.ready = { A: opts.readyA ?? true, B: opts.readyB ?? true };
    this.prop = { x: 100, y: 200, grounded: true };
    this.origin = { x: 100, y: 200 };
    this.calls = { startCarry: 0, stopMotion: 0, placePropAt: 0, dropPropHere: 0,
      resetPropToOrigin: 0, startRollback: 0 };
  }
  agentPose(a) {
    const ok = this.ready[a];
    return { x: 0, y: 0, ready: ok, contactOK: ok, grip: { x: 0, y: 0 } };
  }
  canPlaceHere() { return true; }
  propOrigin() { return { ...this.origin }; }
  propPosition() { return { ...this.prop }; }
  destinationOccupied() { return false; }
  startCarry() { this.calls.startCarry += 1; this.prop.grounded = false; }
  startRollback() { this.calls.startRollback += 1; }
  stopMotion() { this.calls.stopMotion += 1; }
  placePropAt(x, y) {
    this.calls.placePropAt += 1;
    this.prop.x = x; this.prop.y = y; this.prop.grounded = true;
  }
  dropPropHere() { this.calls.dropPropHere += 1; this.prop.grounded = true; }
  resetPropToOrigin() {
    this.calls.resetPropToOrigin += 1;
    this.prop = { ...this.origin, grounded: true };
  }
}

/* ==== 独立参照模型：只凭协议定义推导“在给定阶段，道具应是什么姿态、
 * 每个角色是否有资格做每种动作”。它刻意不引用被测算子的任何字段。 ==== */
const REFERENCE = {
  // 由阶段名称独立推得道具应处于的姿态
  propForPhase(phase) {
    switch (phase) {
      case 'IDLE':
      case 'PREPARING':
      case 'COMMITTED':
      case 'ABORTED':
        return PropState.GROUNDED;
      case 'LIFTING':
      case 'CARRYING':
      case 'RECOVERING':
      case 'CANCELLING':
        return PropState.LIFTED;
      case 'PLACING':
        return null; // 放置中：可在 PLACED 或 DROPPED 之间过渡
      default:
        return null; // DONE：可为 PLACED/DROPPED
    }
  },
  // 承重与物权：由“是否已抬升”独立推导
  supportForPhase(phase) {
    switch (phase) {
      case 'IDLE': case 'PREPARING': case 'COMMITTED': case 'ABORTED':
        return Support.SHELF;
      case 'LIFTING': case 'CARRYING': case 'RECOVERING': case 'CANCELLING':
        return Support.PAIR;
      default:
        return Support.GROUND;
    }
  },
  ownershipForPhase(phase) {
    switch (phase) {
      case 'IDLE': case 'PREPARING': case 'COMMITTED': case 'ABORTED':
        return Ownership.SHELF;
      case 'LIFTING': case 'CARRYING': case 'RECOVERING': case 'CANCELLING':
        return Ownership.PAIR;
      default:
        return Ownership.GROUND;
    }
  },
  // 阶段资格独立推导：给定阶段与角色协议位，推导每种动作是否可用
  eligibility(phase, hasReady, hasCommitted, hasForced) {
    return {
      canReady: phase === 'PREPARING' && !hasReady,
      canCommit: phase === 'PREPARING' && hasReady && !hasCommitted,
      canForce: (phase === 'COMMITTED' || phase === 'LIFTING') && !hasForced,
      canRelease: phase === 'CARRYING' || phase === 'PLACING',
      canCancel: !(phase === 'IDLE' || phase === 'DONE' || phase === 'ABORTED'),
    };
  },
};

/* 世界与内核的一致性证据：道具姿态是否与“执行证据”相符 */
function evidenceOf(world, kernel) {
  const pose = kernel.propPose();
  return {
    pose,
    // 执行证据：抬升必须恰好一次 startCarry；放下必须确实 dropPropHere
    startCarry: world.calls.startCarry,
    dropCalls: world.calls.dropPropHere,
    placeCalls: world.calls.placePropAt,
    grounded: world.prop.grounded,
  };
}

function bootstrap(world, opts = {}) {
  const k = new CoopKernel(world, { prepWindow: 900, commitWindow: 900, ...opts });
  k.start('A');
  for (let i = 0; i < 2; i++) k.tick();
  k.declareReady('A'); k.declareReady('B');
  k.commit('A'); k.commit('B');
  return k;
}

/* ============================================================
 * A1 正例：单方迟到后双方补齐 -> 阶段资格与姿态逐步符合独立参照
 * ============================================================ */
section('A1 正例：B 迟到（单方迟到）后补齐，逐步验收阶段资格与道具姿态');
{
  const w = new EvidenceWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });

  // 检查点断言：对当前阶段，用独立参照核对姿态 + 两角色资格
  const check = (label) => {
    const pose = k.propPose();
    const phase = k.phase;
    assert(pose.state === REFERENCE.propForPhase(phase) ||
      REFERENCE.propForPhase(phase) === null,
      `${label}：道具姿态符合相位参照（${phase} -> ${REFERENCE.propForPhase(phase) || '过渡'}）`);
    if (REFERENCE.supportForPhase(phase) === Support.PAIR) {
      assert(pose.support === Support.PAIR || pose.support === Support.SINGLE,
        `${label}：承重落在握点上`);
    } else {
      assert(pose.support === REFERENCE.supportForPhase(phase),
        `${label}：承重面=${pose.support} 符合参照`);
    }
    for (const a of ['A', 'B']) {
      const st = k.attempt[a];
      const ref = REFERENCE.eligibility(phase, st.ready, st.committed, st.forced);
      const got = k.phaseEligibility(a);
      assert(got.canReady === ref.canReady && got.canCommit === ref.canCommit &&
        got.canForce === ref.canForce && got.canRelease === ref.canRelease &&
        got.canCancel === ref.canCancel,
        `${label}：${a} 的阶段资格与独立参照一致`);
    }
  };

  k.start('A');
  k.tick(); k.tick();
  check('PREPARING 初始');
  k.declareReady('A');
  check('A 就绪、B 迟到');
  // B 迟到：延迟若干 tick 再就位
  for (let i = 0; i < 15; i++) k.tick();
  check('B 仍迟到');
  k.declareReady('B');
  k.commit('A'); k.commit('B');
  check('COMMITTED');
  k.applyForce('A');
  check('仅 A 施力');
  k.applyForce('B');
  check('双方施力 -> CARRYING');

  // 执行证据：抬升恰好一次、道具离开地面
  const ev = evidenceOf(w, k);
  assert(ev.startCarry === 1, '执行证据：startCarry 恰好一次');
  assert(ev.pose.state === PropState.LIFTED, '执行证据：道具 LIFTED');
  assert(ev.pose.loads.A + ev.pose.loads.B === WEIGHT, '执行证据：两握点合计整重');

  k.release('A'); k.release('B');
  assert(k.phase === Phase.DONE && w.calls.placePropAt === 1, '执行证据：放置恰好一次');
  assert(k.propPose().ownership === Ownership.GROUND, '放置后物权交给地面');
  assert(k.auditInvariants().length === 0, '正例全程无不变量违规');
}

/* ============================================================
 * A2 正例：重复完成（幂等）—— 重复 READY/COMMIT/FORCE 不改变姿态与资格
 * ============================================================ */
section('A2 正例：重复完成（幂等）不重复施加效果，姿态与资格保持');
{
  const w = new EvidenceWorld();
  const k = new CoopKernel(w, { prepWindow: 900, commitWindow: 900 });
  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A'); k.declareReady('B');
  // 重复 READY：第二次应幂等
  assert(k.declareReady('A').duplicate === true, '重复 READY 幂等');
  // 重复 COMMIT：在 B 尚未承诺、阶段仍为 PREPARING 时重复
  k.commit('A');
  assert(k.commit('A').duplicate === true, '重复 COMMIT 幂等（阶段未推进前）');
  k.commit('B');
  // 重复 FORCE：在 B 尚未施力、阶段仍为 COMMITTED 时重复
  k.applyForce('A');
  assert(k.applyForce('A').duplicate === true, '重复 FORCE 幂等，不二次抬升');
  k.applyForce('B');
  // 抬升生效后再发一次 FORCE：不得再次抬升/转移物权（幂等被拒或重复丢弃）
  const postLift = k.applyForce('A');
  assert(postLift.ok === false || postLift.duplicate === true,
    '抬升后重复 FORCE 被拒/幂等，不再生效');
  assert(w.calls.startCarry === 1, '执行证据：startCarry 仍为一次');
  const pairTransfers = k.ownershipLog.filter(e => e.to === Ownership.PAIR);
  assert(pairTransfers.length === 1, '执行证据：物权只转移一次');
  assert(k.propPose().loads.A === WEIGHT / 2 && k.propPose().loads.B === WEIGHT / 2,
    '重复施力后两握点仍各承一半');
  assert(k.auditInvariants().length === 0, '重复完成无不变量违规');
}

/* ============================================================
 * A3 反例：单方迟到超时 -> 不得伪报完成；资格停格、姿态未变
 * ============================================================ */
section('A3 反例：单方迟到超时，验收拒绝伪报完成');
{
  const w = new EvidenceWorld();
  const k = new CoopKernel(w, { prepWindow: 40, commitWindow: 900 });
  k.start('A');
  k.tick(); k.tick();
  k.declareReady('A'); k.commit('A');
  const events = [];
  k.on((t, d) => events.push({ t, d }));
  for (let i = 0; i < 60; i++) k.tick();

  assert(k.phase === Phase.ABORTED, '阶段 ABORTED（未伪报完成）');
  assert(w.calls.startCarry === 0, '执行证据：从未抬升');
  assert(w.calls.placePropAt === 0, '执行证据：从未放置');
  assert(k.propPose().state === PropState.GROUNDED, '道具仍 GROUNDED');
  assert(k.propPose().ownership === Ownership.SHELF, '物权仍在货架');
  assert(events.some(e => e.t === 'attempt:failed' && e.d.code === 'READY_TIMEOUT'),
    '有 READY_TIMEOUT 失败证据');
  // 终态下阶段资格：双方均无任何动作资格
  for (const a of ['A', 'B']) {
    const el = k.phaseEligibility(a);
    assert(!el.canReady && !el.canCommit && !el.canForce && !el.canRelease && !el.canCancel,
      `${a} 在 ABORTED 下所有资格关闭`);
  }
  assert(k.auditInvariants().length === 0, '失败路径无不变量违规');
}

/* ============================================================
 * A4 受控错误：道具姿态在错误阶段被驱动 -> 姿态判据暴露坏结果
 * ============================================================ */
section('A4 受控错误：错误阶段的道具姿态驱动被姿态判据与审计同时暴露');
{
  const w = new EvidenceWorld();
  const k = bootstrap(w); // 停在 COMMITTED（货架仍承重）
  const refProp = REFERENCE.propForPhase(k.phase);
  assert(k.propPose().state === refProp, '受控错误前：姿态符合参照');

  k.faultInject('prop_wrong_phase');
  // 姿态判据：在 COMMITTED 下被驱动 LIFTED，与独立参照冲突
  const pose = k.propPose().state;
  const violatesReference = pose !== refProp;
  assert(violatesReference, '姿态判据暴露：COMMITTED 下出现非参照姿态');
  assert(k.auditIssues().some(e => e.code === 'PROP_DRIVEN_BY_WRONG_PHASE'),
    '审计暴露：PROP_DRIVEN_BY_WRONG_PHASE');
  // 但物理事实未被伪造：承重仍在货架
  assert(k.propPose().support === Support.SHELF, '承重事实未被伪造成双人');
}

/* ============================================================
 * A5 受控错误：物权重复转移 -> 阶段资格/姿态判据暴露坏结果
 * ============================================================ */
section('A5 受控错误：物权重复转移被独立判据暴露');
{
  const w = new EvidenceWorld();
  const k = bootstrap(w);
  k.applyForce('A'); k.applyForce('B');
  assert(k.auditInvariants().length === 0, '受控错误前无不变量违规');
  const transfersBefore = k.ownershipLog.filter(e => e.to === Ownership.PAIR).length;

  k.faultInject('double_transfer');
  const problems = k.auditInvariants();
  assert(problems.some(p => p.code === 'OWNERSHIP_TRANSFER_COUNT' ||
    p.code === 'OWNERSHIP_DOUBLE_TRANSFER' || p.code === 'OWNERSHIP_SUPPORT_MISMATCH'),
    '独立不变量判据暴露物权重复转移');
  const transfersAfter = k.ownershipLog.filter(e => e.to === Ownership.PAIR).length;
  assert(transfersAfter > transfersBefore, '物权日志确实多记了转移（坏结果可见）');
}

/* ============================================================
 * A6 姿态/资格必须对应执行证据：不得伪报（影子对照）
 * ============================================================ */
section('A6 姿态与资格须对应执行证据，搬运协作验收不允许伪报');
{
  const w = new EvidenceWorld();
  const k = bootstrap(w);
  k.applyForce('A'); k.applyForce('B');

  // 姿态 -> 证据：LIFTED 必须同时满足 (startCarry==1) 且 (道具离地)
  const pose = k.propPose();
  const evidence = evidenceOf(w, k);
  assert(pose.state === PropState.LIFTED, '姿态 LIFTED');
  assert(evidence.startCarry === 1 && evidence.grounded === false,
    'LIFTED 有执行证据支撑（startCarry=1 且离地）');

  // 资格 -> 证据：CARRYING 下 canRelease 为真，必须与“可执行且会被接受”一致
  for (const a of ['A', 'B']) {
    const el = k.phaseEligibility(a);
    if (el.canRelease) {
      const r = k.release(a);
      assert(r.ok === true, `${a} 资格 canRelease=true 与真实可执行一致`);
    }
  }
  // 双方松手后，姿态与证据切到放置完成
  assert(k.phase === Phase.DONE && w.calls.placePropAt === 1,
    '最终放置有执行证据，非伪报');
  assert(k.propPose().state === PropState.PLACED, '道具姿态 PLACED');
  assert(k.propPose().support === Support.GROUND && k.propPose().ownership === Ownership.GROUND,
    '落地后承重/物权均在地面');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('协作阶段验收测试全部通过');
