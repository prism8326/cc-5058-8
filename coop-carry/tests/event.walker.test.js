/*
 * 双人动作的短事件遍历器
 * ------------------------------------------------------------------
 * 把一段联合搬运抽象成“短事件序列”，在此之上做两件独立的事：
 *  1) 遍历“取消 / 抬升回执”的先后交换，断言每个客户端视图里
 *     共享道具的“物权转移”都恰好发生一次（不是比对阶段字符串）；
 *  2) 独立检查共同道具只被合法阶段驱动，并用错误重复回执作反例，
 *     断言这些坏结果会被审计捕获。
 * 运行：node tests/event.walker.test.js
 */
'use strict';

const path = require('path');
const {
  CoopKernel, Phase, PropState, Support, Ownership,
} = require(path.join(__dirname, '..', 'js', 'kernel.js'));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
}
function section(name) { console.log(`\n[${name}]`); }

class MiniWorld {
  constructor() {
    this.prop = { x: 100, y: 200, grounded: true };
    this.origin = { x: 100, y: 200 };
    this.dropCalls = 0;
    this.placeCalls = 0;
  }
  agentPose() { return { x: 0, y: 0, ready: true, contactOK: true, grip: { x: 0, y: 0 } }; }
  canPlaceHere() { return true; }
  propOrigin() { return { ...this.origin }; }
  propPosition() { return { ...this.prop }; }
  destinationOccupied() { return false; }
  startCarry() { this.prop.grounded = false; }
  startRollback() {}
  stopMotion() {}
  placePropAt(x, y) { this.placeCalls += 1; this.prop.x = x; this.prop.y = y; this.prop.grounded = true; }
  dropPropHere() { this.dropCalls += 1; this.prop.grounded = true; }
  resetPropToOrigin() { this.prop = { ...this.origin, grounded: true }; }
}

/*
 * 短事件遍历器：给定一段事件序列，按顺序施于内核。
 * 事件类型：
 *   start / ready(a) / commit(a) / force(a) / cancel(a) / deliverCancel / tick(n)
 * 返回内核与记录到的每客户端物权观察。
 */
const EVENTS = {
  gripPhase: ['ready:A', 'ready:B', 'commit:A', 'commit:B'],
  liftPhase: ['force:A', 'force:B'],
  cancelPhase: ['cancel:A', 'deliverCancel'],
};

function makeKernel(world, opts = {}) {
  return new CoopKernel(world, {
    prepWindow: 900, commitWindow: 900, recoverTimeout: 600, ...opts,
  });
}

function applyEvent(k, ev) {
  if (ev === 'start') { k.start('A'); return; }
  if (ev.startsWith('tick:')) { const n = Number(ev.split(':')[1]); for (let i = 0; i < n; i++) k.tick(); return; }
  if (ev === 'deliverCancel') { for (let i = 0; i < 40; i++) k.tick(); return; }
  const [verb, agent] = ev.split(':');
  switch (verb) {
    case 'ready': k.declareReady(agent); break;
    case 'commit': k.commit(agent); break;
    case 'force': k.applyForce(agent); break;
    case 'cancel': k.requestCancel(agent); break;
    default: throw new Error('unknown event ' + ev);
  }
}

/* 用“物权观察”而非阶段字符串作判据 */
function pairTransfers(log) {
  return log.filter(e => e.to === Ownership.PAIR);
}

/* ============================================================
 * W1 遍历：取消回执与抬升回执交换顺序，两客户端各只见一次物权转移
 * ============================================================ */
section('W1 事件遍历：交换取消/抬升回执顺序，双方都只观察到一次物权转移');
{
  // 两段短事件序列，都在抬升生效后交换“抬升回执”与“取消回执”的到达顺序。
  // 抬升回执的重复/乱序不得造成第二次物权转移；取消回执不得再次转移权属。
  const sequences = [
    {
      name: '抬升后取消，再补一份抬升回执',
      events: ['start', 'tick:2', ...EVENTS.gripPhase, 'force:A', 'force:B',
        'cancel:A', 'force:B', 'deliverCancel'],
    },
    {
      name: '抬升后补抬升回执，再取消',
      events: ['start', 'tick:2', ...EVENTS.gripPhase, 'force:A', 'force:B',
        'force:A', 'cancel:A', 'deliverCancel'],
    },
  ];

  for (const seq of sequences) {
    const w = new MiniWorld();
    const k = makeKernel(w);
    for (const ev of seq.events) applyEvent(k, ev);

    const obsA = k.clientOwnershipLog('A');
    const obsB = k.clientOwnershipLog('B');
    const pairA = pairTransfers(obsA);
    const pairB = pairTransfers(obsB);

    // 恰好在抬升生效点发生一次 SHELF->PAIR，双方各只见一次
    assert(pairA.length === 1, `${seq.name}：客户端 A 恰好观察到一次物权转移（实际 ${pairA.length}）`);
    assert(pairB.length === 1, `${seq.name}：客户端 B 恰好观察到一次物权转移（实际 ${pairB.length}）`);
    assert(pairA.length === pairB.length && pairA[0].epoch === pairB[0].epoch &&
      pairA[0].tick === pairB[0].tick, `${seq.name}：两客户端观察到的是同一次转移`);
    assert(k.auditInvariants().length === 0, `${seq.name}：无非法物权/承重事实`);
  }
}

/* ============================================================
 * W2 独立检查：共同道具只被合法阶段驱动
 * ============================================================ */
section('W2 独立检查：共同道具只被合法阶段驱动（非仅比对阶段字符串）');
{
  const w = new MiniWorld();
  const k = makeKernel(w);
  for (const ev of ['start', 'tick:2', ...EVENTS.gripPhase, ...EVENTS.liftPhase]) {
    applyEvent(k, ev);
  }
  // 重放每个道具转移，逐条核对“驱动阶段”是否在合法集合内
  const legal = CoopKernel.LEGAL_PROP_DRIVERS;
  for (const tr of k._propTransitions) {
    const drivers = legal[tr.from + '>' + tr.to];
    const ok = Array.isArray(drivers) && drivers.includes(tr.phase);
    assert(ok, `道具 ${tr.from}->${tr.to} 由 ${tr.phase} 驱动（合法）`);
  }
  assert(k._propTransitions.length >= 1, '确实记录了道具转移');
  assert(k.auditIssues().length === 0, '正常轨迹无非法道具驱动');
}

/* ============================================================
 * W3 反例：受控错误 —— 道具在错误阶段被驱动，必须被捕获
 * ============================================================ */
section('W3 受控错误：道具姿态在错误阶段被驱动 -> 审计捕获');
{
  const w = new MiniWorld();
  const k = makeKernel(w);
  for (const ev of ['start', 'tick:2', ...EVENTS.gripPhase]) applyEvent(k, ev);
  const before = k.auditIssues().length;
  // 在 COMMITTED（尚未抬升）强行做 GROUNDED->LIFTED：合法驱动阶段应是 LIFTING
  k.faultInject('prop_wrong_phase');
  const issues = k.auditIssues();
  assert(issues.length > before, '错误阶段的道具驱动被记录');
  assert(issues.some(e => e.code === 'PROP_DRIVEN_BY_WRONG_PHASE'),
    '具体报出 PROP_DRIVEN_BY_WRONG_PHASE');
}

/* ============================================================
 * W4 反例：错误重复回执/物权双重转移必须被捕获
 * ============================================================ */
section('W4 受控错误：重复回执 / 物权重复转移 / 单方脱手 -> 审计捕获');
{
  // 4a 错误重复回执：同一份 CANCEL 回执重复投递不得二次施加，且能被去重计数
  const wDup = new MiniWorld();
  const kDup = makeKernel(wDup);
  kDup.duplicateEvery = 1; // 每条消息复制一份，制造重复回执
  for (const ev of ['start', 'tick:2', ...EVENTS.gripPhase, ...EVENTS.liftPhase]) {
    applyEvent(kDup, ev);
  }
  let dupEvents = 0;
  kDup.on((type) => { if (type === 'msg:duplicate') dupEvents += 1; });
  kDup.requestCancel('A');
  for (let i = 0; i < 40; i++) kDup.tick();
  assert(wDup.dropCalls === 1, '重复回执下共同放下只发生一次');
  assert(dupEvents >= 1, '重复的取消回执被识别并丢弃（msg:duplicate）');
  assert(kDup.auditInvariants().length === 0, '重复回执不制造不变量违规');

  // 4b 物权重复转移
  const w = new MiniWorld();
  const k = makeKernel(w);
  for (const ev of ['start', 'tick:2', ...EVENTS.gripPhase, ...EVENTS.liftPhase]) {
    applyEvent(k, ev);
  }
  assert(k.auditInvariants().length === 0, '初始抬升后无违规');

  const beforeIssues = k.auditIssues().length;
  k.faultInject('double_transfer');
  assert(k.auditIssues().length > beforeIssues, '重复物权转移被审计记录');
  assert(k.auditIssues().some(e => e.code === 'OWNERSHIP_DOUBLE_TRANSFER' ||
    e.code === 'OWNERSHIP_TRANSFER_COUNT'), '报出物权重复转移');

  // 4c 单方脱手但声称双人承重
  const k2 = makeKernel(new MiniWorld());
  for (const ev of ['start', 'tick:2', ...EVENTS.gripPhase, ...EVENTS.liftPhase]) {
    applyEvent(k2, ev);
  }
  k2.faultInject('pair_one_hand');
  const inv = k2.auditInvariants();
  assert(inv.some(p => p.code === 'LIFTED_ONE_HAND'), '单方脱手却声称双人承重被独立判据捕获');
}

/* ============================================================
 * W5 遍历器自身：每一对客户端观察必须对应一次真实物权事实
 * ============================================================ */
section('W5 遍历一致性：每客户端观察与内核物权事实同源');
{
  const w = new MiniWorld();
  const k = makeKernel(w);
  for (const ev of ['start', 'tick:2', ...EVENTS.gripPhase, ...EVENTS.liftPhase]) {
    applyEvent(k, ev);
  }
  const obsA = k.clientOwnershipLog('A');
  const obsB = k.clientOwnershipLog('B');
  const fact = k.ownershipLog;
  assert(obsA.length === fact.length && obsB.length === fact.length,
    '两客户端各自看到与内核事实等量的物权转移');
  // 内容一致（除 seenBy）
  const strip = e => ({ from: e.from, to: e.to, epoch: e.epoch, tick: e.tick });
  assert(JSON.stringify(obsA.map(strip)) === JSON.stringify(fact.map(strip)),
    'A 客户端观察序列与内核事实一致');
  assert(JSON.stringify(obsB.map(strip)) === JSON.stringify(fact.map(strip)),
    'B 客户端观察序列与内核事实一致');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('双人短事件遍历器测试全部通过');
