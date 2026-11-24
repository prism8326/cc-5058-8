# 双角色联合搬运 · Coop Carry

显式协议驱动的双人联合搬运动作模块。两名角色必须**共同就位 → 共同承诺 → 共同施力**
才能抬起共享道具；任何单方施力、错误阶段、重复消息、迟到回执都会被协议拒绝或审计暴露。

## 图形入口（主要入口）

浏览器打开 `index.html` 即可。

- **联合搬运（图形入口）**：在“发起方”下拉框手动选择 A/B，点击该按钮，按钮会调用内核
  真实的 `start(leader)` 进入协议流程——不是回放固定数据，结果区显示的目的地占用、
  道具坐标、阶段均来自真实场景与内核。
- **发起协作 / 手动协议控件**：可逐角色、逐阶段手动驱动 READY / COMMIT / FORCE / RELEASE。
- **拖动取消**：在画布上**抓住道具的把手/接触点并拖动**会发起一次取消（请求 + 回执）；
  抓道具中部拖动则是“外部移动”。测试台的“取消推迟到货架撤走后”勾选框决定撤销时点：
  - 不勾选：取消发生在**两人刚握住把手**时，重量仍由货架承担，道具不落地；
  - 勾选：取消推迟到**货架已撤走**后，同一份回执触发**双人共同放下**（或缺回执时继续承重）。
- **物件支撑面与独立判据**面板直接读取内核的支撑面、握点载荷、物权与不变量审计结果，
  任何坏结果都会以红色显示。

## 命令行（仅辅助）

```bash
node tools/coop-cli.js --scenario balanced              # 回放标准协作直到结束
node tools/coop-cli.js --scenario noSpace               # 无空间 -> 共同回滚
node tools/coop-cli.js --leader B --cancel-at committed # 刚握住把手时取消
node tools/coop-cli.js --cancel-at lifted               # 货架撤走后取消
node tools/coop-cli.js --json                           # 机器可读输出
```

命令行只用于在终端快速回放与查看道具姿态 / 阶段资格 / 审计，**图形入口仍在 `index.html`**。

## 测试

```bash
node tests/kernel.test.js              # 内核协议、幂等、裁决
node tests/scene.smoke.js              # 场景集成冒烟（六个预设案例）
node tests/cancel.trajectory.test.js   # 取消 / 承重 / 物权轨迹 + 迟到与失败注入
node tests/event.walker.test.js        # 双人短事件遍历器：交换取消/抬升回执
node tests/coop.acceptance.test.js     # 协作阶段验收：期望值独立推导 + 受控错误
node tests/ui.wiring.test.js           # 界面接线：按钮调用真实内核、拒绝固定数据
node tests/ui.drag.test.js             # 场景级拖动取消：两种撤销时点
node tests/ui.flow.test.js             # 界面全流程：真实帧循环就位->抬升->放置
node tests/cli.helper.test.js          # 命令行辅助输出对应真实执行证据
```

或一次跑全部：`npm test`（见 `package.json`）。

## 协议与物理事实

- 阶段：`IDLE → PREPARING → COMMITTED → LIFTING → CARRYING → PLACING → DONE`，
  异常分支 `RECOVERING`（失去支撑裁决）、`CANCELLING`（货架撤走后的取消）。
- **货架承重**：抬起前重量由货架承担（两握点载荷为 0）；双方 FORCE 齐备的瞬间撤走货架、
  物权 `SHELF → PAIR`，每 epoch 至多一次。
- **取消回执**按“重量是否已在握点上”裁决：未抬起则留在货架/地面；已抬起且回执齐备则
  双人共同放下，仅单方回执则另一方独自承重、绝不坠落。
- 独立判据：`propPose()`（支撑面/载荷/物权）、`phaseEligibility()`（阶段资格）、
  `auditInvariants()`（重量守恒、单手握持、物权转移次数等）互相校验，均不回读阶段字符串自证。
