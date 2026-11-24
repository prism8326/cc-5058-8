#!/usr/bin/env node
/*
 * 命令行辅助：仅用于辅助“联合搬运”，不是主要入口。
 * 图形入口见 index.html 的“联合搬运（图形入口）”按钮；本脚本用于在终端快速
 * 回放一个场景并打印道具姿态、阶段资格与独立审计结果。
 *
 * 用法：
 *   node tools/coop-cli.js                 # 标准协作，自动驱动到结束
 *   node tools/coop-cli.js --scenario noSpace
 *   node tools/coop-cli.js --leader B --cancel-at committed
 *   node tools/coop-cli.js --cancel-at lifted
 *   node tools/coop-cli.js --json          # 机器可读输出
 */
'use strict';

const path = require('path');
const { CoopKernel, Phase } = require(path.join(__dirname, '..', 'js', 'kernel.js'));

function parseArgs(argv) {
  const args = { scenario: 'balanced', leader: 'A', cancelAt: null, json: false, maxTicks: 2400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') args.scenario = argv[++i];
    else if (a === '--leader') args.leader = argv[++i];
    else if (a === '--cancel-at') args.cancelAt = argv[++i];
    else if (a === '--max-ticks') args.maxTicks = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`联合搬运命令行辅助（图形入口请用 index.html）
选项：
  --scenario <key>   场景：balanced | longPath | blocked | external | spaceDrop | noSpace
  --leader <A|B>     发起方（默认 A）
  --cancel-at <when> committed（刚握住把手）| lifted（货架撤走后）
  --max-ticks <n>    最大模拟帧数
  --json             输出 JSON
  -h, --help         显示帮助`);
}

/* 用最小 Canvas 桩加载真实场景 */
function loadScene() {
  const noop = () => {};
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 0 });
      return typeof p === 'string' ? noop : undefined;
    },
    set() { return true; },
  });
  const canvas = {
    width: 880, height: 560,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 880, height: 560 }),
    addEventListener: () => {},
  };
  global.document = { getElementById: () => canvas };
  const { CarryScene } = require(path.join(__dirname, '..', 'js', 'scene.js'));
  return new CarryScene(canvas);
}

function run(args) {
  const scene = loadScene();
  const scenarios = scene.constructor.SCENIOS;
  if (!scenarios[args.scenario]) throw new Error('未知场景 ' + args.scenario);
  scene.applyScenario(scenarios[args.scenario]);

  const kernel = new CoopKernel(scene, { prepWindow: 1200, commitWindow: 800, recoverTimeout: 480 });
  if (args.cancelAt) kernel.msgDelay = 6; // 让取消回执经总线延迟到达

  scene.on((type, d) => {
    if (type === 'rollback:arrived') {
      scene.reattachAgent('A'); scene.reattachAgent('B');
      kernel.rollbackArrived();
    } else if (type === 'contact:lost') {
      kernel.loseSupport(d.agent, '接触点姿态脱离');
    }
  });

  kernel.start(args.leader);
  let cancelled = false;

  for (let i = 0; i < args.maxTicks; i++) {
    scene.beginApproach('A');
    scene.beginApproach('B');
    scene.update();
    kernel.tick();

    const ph = kernel.phase;

    // 取消判定必须在自动驱动之前：否则同一帧内 COMMITTED 会被推进到抬升，
    // 就错过“刚握住把手（货架仍在）”的撤销时点。
    if (args.cancelAt && !cancelled) {
      if (args.cancelAt === 'committed' && ph === Phase.COMMITTED) {
        cancelled = true; kernel.requestCancel(args.leader);
      } else if (args.cancelAt === 'lifted' && ph === Phase.CARRYING &&
        kernel.propPose().support === 'PAIR') {
        cancelled = true; kernel.requestCancel(args.leader);
      }
    }

    const afterCancel = kernel.phase;
    if (afterCancel === Phase.PREPARING) {
      for (const a of ['A', 'B']) {
        const pose = scene.agentPose(a);
        if (pose.ready && !kernel.attempt[a].ready) kernel.declareReady(a);
        if (kernel.attempt[a].ready && !kernel.attempt[a].committed) kernel.commit(a);
      }
    } else if (afterCancel === Phase.COMMITTED) {
      for (const a of ['A', 'B']) if (!kernel.attempt[a].forced) kernel.applyForce(a);
    }

    if (kernel.phase === Phase.CARRYING && !args.cancelAt) {
      if (scene.prop.x >= scene.slot.x - 3) {
        for (const a of ['A', 'B']) if (!kernel.attempt[a].released) kernel.release(a);
      }
    }
    if (['DONE', 'ABORTED'].includes(kernel.phase)) {
      if (!run._tail) run._tail = 0;
      if (++run._tail > 30) break;
    }
  }

  const pose = kernel.propPose();
  const eligibility = { A: kernel.phaseEligibility('A'), B: kernel.phaseEligibility('B') };
  const out = {
    scenario: args.scenario,
    leader: args.leader,
    phase: kernel.phase,
    propState: kernel.propState,
    propPose: pose,
    eligibility,
    audit: kernel.auditInvariants(),
    propPos: { x: Math.round(scene.prop.x), y: Math.round(scene.prop.y) },
    destinationOccupied: scene.destinationOccupied(),
  };

  if (args.json) { console.log(JSON.stringify(out, null, 2)); return out; }

  console.log(`场景: ${scenarios[args.scenario].name}  发起方: ${args.leader}`);
  console.log(`最终阶段: ${out.phase}  道具: ${out.propState}`);
  console.log(`道具坐标: (${out.propPos.x}, ${out.propPos.y})  目的地占用: ${out.destinationOccupied}`);
  console.log(`支撑面: ${pose.support}  物权: ${pose.ownership}` +
    `  握点载荷 A=${pose.loads.A.toFixed(2)} B=${pose.loads.B.toFixed(2)}` +
    `  货架: ${pose.shelfPresent ? '在场' : '撤走'}`);
  console.log('阶段资格:');
  for (const a of ['A', 'B']) {
    const e = eligibility[a];
    console.log(`  ${a}: ready=${e.canReady} commit=${e.canCommit} force=${e.canForce}` +
      ` release=${e.canRelease} cancel=${e.canCancel}`);
  }
  if (out.audit.length === 0) console.log('独立审计: 无异常');
  else out.audit.forEach(p => console.log(`独立审计异常 [${p.code}] ${p.detail}`));
  return out;
}

if (require.main === module) {
  try {
    const out = run(parseArgs(process.argv.slice(2)));
    process.exit(out.audit.length === 0 ? 0 : 2);
  } catch (e) {
    console.error('错误：' + e.message);
    process.exit(1);
  }
}

module.exports = { run };
