# Qwen3.8 本地构建脚手架（专用 fork）

本 fork 把 deepseek-harness 的**本地构建**默认改为直连自建 Qwen3.8-27B（llama-server，OpenAI 兼容端点 `openai-completions`），agent 默认模型、标题生成、会话压缩全部走本地模型，不再依赖 DeepSeek 官方 API。

## 相对上游的改动

| 提交 / 文件 | 内容 |
| --- | --- |
| `packages/bundle/base/cordis.patch.yml` | `llm-pi-ai` 预置 `qwen38` 路由（Q3 + Q2 双模型、`apiKeyEnv: QWEN38_API_KEY` 占位 key）；`agent-default-model` 默认 `qwen38 / Qwen3.8-27B-Q3`。web 与 headless 全部生效 |
| `4650696ee8` Fix compaction reasoning routing | 压缩（compaction）摘要请求在非 DeepSeek 协议下的 reasoning 路由修复 |
| `10b7f1fb3c` Restore legacy code preset sessions | 旧 code/PTC 预设会话恢复加载 |
| `packages/client/locale`、`apps/web`、ui-sidebar 测试/快照 | Web GUI 品牌名改为 **Qwen Agent**：侧栏左上角名称（`brand.localBuild` 词条，zh/en 同步）与浏览器标签页标题（`DEFAULT_CLIENT_TITLE`）。鲸鱼 logo 与 `ui-brand-official` 占位不变；改动仅 locale 文案 + Vite 标题常量，重新 `pnpm run build` 后刷新页面即生效 |

## 快速开始

前置条件：

- llama-server 已加载 Qwen3.8-27B，OpenAI 端点默认为 `http://192.168.2.123:8098/v1`
- Node `^22.19 || >=24`，pnpm 11.7（根 `package.json` 的 `packageManager` 锁定）

```sh
pnpm install
pnpm run build        # 首次需要产出各包 lib/
pnpm dsh web --port 3080
```

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
      baseURL: http://127.0.0.1:8098/v1   # 换 llama-server 地址
agent-default-model:
  provider: qwen38
  model: Qwen3.8-27B-Q2                   # 换模型
  reasoningEffort: off
```

## 已知边界

- `web_search` 目前仍走 DeepSeek 官方搜索（需要 `DEEPSEEK_API_KEY`，无 key 时报错）；免费无 key 的 DuckDuckGo 搜索插件是下一步。
- 会话压缩随 `dsh-base` 内置（pressure/context-overflow 自动触发 + `/compact` 命令），reasoning 路由修复见上表。
- 从上游同步（rebase / merge）时，`packages/bundle/base/cordis.patch.yml` 的两处预接线需要保留或重做。
