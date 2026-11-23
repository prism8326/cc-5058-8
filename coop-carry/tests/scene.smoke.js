/*
 * 场景集成冒烟测试：用最小 Canvas 桩在 Node 中运行真实 CarryScene + CoopKernel，
 * 跑六个预设案例，核对联合动作启动条件与道具最终位置/占用状态。
 * 运行：node tests/scene.smoke.js
 */
'use strict';

const path = require('path');
const { CoopKernel, Phase } = require(path.join(__dirname, '..', 'js', 'kernel.js'));

/* ---- 最小 Canvas 2D 桩：只满足场景渲染调用 ---- */
function makeCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop: noop });
      return typeof prop === 'string' ? noop : undefined;
    },
    set() { return true; },
  });
}
function makeCanvas() {
  return {
    width: 880, height: 560,
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 880, height: 560 }),
    addEventListener: () => {},
  };
}
global.document = { getElementById: () => makeCanvas() };
const { CarryScene } = require(path.join(__dirname, '..', 'js', 'scene.js'));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

function runScenario(key, opts = {}) {
  const scene = new CarryScene(makeCanvas());
  scene.applyScenario(CarryScene.SCENIOS[key]);
  const kernel = new CoopKernel(scene, { prepWindow: 1200, commitWindow: 800, recoverTimeout: 480 });
  const events = [];
  kernel.on((type, d) => events.push({ type, d }));
  scene.on((type, d) => {
    if (type === 'rollback:arrived') {
      scene.reattachAgent('A'); scene.reattachAgent('B');
      kernel.rollbackArrived();
    } else if (type === 'contact:lost') {
      kernel.loseSupport(d.agent, '接触点姿态脱离');
    }
  });

  kernel.start(opts.leader || 'A');
  const maxTicks = opts.maxTicks || 2400;
  for (let i = 0; i < maxTicks; i++) {
    scene.beginApproach('A');
    scene.beginApproach('B');
    scene.update();
    kernel.tick();

    const ph = kernel.phase;
    if (ph === Phase.PREPARING) {
      for (const a of ['A', 'B']) {
        const pose = scene.agentPose(a);
        if (pose.ready && !kernel.attempt[a].ready) kernel.declareReady(a);
        if (kernel.attempt[a].ready && !kernel.attempt[a].committed) kernel.commit(a);
      }
    } else if (ph === Phase.COMMITTED) {
      for (const a of ['A', 'B']) if (!kernel.attempt[a].forced) kernel.applyForce(a);
    } else if (ph === Phase.CARRYING) {
      if (typeof opts.injectAt === 'function' && !opts._injected) {
        if (opts.injectAt(scene, kernel, i)) {
          opts._injected = true;
          opts.inject(scene, kernel);
        }
      }
      if (scene.prop.x >= scene.slot.x - 3) {
        for (const a of ['A', 'B']) if (!kernel.attempt[a].released) kernel.release(a);
      }
    }
    if (ph === Phase.DONE || ph === Phase.ABORTED) {
      // 终态后再多跑几帧确认稳定
      if (!opts._tail) opts._tail = 0;
      if (++opts._tail > 30) break;
    }
  }
  return { scene, kernel, events };
}

/* S1 标准协作 */
console.log('[S1] 标准协作 -> 道具进入目的地并占用');
{
  const { scene, kernel } = runScenario('balanced');
  assert(kernel.phase === Phase.DONE, '最终 DONE');
  assert(kernel.propState === 'PLACED', '道具 PLACED');
  assert(Math.abs(scene.prop.x - scene.slot.x) < 4, '道具 X 落在放置槽');
  assert(scene.destinationOccupied(), '目的地已占用');
  assert(scene.agents.A.mode === 'DONE' && scene.agents.B.mode === 'DONE', '双方均 DONE');
}

/* S2 长路径：B 绕路后仍能完成 */
console.log('[S2] B 路径较长 -> 等待 B 就位后才共同抬起');
{
  const { scene, kernel, events } = runScenario('longPath');
  const readyOrder = events.filter(e => e.type === 'agent:ready').map(e => e.d.agent);
  assert(readyOrder[0] === 'A', '路径短的 A 先 READY');
  assert(readyOrder[1] === 'B', '路径长的 B 后 READY，内核一直等待');
  assert(kernel.phase === Phase.DONE && kernel.propState === 'PLACED', '最终成功放置');
  assert(scene.destinationOccupied(), '目的地占用');
}

/* S3 就位失败：A 的接触点被障碍封堵 */
console.log('[S3] 就位失败 -> READY 拒绝 + 准备窗口超时中止');
{
  const scene = new CarryScene(makeCanvas());
  scene.applyScenario(CarryScene.SCENIOS.blocked);
  const kernel = new CoopKernel(scene, { prepWindow: 300, commitWindow: 300 });
  const events = [];
  kernel.on((type, d) => events.push({ type, d }));
  kernel.start('A');
  let explicitReject = null;
  for (let i = 0; i < 500; i++) {
    scene.beginApproach('A');
    scene.beginApproach('B');
    scene.update();
    kernel.tick();
    if (kernel.phase === Phase.PREPARING) {
      for (const a of ['A', 'B']) {
        const pose = scene.agentPose(a);
        // 即使姿态不满足也尝试声明，验证内核以真实姿态拒绝，而不是全局布尔放行
        if (!kernel.attempt[a].ready && i > 60) {
          const r = kernel.declareReady(a);
          if (r && r.ok === false && !explicitReject) explicitReject = r;
        }
        if (pose.ready && !kernel.attempt[a].ready) kernel.declareReady(a);
        if (kernel.attempt[a].ready && !kernel.attempt[a].committed) kernel.commit(a);
      }
    }
    if (kernel.phase === Phase.ABORTED || kernel.phase === Phase.DONE) break;
  }
  assert(explicitReject && explicitReject.code === 'NOT_IN_POSITION',
    'A 接触点被堵时 READY 被 NOT_IN_POSITION 拒绝');
  assert(kernel.phase === Phase.ABORTED, '动作 ABORTED');
  assert(events.some(e => e.type === 'attempt:failed' && e.d.code === 'READY_TIMEOUT'),
    '准备窗口超时事件 READY_TIMEOUT');
  assert(scene.prop.x === scene.origin.x && scene.prop.grounded, '道具留在原点且在地面');
  assert(!scene.destinationOccupied(), '目的地保持空闲');
}

/* S4 外部移动（准备阶段拖动道具） */
console.log('[S4] 道具被外部移动 -> 动作中止并复位');
{
  const scene = new CarryScene(makeCanvas());
  scene.applyScenario(CarryScene.SCENIOS.external);
  const kernel = new CoopKernel(scene, { prepWindow: 1200, commitWindow: 800 });
  const events = [];
  kernel.on((type, d) => events.push({ type, d }));
  kernel.start('A');
  let dragged = false;
  for (let i = 0; i < 800; i++) {
    scene.beginApproach('A');
    scene.beginApproach('B');
    scene.update();
    kernel.tick();
    if (kernel.phase === Phase.PREPARING) {
      for (const a of ['A', 'B']) {
        const pose = scene.agentPose(a);
        if (pose.ready && !kernel.attempt[a].ready) kernel.declareReady(a);
        if (kernel.attempt[a].ready && !kernel.attempt[a].committed) kernel.commit(a);
      }
    }
    if (!dragged && (kernel.attempt.A.ready || kernel.attempt.B.ready)) {
      dragged = true;
      scene.prop.x = 500;
      kernel.externalMove({ x: 500, y: scene.prop.y });
    }
    if (kernel.phase === Phase.DONE || kernel.phase === Phase.ABORTED) break;
  }
  assert(events.some(e => e.type === 'attempt:failed' && e.d.code === 'PROP_MOVED_EXTERNALLY'),
    '外部移动产生 PROP_MOVED_EXTERNALLY 失败事件');
  assert(kernel.phase === Phase.ABORTED, '外部移动后 ABORTED');
  assert(Math.abs(scene.prop.x - scene.origin.x) < 1, '道具复位到原点');
}

/* S5 失去支撑·有空间：搬运中 B 脱离 -> 就地放下 */
console.log('[S5] 失去支撑（有空间）-> 就地放下');
{
  const r = runScenario('spaceDrop', {
    injectAt: (scene, kernel) => kernel.phase === Phase.CARRYING &&
      scene.prop.x > scene.origin.x + 120,
    inject: (scene, kernel) => {
      scene.detachAgent('B');
      kernel.loseSupport('B', '注入脱离');
    },
  });
  assert(r.kernel.phase === Phase.DONE, '中断后 DONE');
  assert(r.kernel.propState === 'DROPPED', '道具 DROPPED（就地放下）');
  assert(r.scene.prop.x < r.scene.slot.x - 60, '道具停在半路，未到目的地');
  assert(!r.scene.destinationOccupied(), '目的地未被占用');
  const verdict = r.events.find(e => e.type === 'arbitration');
  assert(verdict && verdict.d.verdict === 'DROP_IN_PLACE', '裁决结果 DROP_IN_PLACE');
}

/* S6 失去支撑·无空间：障碍走廊中脱离 -> 共同回滚到原点 */
console.log('[S6] 失去支撑（无空间）-> 共同回滚到抬起点');
{
  const r = runScenario('noSpace', {
    injectAt: (scene, kernel) => kernel.phase === Phase.CARRYING &&
      scene.prop.x > 442 && scene.canPlaceHere(scene.prop.x, scene.prop.y) === false,
    inject: (scene, kernel) => {
      scene.detachAgent('A');
      kernel.loseSupport('A', '注入脱离');
    },
  });
  const verdict = r.events.find(e => e.type === 'arbitration');
  assert(verdict && verdict.d.verdict === 'ROLLBACK', '裁决结果 ROLLBACK');
  assert(r.events.some(e => e.type === 'recover:resume'), '回滚到位后恢复搬运');
  assert(r.kernel.phase === Phase.DONE && r.kernel.propState === 'PLACED',
    '恢复后继续完成放置 -> DONE/PLACED');
  assert(Math.abs(r.scene.prop.x - r.scene.slot.x) < 4, '最终道具在目的地');
  assert(r.scene.destinationOccupied(), '目的地占用');
}

/* S7 单方强抬：场景级验证道具位置不变 */
console.log('[S7] 单方强抬反例 -> 道具原地不动');
{
  const scene = new CarryScene(makeCanvas());
  scene.applyScenario(CarryScene.SCENIOS.balanced);
  const kernel = new CoopKernel(scene);
  const before = { ...scene.prop };
  const r1 = kernel.applyForce('A');
  assert(r1.ok === false && r1.code === 'SOLO_LIFT_BLOCKED', '未发起时施力被拒');
  kernel.start('A');
  for (let i = 0; i < 10; i++) { scene.update(); kernel.tick(); }
  const r2 = kernel.applyForce('A');
  assert(r2.ok === false && r2.code === 'SOLO_LIFT_BLOCKED', '仅一方在场施力被拒');
  assert(scene.prop.x === before.x && scene.prop.y === before.y && scene.prop.grounded,
    '道具坐标与落地状态完全不变');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('全部场景集成冒烟用例通过');
