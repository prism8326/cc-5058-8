/*
 * 命令行辅助测试：确保 tools/coop-cli.js 仅作辅助，且输出对应真实执行证据。
 * 运行：node tests/cli.helper.test.js
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n[' + name + ']'); }

const cli = path.join(__dirname, '..', 'tools', 'coop-cli.js');
function runCli(args) {
  const out = execFileSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

section('C1 标准协作：CLI 输出与真实场景终态一致（非固定数据）');
{
  const out = runCli(['--scenario', 'balanced']);
  assert(out.phase === 'DONE' && out.propState === 'PLACED', 'CLI 报告 DONE/PLACED');
  assert(out.destinationOccupied === true, '目的地占用来自场景');
  assert(Math.abs(out.propPos.x - 728) < 4, '道具坐标落在放置槽（来自真实场景）');
  assert(out.audit.length === 0, 'CLI 独立审计无异常');
}

section('C2 刚握住把手时取消：CLI 显示货架/地面承重，道具不落地');
{
  const out = runCli(['--scenario', 'balanced', '--cancel-at', 'committed']);
  assert(out.phase === 'ABORTED', 'committed 时点取消 -> ABORTED');
  assert(out.propPose.support === 'SHELF', '支撑面仍为货架（未落到握点）');
  assert(out.propPose.loads.A === 0 && out.propPose.loads.B === 0, '两握点载荷 0');
  assert(out.destinationOccupied === false, '目的地未占用');
}

section('C3 货架撤走后取消：CLI 显示双人放下');
{
  const out = runCli(['--scenario', 'balanced', '--cancel-at', 'lifted']);
  assert(out.phase === 'DONE' && out.propState === 'DROPPED', 'lifted 时点取消 -> DONE/DROPPED');
  assert(out.propPose.support === 'GROUND' && out.propPose.ownership === 'GROUND',
    '放下后承重/物权交给地面');
  assert(out.audit.length === 0, 'CLI 独立审计无异常');
}

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
console.log('命令行辅助测试全部通过');
