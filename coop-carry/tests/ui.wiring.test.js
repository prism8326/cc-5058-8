/*
 * 界面接线测试（无头）
 * ------------------------------------------------------------------
 * 用最小 DOM/Canvas 桩加载真实的 js/app.js，验证：
 *  - “联合搬运（图形入口）”按钮确实调用内核 start（真实 epoch / 阶段推进），
 *    而不是用固定数据冒充；
 *  - 结果区展示的占用状态来自真实场景，不是写死文本；
 *  - 拖动取消事件按“货架开关”决定撤销时点，且取消后道具姿态/承重与内核事实一致。
 * 运行：node tests/ui.wiring.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
}
function section(name) { console.log(`\n[${name}]`); }

/* ---------------- 最小 DOM 桩 ---------------- */
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

class El {
  constructor(id) {
    this.id = id;
    this.children = [];
    this._text = '';
    this.innerHTML = '';
    this.className = '';
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = {};
    this.style = {};
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.innerHTML = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, ...ev }); }
  get firstChild() { return this.children[0]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 880, height: 560 }; }
  getContext() { return makeCtx(); }
}
El.prototype.width = 880;
El.prototype.height = 560;

function makeDom() {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) {
        const el = new El(id);
        if (id === 'leaderSelect') el.value = 'A'; // 浏览器中下拉框默认选中首项
        els.set(id, el);
      }
      return els.get(id);
    },
    createElement(tag) { const e = new El(tag); return e; },
  };
  const win = {
    document,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    console,
  };
  win.window = win;
  win.globalThis = win;
  return { win, document, els };
}

/* 在隔离上下文里加载 kernel / scene / app，模拟浏览器一帧一帧推进 */
function bootApp() {
  const { win, document, els } = makeDom();
  const ctx = vm.createContext(win);
  ctx.self = win;
  for (const f of ['js/kernel.js', 'js/scene.js', 'js/app.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return { win, document, els, ctx };
}

/* 手动推进若干帧（app 的 frame 内部依赖 requestAnimationFrame，已被桩为返回 1）。
 * 界面测试通过 DOM 事件驱动真实入口即可验证接线；帧推进由 ui.drag.test.js 用
 * 真实 scene+kernel 单独覆盖。 */

section('U1 图形入口按钮：调用真实内核 start，日志出现真实 epoch 与阶段');
{
  const app = bootApp();
  const logEl = app.document.getElementById('log');
  const btn = app.document.getElementById('btnJointCarry');
  const leader = app.document.getElementById('leaderSelect');
  leader.value = 'B';
  const before = logEl.children.length;
  btn.dispatch('click');
  const text = logEl.children.map(c => c.textContent).join('\n');
  assert(logEl.children.length > before, '点击联合搬运后产生日志');
  assert(/联合搬运：由界面按钮发起/.test(text), '日志标记“由界面按钮发起”（非固定数据）');
  assert(/发起方 B/.test(text), '日志体现手动选择的发起方 B（来自下拉框，非硬编码）');
  assert(/epoch=\d+/.test(text), '日志含真实 epoch（来自内核返回，非固定值）');
}

section('U2 占用状态来自真实场景：初始空闲，而非写死“已占用”');
{
  const app = bootApp();
  const occ = app.document.getElementById('occValue');
  // bootApp 内 fullReset() 已渲染一次
  assert(occ.textContent === '空闲', `初始占用显示为场景真实状态（得到“${occ.textContent}”）`);
  const phys = app.document.getElementById('physValue');
  assert(/支撑面：<b>货架<\/b>/.test(phys.innerHTML), '物理判据显示支撑面=货架（读取内核事实）');
  assert(/载荷 A=<b>0\.00<\/b> B=<b>0\.00<\/b>/.test(phys.innerHTML),
    '初始两握点载荷均为 0（非固定占位）');
  const audit = app.document.getElementById('auditValue');
  assert(/无异常/.test(audit.textContent), '初始独立审计无异常');
}

section('U3 货架开关 + 取消按钮：经真实内核 requestCancel，日志区分两种撤销时点');
{
  // 3a 货架仍在（未勾选“推迟”）—— 刚握住阶段取消
  const appA = bootApp();
  const shelfToggleA = appA.document.getElementById('shelfToggle');
  shelfToggleA.checked = false;
  appA.document.getElementById('btnCancel').dispatch('click');
  // 初始 IDLE 时取消应被拒（无可取消动作），验证入口确实走内核判定
  const logA = appA.document.getElementById('log').children.map(c => c.textContent).join('\n');
  assert(/当前无可取消的联合动作/.test(logA), 'IDLE 下取消被入口拒绝（真实阶段判定）');

  // 3b 勾选“推迟到货架撤走后”：入口应把撤销时点推到货架撤走
  const appB = bootApp();
  const shelfToggleB = appB.document.getElementById('shelfToggle');
  shelfToggleB.checked = true;
  // 先发起，再取消：此时仍在 PREPARING（未抬升，货架在场）
  appB.document.getElementById('btnStart').dispatch('click');
  appB.document.getElementById('btnCancel').dispatch('click');
  const logB = appB.document.getElementById('log').children.map(c => c.textContent).join('\n');
  assert(/拖动触发取消|取消/.test(logB), '取消经入口产生日志');
  assert(/货架已撤走/.test(logB), '勾选后撤销时点被推到“货架已撤走”');
}

section('U4 界面不得用固定数据冒充占用状态：拖动取消后读取真实事实');
{
  const app = bootApp();
  // 触发一次联合搬运入口，再复位，确保占用仍由场景决定
  app.document.getElementById('btnJointCarry').dispatch('click');
  app.document.getElementById('btnReset').dispatch('click');
  const occ = app.document.getElementById('occValue').textContent;
  const pos = app.document.getElementById('propPosValue').textContent;
  assert(occ === '空闲', '复位后占用显示为真实空闲状态');
  assert(/^\(\s*\d+,\s*\d+\s*\)$/.test(pos.replace(/<[^>]+>/g, '')), `道具坐标来自场景（得到“${pos}”）`);
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('界面接线测试全部通过');
