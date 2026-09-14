# Qwen3.8 本地构建脚手架（专用 fork）

[English](README.md) | 中文

本 fork 把 deepseek-harness 的**本地构建**默认改为直连自建 Qwen3.8-27B（llama-server，OpenAI 兼容端点 `openai-completions`），agent 默认模型、标题生成、会话压缩全部走本地模型，不再依赖 DeepSeek 官方 API。

## 相对上游的改动

| 提交 / 文件 | 内容 |
| --- | --- |
| `packages/bundle/base/cordis.patch.yml` | `llm-pi-ai` 预置 `qwen38` 路由（Q3 + Q2 双模型，支持文本与图片输入，`apiKeyEnv: QWEN38_API_KEY` 占位 key）；`agent-default-model` 默认 `qwen38 / Qwen3.8-27B-Q3`。web 与 headless 全部生效 |
| `4650696ee8` Fix compaction reasoning routing | 压缩（compaction）摘要请求在非 DeepSeek 协议下的 reasoning 路由修复 |
| `10b7f1fb3c` Restore legacy code preset sessions | 旧 code/PTC 预设会话恢复加载 |
| `packages/client/locale`、`apps/web`、ui-sidebar 测试/快照 | Web GUI 品牌名改为 **Qwen Agent**：侧栏左上角名称（`brand.localBuild` 词条，zh/en 同步）与浏览器标签页标题（`DEFAULT_CLIENT_TITLE`）。鲸鱼 logo 与 `ui-brand-official` 占位不变；改动仅 locale 文案 + Vite 标题常量，重新 `pnpm run build` 后刷新页面即生效 |

## 快速开始

前置条件：

- llama-server 已加载 Qwen3.8-27B 及匹配的 `mmproj` 投影器，OpenAI 端点默认为 `http://192.168.2.123:8098/v1`
- Node `^22.19 || >=24`，pnpm 11.7（根 `package.json` 的 `packageManager` 锁定）

```sh
pnpm install
pnpm run build        # first run needs to emit each package's lib/
pnpm dsh web --port 3080
```

如果 llama-server 已在运行，请等当前请求完成后再重启；保留原有模型和服务参数，并追加匹配的视觉投影器：

```powershell
--mmproj "C:\Users\pss\AI\models\mmproj-Qwen3.8-27B-BF16.gguf" --no-mmproj-offload
```

`--no-mmproj-offload` 让图片解码和约 1 GB 的投影器都留在 CPU 侧，避免改变 Q3 模型现有的显存分配；只有生成的图片嵌入会传入 GPU 上的语言模型推理。如果当前 llama-server 版本支持，`--mmproj-device none` 是等价的显式设备选择。上传图片前先确认 `GET /props` 返回 `modalities.vision: true`。正在运行的 Harness Web 无需重启；设置监听器会热更新模型能力，当前会话也会继续使用原来的模型与历史。

如果使用 Windows 任务计划程序或其他服务包装器，请把同样的投影器参数写入自启动动作。包装器必须先等待 `/health` 成功，再确认 `/props` 返回 `modalities.vision: true`，之后才能把 8098 端口标记为就绪；不能静默退回纯文本服务。如果启动仍报告 CUDA 显存不足，应在保留 `--mmproj` 和 `--no-mmproj-offload`（版本支持时再加 `--mmproj-device none`）的前提下降低 `--n-gpu-layers` 或 `--ctx-size` 后重试。

浏览器打开 `http://127.0.0.1:3080`，新建会话默认走 Qwen3.8-27B-Q3。headless 同样生效：`pnpm dsh "task"`。

## 密钥

llama-server 本身不校验 key，但 pi-ai 的 OpenAI 兼容实现要求非空 key。`QWEN38_API_KEY` 任意值即可，二选一：

- 环境变量：`export QWEN38_API_KEY=local`
- 托管凭证：写入 `~/.dsh/.credentials.yaml`（Web 界面凭证页可写）

## 覆盖与切换模型

用户设置 `~/.dsh/settings.yaml`（热加载，无需重启）按 provider 合并、逐字段覆盖内置路由：

```yaml
llm-pi-ai:
  providers:
    qwen38:
      baseURL: http://127.0.0.1:8098/v1   # point at another llama-server
agent-default-model:
  provider: qwen38
  model: Qwen3.8-27B-Q2                   # switch model
  reasoningEffort: off
```

## 已知边界

- `web_search` 目前仍走 DeepSeek 官方搜索（需要 `DEEPSEEK_API_KEY`，无 key 时报错）；免费无 key 的 DuckDuckGo 搜索插件是下一步。
- 会话压缩随 `dsh-base` 内置（pressure/context-overflow 自动触发 + `/compact` 命令），reasoning 路由修复见上表。
- 从上游同步（rebase / merge）时，`packages/bundle/base/cordis.patch.yml` 的两处预接线需要保留或重做。
