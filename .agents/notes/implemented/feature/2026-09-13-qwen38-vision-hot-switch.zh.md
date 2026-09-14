# Agent Note: Qwen3.8 vision capability and in-session hot switch

Status: implemented

[English](2026-09-13-qwen38-vision-hot-switch.md) | 中文

## Problem

本地 `qwen38` 路由指向一个长时间运行的 Qwen3.8 llama-server 进程。该进程未加载多模态投影器时仍可提供文本服务，但会报告 `modalities.vision: false`。如果只在 Harness 目录中声明图片输入，客户端会放行图片，而服务端仍无法处理。编程轮次进行中重启进程还会丢弃当前请求。

## Decision

`Qwen3.8-27B-Q3` 与 `Qwen3.8-27B-Q2` 都通过现有的[统一图片请求管线](2026-08-20-unified-image-request-pipeline.zh.md)声明 `text` 和 `image` 输入。默认提供方、模型、端点和会话选择保持不变，因此运行中的会话继续使用原模型身份和持久历史。

现有 llama-server 进程先完成当前请求，再在保留原有参数的基础上追加匹配的投影器和 `--no-mmproj-offload` 重启。图片解码和投影器计算都在 CPU 上完成，只有图片嵌入会进入 GPU 语言模型推理；如果版本暴露 `--mmproj-device`，则使用 `--mmproj-device none` 作为显式等价参数。发送图片前，操作员确认 `GET /props` 报告 `modalities.vision: true`。Harness Web 进程保持运行；设置监听器会采用支持图片的模型目录，同一会话的下一条请求可以携带图片，无需产生模型切换提示。投影器路径取决于部署环境；脚手架记录了此路由使用的 Qwen3.8-27B BF16 文件名。

Windows 自启动包装器使用同样的 CPU-only 投影器参数，只有在 `/health` 成功且 `/props` 报告 `modalities.vision: true` 后才把端点标记为就绪。CUDA 显存不足时，重试会降低 `--n-gpu-layers` 或 `--ctx-size`，同时保留 CPU 投影器；绝不会静默退回纯文本进程。

## Alternatives considered

**只修改 Harness 目录。** 这样只能通过客户端模态检查，却仍留下纯文本服务端，提供方会拒绝请求。因此把路由元数据和服务端投影器视为一个运维变更。

**立即重启服务端。** 这会中断正在进行的编程请求并丢失进行中的响应。等待当前请求完成可以保留会话，只把中断限制在服务端重启窗口。

**通过当前 HTTP 端点热加载投影器。** 部署的端点没有暴露 llama-server 的模型加载操作，因此可用的切换方式是受控地重启同一进程和端口。

**把投影器卸载到 GPU。** 这可能改变 Q3 模型现有的显存分配并触发显存不足。`--no-mmproj-offload` 将投影器保留在系统内存中，代价是约 1 GB RAM。

**切换会话到独立的视觉模型路由。** 路由切换会产生模型切换提示，并在编程过程中改变活动模型。保持同一个 Qwen3.8 模型可以保留提示历史和选择语义。

## Consequences

当前编程轮次不中断，服务端重启后同一会话继续运行。在远端进程报告 `modalities.vision: true` 之前，视觉请求仍不可用；只改本地元数据并不能完成启用。CPU 投影器会增加启动时间和系统内存占用，而 `--no-mmproj-offload` 可保持 Q3 模型显存分配稳定。自启动在能力未就绪时失败关闭，OOM 重试可能牺牲生成速度或上下文容量来换取余量。不需要重启 Harness Web，也不需要迁移持久会话。
