/*
 * 界面全流程集成测试（无头）
 * ------------------------------------------------------------------
 * 用 DOM 桩加载真实 app.js，并驱动其真实帧循环（rAF 桩为可手动步进），
 * 验证“联合搬运（图形入口）”按钮经真实协议推进：就位 -> 抬升 -> 放置，
 * 期间物理面板（支撑面/载荷/物权/占用）随真实内核事实变化，而非固定数据。
 * 运行：node tests/ui.flow.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n[' + name + ']'); }

function makeCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 0 });
      return typeof p === 'string' ? noop : undefined;
    },
    set() { return true; },
  });
}

class El {
  constructor(id) {
    this.id = id; this.children = []; this._text = ''; this.innerHTML = '';
    this.className = ''; this.disabled = false; this.checked = false; this.value = '';
    this.scrollTop = 0; this.scrollHeight = 0; this.listeners = {}; this.style = {};
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.innerHTML = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ target: this, ...ev }); }
  get firstChild() { return this.children[0]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 880, height: 560 }; }
  getContext() { return makeCtx(); }
}
El.prototype.width = 880;
El.prototype.height = 560;

function boot() {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) {
        const el = new El(id);
        if (id === 'leaderSelect') el.value = 'A';
        if (id === 'autoToggle') el.checked = true;
        els.set(id, el);
      }
      return els.get(id);
    },
    createElement(tag) { return new El(tag); },
  };
  let rafCb = null;
  let nowMs = 0;
  const win = {
    document, console,
    performance: { now: () => nowMs },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  };
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  for (const f of ['js/kernel.js', 'js/scene.js', 'js/app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  // 手动步进：每次推 20ms（约 1.2 帧），触发闭包内的 frame()
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      nowMs += 20;
      const cb = rafCb; rafCb = null;
      if (cb) cb(nowMs);
    }
  };
  return { document, step, els };
}

section('F1 图形入口全流程：按钮 -> 真实协议推进到放置，物理面板随之变化');
{
  const app = boot();
  const leader = app.document.getElementById('leaderSelect');
  leader.value = 'A';
  app.document.getElementById('btnJointCarry').dispatch('click');

  // 推进足够多帧让真实场景走完就位 -> 抬升 -> 搬运 -> 放置
  app.step(4000);

  const phase = app.document.getElementById('phaseValue').textContent;
  const occ = app.document.getElementById('occValue').textContent;
  const audit = app.document.getElementById('auditValue').textContent;
  const phys = app.document.getElementById('physValue').innerHTML;
  const own = app.document.getElementById('ownershipValue').textContent;

  assert(phase === 'DONE', `真实帧循环把阶段推进到 DONE（得到 ${phase}）`);
  assert(occ === '已占用（道具在槽内）', `目的地占用来自真实场景（得到“${occ}”）`);
  assert(/SHELF->PAIR 共 1 次/.test(own), `物权只转移一次（得到“${own}”）`);
  assert(/支撑面：<b>地面<\/b>/.test(phys), '放置后支撑面=地面（物理事实）');
  assert(/无异常/.test(audit), `全流程独立审计无异常（得到“${audit}”）`);
}

section('F2 抬升瞬间：物理面板显示双握点各半，而非固定文本');
{
  const app = boot();
  app.document.getElementById('btnJointCarry').dispatch('click');
  // 逐帧推进，捕捉“双握点承重”的中间态
  let sawPair = false;
  for (let i = 0; i < 4000; i++) {
    app.step(1);
    const phys = app.document.getElementById('physValue').innerHTML;
    if (/支撑面：<b>双握点<\/b>/.test(phys) &&
        /载荷 A=<b>0\.50<\/b> B=<b>0\.50<\/b>/.test(phys)) {
      sawPair = true;
      break;
    }
    const phase = app.document.getElementById('phaseValue').textContent;
    if (phase === 'DONE' || phase === 'ABORTED') break;
  }
  assert(sawPair, '搬运过程中真实出现过“支撑面=双握点、两握点各 0.50”');
}

section('F3 复位后物理面板回到真实初始值（非缓存/固定数据）');
{
  const app = boot();
  app.document.getElementById('btnJointCarry').dispatch('click');
  app.step(4000);
  app.document.getElementById('btnReset').dispatch('click');
  const phys = app.document.getElementById('physValue').innerHTML;
  const occ = app.document.getElementById('occValue').textContent;
  assert(/支撑面：<b>货架<\/b>/.test(phys), '复位后支撑面=货架');
  assert(/载荷 A=<b>0\.00<\/b> B=<b>0\.00<\/b>/.test(phys), '复位后两握点载荷归零');
  assert(occ === '空闲', '复位后目的地空闲');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('界面全流程集成测试全部通过');
