# Agent Note：turn-continuation guard 必须向状态观察者报告其续跑回合处于 running

Status: implemented

[English](2026-09-04-turn-continuation-reports-running.md) | 中文

## 问题

[输出 token 截断后的自动续跑](../feature/2026-08-28-turn-continuation-after-truncation.zh.md) 在处理 agent 的 `agent/status` idle 边沿时，通过 `Agent.followup()` 入队续跑。`followup` 会同步唤醒 driver，而 `wakeDriver` 会把 idle 的 agent 转为 running，从而发出 `agent/status` running —— 这是一次嵌套在尚未结束的外层 idle 派发之内的 emit。guard 的 idle 监听器与会话控制器的状态转发器都是普通的 `agent/status` 监听器，而 Cordis 的 emit 是同步的：嵌套 emit 会按监听器顺序与外层派发交错执行。

在发布的 bundle 中，guard 先于会话控制器挂载，因此在外层 idle 派发时转发器本应已经执行过 —— 但在有 bug 的版本里，guard 同步的 `followup` 会在外层派发推进到转发器*之前*就触发了嵌套的 running emit。于是转发器先观察到嵌套的 running 边沿、再观察到外层的 idle 边沿，最终净值为 idle。注册在 guard 之后的状态观察者 —— Web 会话控制器 —— 便把续跑回合报告为 idle，于是对一个实际仍在运行的回合，编辑器（composer）的 Stop 按钮在整个回合期间都消失了。模型可见输出与会话事件都是正确的；只有传播出去的 running 状态是错的。

## 决定

guard 通过把 `Agent.followup()` 调度到一个微任务（microtask），将续跑唤醒推迟到当前 `agent/status` 派发之后。`pending` 标志仍在 idle 处理器中同步清除，因此投递对一次截断所产生的任意多条 idle 边沿保持幂等；只有 `followup` 调用移出了派发路径。外层 idle 派发结束后，微任务执行 `followup`，agent 转为 running，该 running 边沿在 idle 边沿*之后*发出 —— 于是所有监听器（包括转发器）都会观察到续跑回合处于 running，观察者的最终状态是 running 而非被掩盖的 idle。延迟调用中的入队失败仍会清除链并告警，与之前完全一致。该推迟只占一个微任务 tick：它不改变任何模型可见输出或会话事件，只改变 running 边沿到达监听器的顺序。

## 权衡过的替代方案

- **依赖监听器注册顺序**（把 guard 的监听器放到转发器之后，或让转发器最先）—— 弃用，因为注册顺序不是强制机制，且随 bundle 分层而不同；修复必须与挂载顺序无关。
- **让状态转发器忽略紧跟在续跑之后的那条 idle 边沿** —— 弃用，因为这会把截断的 idle/running 核算推给会话控制器，把该消费者与 guard 内部耦合起来。
- **为唤醒单独发一条状态事件** —— 弃用，因为 agent 本来就会发出 running 转换；缺陷只在于重入式交错，把唤醒推迟掉即可修复，无需新增事件面。

## 后果

- 注册在 guard 之后的状态观察者（包括 Web 会话控制器）会把截断回合的续跑观察为 running，于是 composer 在整个恢复回合期间都保留 Stop 按钮。
- 续跑仍在整个 agent idle 时入队且保持幂等；该推迟不改变任何模型可见输出、会话事件或快照。
- 延迟唤醒中的入队失败仍被 guard 内部捕获，并以渲染后的错误上报。

## 测试

`packages/guard/turn-continuation/tests/turn-continuation.spec.ts` 中的单元测试新增了一个回归用例：驱动真实的 agent loop 与 guard，在 guard 之后订阅一个状态观察者，断言对于一个会换来一次续跑的截断回合，观察者记录为 `[running, idle, running, idle]` —— 证明 running 边沿没有被外层 idle 边沿掩盖。该包对 `src/` 保持逐文件 100% 的语句、分支、函数与行覆盖。
