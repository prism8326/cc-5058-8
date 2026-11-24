/*
 * 场景级拖动取消测试
 * ------------------------------------------------------------------
 * 用最小 Canvas 桩驱动真实 CarryScene + CoopKernel：
 *  - 在“握住把手”时拖动应发出 cancel:requested（而非 prop:dragged）；
 *  - 取消时点由货架状态决定：货架仍在 -> 货架承重；货架已撤走 -> 双人放下；
 *  - 拖动普通道具区域仍表达外部移动，不被误判为取消。
 * 运行：node tests/ui.drag.test.js
 */
'use strict';

const path = require('path');
const { CoopKernel, Phase, Support, Ownership } = require(path.join(__dirname, '..', 'js', 'kernel.js'));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function section(name) { console.log(`\n[${name}]`); }

/* Canvas 桩：记录鼠标监听器，便于派发合成事件 */
function makeCanvas() {
  const listeners = {};
  return {
    width: 880, height: 560,
    getContext: () => new Proxy({}, {
      get(t, p) {
        if (p === 'measureText') return () => ({ width: 0 });
        return typeof p === 'string' ? () => {} : undefined;
      },
      set() { return true; },
    }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 880, height: 560 }),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatch: (type, ev) => { for (const fn of listeners[type] || []) fn(ev); },
    _listeners: listeners,
  };
}

global.document = { getElementById: () => makeCanvas() };
const { CarryScene } = require(path.join(__dirname, '..', 'js', 'scene.js'));

function wire(scene, kernel) {
  const out = { cancel: 0, dragged: 0 };
  scene.on((type, d) => {
    if (type === 'cancel:requested') { out.cancel += 1; out.lastCancel = d; }
    else if (type === 'prop:dragged') { out.dragged += 1; out.lastDrag = d; }
  });
  return out;
}

function toCommitted(scene, kernel) {
  // 把两名角色真实移动到各自的接触点并朝向道具（满足 agentPose 的就位判据）
  for (const id of ['A', 'B']) {
    const g = scene.gripPoint(id, scene.prop);
    scene.agents[id].x = g.x;
    scene.agents[id].y = g.y;
    scene.agents[id].facing = Math.atan2(scene.prop.y - g.y, scene.prop.x - g.x);
  }
  kernel.start('A');
  for (let i = 0; i < 2; i++) kernel.tick();
  kernel.declareReady('A'); kernel.declareReady('B');
  kernel.commit('A'); kernel.commit('B');
}

/* 合成一次鼠标拖动：从给定画布坐标按下 -> 移动 -> 抬起 */
function dragAt(canvas, x, y) {
  canvas.dispatch('mousedown', { clientX: x, clientY: y });
  canvas.dispatch('mousemove', { clientX: x + 30, clientY: y });
  canvas.dispatch('mouseup', { clientX: x + 30, clientY: y });
}

section('D1 握住把手时拖动 -> 发出取消事件（不是外部移动）');
{
  const canvas = makeCanvas();
  const scene = new CarryScene(canvas);
  scene.applyScenario(CarryScene.SCENIOS.balanced);
  const kernel = new CoopKernel(scene, { prepWindow: 900, commitWindow: 900 });
  const out = wire(scene, kernel);
  toCommitted(scene, kernel);
  assert(kernel.phase === Phase.COMMITTED, '已到 COMMITTED（两人握住把手）');

  // 在 A 的接触点按下并拖动
  const g = scene.gripPoint('A', scene.prop);
  dragAt(canvas, g.x, g.y);
  assert(out.cancel === 1, '接触点拖动触发一次 cancel:requested');
  assert(out.dragged === 0, '未被当作 prop:dragged 外部移动');
}

section('D2 道具落地时拖动 -> 仍是外部移动，不被误判为取消');
{
  const canvas = makeCanvas();
  const scene = new CarryScene(canvas);
  scene.applyScenario(CarryScene.SCENIOS.balanced);
  const kernel = new CoopKernel(scene, { prepWindow: 900, commitWindow: 900 });
  const out = wire(scene, kernel);
  const p = scene.prop;
  dragAt(canvas, p.x, p.y); // 道具正中心，远离上下接触点
  assert(out.dragged === 1, '道具中部拖动 -> prop:dragged');
  assert(out.cancel === 0, '未被误判为取消');
}

section('D3 货架仍在时取消：重量由货架承担，道具不落地');
{
  const canvas = makeCanvas();
  const scene = new CarryScene(canvas);
  scene.applyScenario(CarryScene.SCENIOS.balanced);
  const kernel = new CoopKernel(scene, { prepWindow: 900, commitWindow: 900 });
  wire(scene, kernel);
  toCommitted(scene, kernel);
  // 货架仍在
  assert(kernel.shelfPresent === true, '货架在场');
  kernel.requestCancel('A');
  assert(kernel.phase === Phase.ABORTED, '取消 -> ABORTED');
  const pose = kernel.propPose();
  assert(pose.support === Support.SHELF, '承受面=货架');
  assert(pose.ownership === Ownership.SHELF, '物权=货架');
  assert(pose.loads.A === 0 && pose.loads.B === 0, '两握点载荷 0');
  assert(scene.prop.grounded === true, '场景道具仍在地面（未坠落）');
  assert(kernel.auditInvariants().length === 0, '无不变量违规');
}

section('D4 货架已撤走后取消：同一回执触发双人放下');
{
  const canvas = makeCanvas();
  const scene = new CarryScene(canvas);
  scene.applyScenario(CarryScene.SCENIOS.balanced);
  const kernel = new CoopKernel(scene, { prepWindow: 900, commitWindow: 900 });
  wire(scene, kernel);
  toCommitted(scene, kernel);
  kernel.applyForce('A'); kernel.applyForce('B');
  assert(kernel.propPose().support === Support.PAIR, '已抬起，双人承重');
  assert(scene.prop.grounded === false, '（对照）抬起后场景道具离地');

  kernel.requestCancel('A');
  assert(kernel.phase === Phase.CANCELLING, '单方回执 -> CANCELLING（另一方继续承重）');
  assert(kernel.propPose().support === Support.SINGLE, '仅剩一方承重');
  assert(kernel.propPose().loads.B === 1, '仍在握的 B 独自承担整重');

  // 第二份回执（经总线到达）
  for (let i = 0; i < 5; i++) kernel.tick();
  assert(kernel.phase === Phase.DONE, '双方回执 -> 共同放下，DONE');
  const pose = kernel.propPose();
  assert(pose.support === Support.GROUND && pose.ownership === Ownership.GROUND,
    '放下后承重/物权交给地面');
  assert(pose.state === 'DROPPED', '道具 DROPPED');
  assert(kernel.auditInvariants().length === 0, '共同放下无不变量违规');
  assert(scene.prop.grounded === true, '（对照）放下后场景道具落地');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('场景级拖动取消测试全部通过');
