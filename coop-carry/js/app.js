/*
 * 应用层：把 Canvas 场景与协调内核接起来，渲染控件、调试视图、日志和结果区。
 * 控件由内核阶段驱动（enable/disable），任何拒绝/失败都回显到结果区与日志。
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const { CoopKernel, Phase, Support, Ownership } = CoopCarry;
  const SCENIOS = CarryScene.SCENIOS;

  const scene = new CarryScene($('stage'));
  const kernel = new CoopKernel(scene, { prepWindow: 900, commitWindow: 600, recoverTimeout: 480 });
  // UI 只展示内核物理事实；货架在场与否由内核裁决，再回灌给场景渲染
  kernel.on((type) => {
    if (type === 'shelf:change' || type === 'lift:done' || type === 'prop:state' ||
        type === 'cancel:done' || type === 'attempt:failed' || type === 'ownership:change') {
      scene.setShelfPresent(kernel.shelfPresent);
    }
  });

  const state = {
    auto: true,
    lastResult: null,
    logCount: 0,
  };

  /* ---------------- 日志 ---------------- */
  function log(msg, cls) {
    const box = $('log');
    const line = document.createElement('div');
    line.className = 'log-line' + (cls ? ' ' + cls : '');
    const t = (kernel.tickNo / 60).toFixed(2).padStart(6, '0');
    line.textContent = `t=${t}s ep=${kernel.epoch}  ${msg}`;
    box.appendChild(line);
    while (box.children.length > 120) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    state.logCount += 1;
  }

  function showResult(head, detail, ok) {
    const r = $('result');
    r.className = 'result ' + (ok === null ? 'idle' : ok ? 'ok' : 'fail');
    $('resultHead').textContent = head;
    $('resultDetail').textContent = detail;
    state.lastResult = { head, detail, ok };
  }

  /* ---------------- 内核事件 -> 日志 / 结果 ---------------- */
  kernel.on((type, d) => {
    switch (type) {
      case 'attempt:start':
        log(`发起协作（发起方 ${d.leader}），进入 PREPARING`, 'ev');
        showResult('联合动作进行中', `发起方 ${d.leader}：等待双方就位`, null);
        break;
      case 'agent:ready': log(`角色 ${d.agent} 声明 READY（姿态与接触点已校验）`, 'ok'); break;
      case 'both:ready': log('双方均 READY，等待 COMMIT 承诺', 'ok'); break;
      case 'agent:commit': log(`角色 ${d.agent} 发送 COMMIT`, 'ok'); break;
      case 'both:committed':
        log('双方 COMMIT 完成 -> COMMITTED，可以施力', 'ok');
        break;
      case 'agent:force': log(`角色 ${d.agent} 施加 FORCE`, 'ok'); break;
      case 'lift:done':
        log('双方施力齐备，抬升生效（仅此一次）-> LIFTING/CARRYING', 'strong');
        break;
      case 'agent:release': log(`角色 ${d.agent} RELEASE`, 'ev'); break;
      case 'phase:change': log(`阶段变更 -> ${d.phase}`, 'phase'); break;
      case 'prop:state': log(`道具状态 -> ${d.state}`, 'phase'); break;
      case 'support:lost':
        log(`角色 ${d.agent} 失去支撑（${d.reason}），启动裁决`, 'warn');
        break;
      case 'cancel:request':
        log(`角色 ${d.by} 发起取消（请求 + 回执握手）`, 'warn');
        break;
      case 'cancel:receipt':
        log(`取消回执到达：${d.by} 已松手`, 'msg');
        break;
      case 'cancel:hold':
        log(`取消进行中：${d.awaiting} 仍承重，道具保持 LIFTED（未单方脱手掉落）`, 'warn');
        break;
      case 'cancel:done':
        log(d.shelfLoaded
          ? `取消完成：双方松手但重量仍由货架承担（${d.result}）`
          : `取消完成：${d.result}，道具由双人共同放下`, 'strong');
        showResult(d.shelfLoaded ? '取消（货架承重）' : '取消（双人放下）',
          d.shelfLoaded
            ? '两人刚握住把手即取消：道具未落地，重量仍由货架承担'
            : '货架已撤走：同一份回执触发双人共同放下', d.shelfLoaded);
        break;
      case 'ownership:change':
        log(`物权 ${d.from} -> ${d.to}（${d.reason}）`, 'phase');
        break;
      case 'audit:error':
        log(`审计异常 [${d.code}] ${d.detail}`, 'fail');
        break;
      case 'arbitration':
        log(`裁决：${d.verdict} —— ${d.detail}`, 'warn');
        showResult('中断裁决', `${d.verdict}：${d.detail}`, false);
        break;
      case 'recover:resume': log('回滚到位，双方重新握住接触点，恢复 CARRYING', 'ok'); break;
      case 'rollback:arrived': break;
      case 'carry:arrived': log('道具到达目的地，等待双方 RELEASE', 'ok'); break;
      case 'attempt:done':
        log(`联合动作结束：${d.result}，道具=${d.prop}，位置=(${Math.round(d.at.x)},${Math.round(d.at.y)})`,
          d.result === 'PLACED_AT_DESTINATION' ? 'strong' : 'warn');
        if (d.result === 'PLACED_AT_DESTINATION') {
          showResult('联合搬运成功', '双方共同抬起、搬运并在目的地完成放置，目的地已占用', true);
        } else {
          showResult('联合搬运中断', `${d.result} @ (${Math.round(d.at.x)},${Math.round(d.at.y)})`, false);
        }
        break;
      case 'attempt:failed':
        log(`动作失败 [${d.code}] ${d.detail}`, 'fail');
        showResult('联合动作失败', `[${d.code}] ${d.detail}`, false);
        break;
      case 'action:rejected':
        log(`协议拒绝 [${d.code}] ${d.detail}`, 'fail');
        showResult('操作被协议拒绝', `[${d.code}] ${d.detail}`, false);
        break;
      case 'agent:abort': log(`角色 ${d.agent} 主动 ABORT：${d.reason || ''}`, 'warn'); break;
      case 'prop:external':
        log('检测到道具被外部移动，姿态承诺失效', 'warn');
        break;
      case 'contact:lost':
        log(`姿态约束告警：角色 ${d.agent} 接触点脱离（距离 ${d.dist}px）`, 'warn');
        break;
      case 'msg:deliver':
        log(`投递 ${d.from}->${d.to} ${d.type}（id=${d.id}）`, 'msg');
        break;
      case 'msg:duplicate':
        log(`重复消息被丢弃：${d.type}（id=${d.id}），不重复施加效果`, 'msg');
        break;
      case 'msg:stale': log(`过期 epoch 消息丢弃：${d.type}`, 'msg'); break;
      default: break;
    }
  });

  /* ---------------- 场景事件 ---------------- */
  scene.on((type, d) => {
    if (type === 'agent:arrived') {
      log(`角色 ${d.agent} 物理就位（可声明 READY）`, 'ev');
    } else if (type === 'rollback:arrived') {
      // 回滚到位：双方重新附着并通知内核恢复
      scene.reattachAgent('A');
      scene.reattachAgent('B');
      kernel.rollbackArrived();
    } else if (type === 'contact:lost') {
      // 真实姿态脱离直接映射为“失去支撑”，而非由全局布尔开关放行
      kernel.loseSupport(d.agent, '接触点姿态脱离');
    } else if (type === 'prop:dragged') {
      kernel.externalMove({ x: Math.round(d.x), y: Math.round(d.y) });
    } else if (type === 'cancel:requested') {
      requestCancelFromUi();
    }
  });

  /* 拖动取消事件：把撤销时点交给测试台的“货架状态”开关。
   * 货架仍在 -> 双方刚握住把手时取消；已撤走 -> 推迟到货架撤走后取消。 */
  function requestCancelFromUi() {
    if (kernel.phase === Phase.DONE || kernel.phase === Phase.ABORTED || kernel.phase === Phase.IDLE) {
      log('当前无可取消的联合动作', 'warn');
      return;
    }
    const by = selectedLeader();
    const shelf = $('shelfToggle').checked ? 'removed' : 'present';
    if (shelf === 'removed' && kernel.shelfPresent) {
      // 让测试台把撤销时点推到货架撤走之后：先撤货架再取消
      kernel.setShelf(false);
      scene.setShelfPresent(false);
    }
    log(`拖动触发取消：撤销时点 = ${shelf === 'removed' ? '货架已撤走' : '货架仍在（刚握住把手）'}`,
      'ev');
    kernel.requestCancel(by);
  }

  /* ---------------- 自动驱动：场景状态满足协议条件才推进，绝不替代姿态检查 ---------------- */
  function autoDrive() {
    if (!state.auto) return;
    const ph = kernel.phase;
    if (ph === Phase.PREPARING) {
      for (const a of ['A', 'B']) {
        const ag = scene.agents[a];
        if (ag.mode === 'IDLE' || ag.mode === 'DETACHED') scene.beginApproach(a);
        const pose = scene.agentPose(a);
        if (pose.ready && !kernel.attempt[a].ready) kernel.declareReady(a);
      }
      // READY 循环结束后重新读取阶段，避免第一个 COMMIT 推进阶段后第二个被误拒
      if (kernel.phase === Phase.PREPARING) {
        for (const a of ['A', 'B']) {
          if (kernel.attempt[a].ready && !kernel.attempt[a].committed) kernel.commit(a);
        }
      }
    } else if (ph === Phase.COMMITTED) {
      for (const a of ['A', 'B']) {
        if (!kernel.attempt[a].forced) kernel.applyForce(a);
      }
    } else if (ph === Phase.CARRYING) {
      if (scene.prop.x >= scene.slot.x - 3) {
        for (const a of ['A', 'B']) if (!kernel.attempt[a].released) kernel.release(a);
      }
    }
  }

  /* ---------------- 调试视图：每个参与者各自知道的阶段 ---------------- */
  function renderDebug() {
    const snap = kernel.debugSnapshot();
    $('phaseValue').textContent = snap.phase;
    $('epochValue').textContent = snap.epoch;
    $('propValue').textContent = snap.propState;
    $('busValue').textContent = snap.busDepth;
    $('tickValue').textContent = snap.tick;
    const rows = snap.agents.map(s => `
      <tr>
        <td class="ag-${s.agent}">${s.agent}${s.isLeader ? ' ★' : ''}</td>
        <td>${s.knowsPhase}</td>
        <td>${s.knowsProp}</td>
        <td>${s.ready ? '✓' : '·'} / ${s.committed ? '✓' : '·'} / ${s.forced ? '✓' : '·'} / ${s.released ? '✓' : '·'}</td>
        <td>${s.attached ? '附着' : '脱离'}</td>
        <td>(${s.pose.x},${s.pose.y}) ${s.pose.contactOK ? '接触✓' : '接触✗'}</td>
        <td>${s.lastMsg}</td>
      </tr>`).join('');
    $('debugRows').innerHTML = rows;

    // 结果区补充占用状态
    $('occValue').textContent = scene.destinationOccupied() ? '已占用（道具在槽内）' : '空闲';
    $('propPosValue').textContent =
      `(${Math.round(scene.prop.x)}, ${Math.round(scene.prop.y)})`;
    $('fitValue').textContent = scene.canPlaceHere(scene.prop.x, scene.prop.y)
      ? '当前位置可放下' : '当前位置无剩余空间';

    // 物件支撑面与握点载荷：直接读内核物理事实，不用固定数据
    const pose = kernel.propPose();
    const el = $('physValue');
    if (el) {
      const supportLabel = {
        SHELF: '货架', PAIR: '双握点', SINGLE: '单握点', GROUND: '地面',
      }[pose.support] || pose.support;
      const ownLabel = {
        SHELF: '货架', PAIR: '双人', GROUND: '地面',
      }[pose.ownership] || pose.ownership;
      el.innerHTML = `支撑面：<b>${supportLabel}</b> · 物权：<b>${ownLabel}</b> · ` +
        `载荷 A=<b>${pose.loads.A.toFixed(2)}</b> B=<b>${pose.loads.B.toFixed(2)}</b>` +
        ` · 货架${pose.shelfPresent ? '在场' : '已撤走'}`;
    }
    const audit = kernel.auditInvariants();
    const auditEl = $('auditValue');
    if (auditEl) {
      if (audit.length === 0) {
        auditEl.textContent = '无异常：道具仅被合法阶段驱动，支撑/载荷/物权一致';
        auditEl.className = 'ok-text';
      } else {
        auditEl.textContent = audit.map(p => `[${p.code}] ${p.detail}`).join('；');
        auditEl.className = 'fail-text';
      }
    }
    const ownEl = $('ownershipValue');
    if (ownEl) {
      const transfers = kernel.ownershipLog.filter(e => e.to === 'PAIR');
      ownEl.textContent = transfers.length === 0
        ? '尚未发生物权转移'
        : `SHELF->PAIR 共 ${transfers.length} 次` +
          (transfers.length === 1 ? '（每 epoch 至多一次）' : '（异常：应至多一次）');
    }
  }

  /* ---------------- 控件启用/禁用由内核阶段驱动 ---------------- */
  function refreshControls() {
    const ph = kernel.phase;
    const idle = ph === Phase.IDLE;
    const doneLike = ph === Phase.DONE || ph === Phase.ABORTED;
    $('btnStart').disabled = !idle;
    $('btnJointCarry').disabled = !(idle || doneLike);
    $('btnSolo').disabled = !(ph === Phase.PREPARING || ph === Phase.IDLE);
    $('btnAbort').disabled = idle || doneLike;
    $('btnCancel').disabled = idle || doneLike;
    $('btnExternal').disabled = ph === Phase.DONE || ph === Phase.ABORTED;
    const manual = !state.auto;
    for (const a of ['A', 'B']) {
      const st = kernel.attempt[a];
      $('btnApproach' + a).disabled = !manual || !(ph === Phase.PREPARING) ||
        (scene.agents[a].mode !== 'IDLE' && scene.agents[a].mode !== 'DETACHED');
      $('btnReady' + a).disabled = !manual || ph !== Phase.PREPARING || st.ready;
      $('btnCommit' + a).disabled = !manual || ph !== Phase.PREPARING || !st.ready || st.committed;
      $('btnForce' + a).disabled = !manual ||
        !(ph === Phase.COMMITTED || ph === Phase.LIFTING) || st.forced;
      $('btnRelease' + a).disabled = !manual ||
        !(ph === Phase.CARRYING || ph === Phase.PLACING) || st.released;
      $('btnDetach' + a).disabled = !(ph === Phase.CARRYING || ph === Phase.RECOVERING);
      $('btnReattach' + a).disabled = scene.agents[a].mode !== 'DETACHED';
    }
  }

  /* ---------------- 控件绑定 ---------------- */
  function selectedLeader() { return $('leaderSelect').value; }

  $('btnStart').addEventListener('click', () => {
    const r = kernel.start(selectedLeader());
    if (r.ok) {
      scene._notifyArrived = { A: false, B: false };
      if (state.auto) {
        scene.beginApproach('A');
        scene.beginApproach('B');
      }
    }
  });

  for (const a of ['A', 'B']) {
    $('btnApproach' + a).addEventListener('click', () => scene.beginApproach(a));
    $('btnReady' + a).addEventListener('click', () => kernel.declareReady(a));
    $('btnCommit' + a).addEventListener('click', () => kernel.commit(a));
    $('btnForce' + a).addEventListener('click', () => kernel.applyForce(a));
    $('btnRelease' + a).addEventListener('click', () => kernel.release(a));
    $('btnDetach' + a).addEventListener('click', () => {
      scene.detachAgent(a);
      kernel.loseSupport(a, '手动注入：角色脱离接触点');
    });
    $('btnReattach' + a).addEventListener('click', () => scene.reattachAgent(a));
  }

  // 核心反例：一方试图在另一方未承诺时独自抬起 —— 必须被拒绝，道具不能瞬移
  $('btnSolo').addEventListener('click', () => {
    const a = selectedLeader();
    if (kernel.phase === Phase.IDLE) {
      showResult('协议拒绝', 'SOLO_LIFT_BLOCKED：协作尚未发起，任何角色都不能搬道具', false);
      log('单方强抬被拒：协作尚未发起', 'fail');
      return;
    }
    kernel.applyForce(a);
  });

  $('btnAbort').addEventListener('click', () => kernel.abort(selectedLeader(), '手动中止'));

  $('btnCancel').addEventListener('click', () => requestCancelFromUi());

  // 联合搬运图形入口：按钮直接调用内核 start/协作，不得用固定数据冒充
  $('btnJointCarry').addEventListener('click', () => {
    if (kernel.phase !== Phase.IDLE && kernel.phase !== Phase.DONE &&
        kernel.phase !== Phase.ABORTED) {
      log('联合搬运：当前已有动作在进行，先复位或等待结束', 'warn');
      return;
    }
    // 复位任何残留，再以“手动选择角色”为发起方，经真实协议入口启动
    if (kernel.phase === Phase.DONE || kernel.phase === Phase.ABORTED) fullReset();
    const leader = selectedLeader();
    const r = kernel.start(leader);
    if (r.ok) {
      scene._notifyArrived = { A: false, B: false };
      scene.beginApproach('A');
      scene.beginApproach('B');
      log(`联合搬运：由界面按钮发起（发起方 ${leader}，epoch=${r.epoch}）`, 'strong');
      showResult('联合搬运进行中', `发起方 ${leader}：正在按真实协议推进`, null);
    }
  });

  $('btnExternal').addEventListener('click', () => {
    const nx = Math.min(scene.W - 60, scene.prop.x + 90);
    scene.prop.x = nx;
    scene.prop.y = scene.prop.y;
    kernel.externalMove({ x: Math.round(nx), y: Math.round(scene.prop.y) });
  });

  $('btnReset').addEventListener('click', () => fullReset());

  $('autoToggle').addEventListener('change', e => {
    state.auto = e.target.checked;
    log(`模式切换：${state.auto ? '自动（满足姿态即推进协议）' : '手动（逐协议按钮驱动）'}`, 'ev');
  });

  // 货架开关：决定拖动取消的撤销时点是“刚握住把手”还是“货架已撤走”
  $('shelfToggle').addEventListener('change', e => {
    kernel.setShelf(!e.target.checked);
    scene.setShelfPresent(!e.target.checked);
    log(e.target.checked
      ? '测试台：取消将推迟到货架已撤走之后'
      : '测试台：取消发生在两人刚握住把手时（货架仍在承重）', 'ev');
  });

  $('delayRange').addEventListener('input', e => {
    kernel.msgDelay = Number(e.target.value);
    $('delayValue').textContent = kernel.msgDelay;
  });

  $('dupToggle').addEventListener('change', e => {
    kernel.duplicateEvery = e.target.checked ? 3 : 0;
    log(e.target.checked ? '开启重复投递（每 3 条复制 1 条，验证幂等去重）' : '关闭重复投递', 'msg');
  });

  /* ---------------- 案例选择 ---------------- */
  Object.entries(SCENIOS).forEach(([key, cfg]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = cfg.name;
    $('scenarioSelect').appendChild(opt);
  });
  $('scenarioSelect').addEventListener('change', e => {
    fullReset();
    scene.applyScenario(SCENIOS[e.target.value]);
    log(`载入案例：${SCENIOS[e.target.value].name}`, 'ev');
    showResult('案例已载入', SCENIOS[e.target.value].name + ' —— 选择发起方并点击“发起协作”', null);
  });

  function fullReset() {
    kernel.reset();
    scene.clearFaults();
    scene.reset();
    scene.setShelfPresent(kernel.shelfPresent);
    $('shelfToggle').checked = false;
    refreshControls();
    renderDebug();
    log('系统复位', 'ev');
    showResult('就绪', '选择角色作为发起方，点击“发起协作”开始联合搬运', null);
  }

  /* ---------------- 主循环 ---------------- */
  let last = performance.now();
  let acc = 0;
  const STEP = 1000 / 60;
  function frame(now) {
    acc += Math.min(100, now - last);
    last = now;
    while (acc >= STEP) {
      scene.update();
      kernel.tick();
      autoDrive();
      acc -= STEP;
    }
    scene.render(kernel.phase, kernel.propState);
    renderDebug();
    refreshControls();
    requestAnimationFrame(frame);
  }

  fullReset();
  requestAnimationFrame(frame);
})();
