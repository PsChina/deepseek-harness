# Qwen3.8 Local Build Scaffold (dedicated fork)

English | [中文](README.zh.md)

This fork retargets the deepseek-harness **local build** to connect directly to a self-hosted Qwen3.8-27B (llama-server, OpenAI-compatible endpoint `openai-completions`): the default agent model, title generation, and session compaction all run on the local model, with no dependency on the official DeepSeek API.

## Changes relative to upstream

| Commit / file | Content |
| --- | --- |
| `packages/bundle/base/cordis.patch.yml` | `llm-pi-ai` presets the `qwen38` route (dual Q3 + Q2 models, placeholder key from `apiKeyEnv: QWEN38_API_KEY`); `agent-default-model` defaults to `qwen38 / Qwen3.8-27B-Q3`. Effective in both web and headless |
| `4650696ee8` Fix compaction reasoning routing | Compaction summary request reasoning routing fix for non-DeepSeek protocols |
| `10b7f1fb3c` Restore legacy code preset sessions | Restores loading of legacy code/PTC preset sessions |
| `packages/client/locale`, `apps/web`, ui-sidebar tests/snapshots | Web GUI renamed to **Qwen Agent**: sidebar top-left name (`brand.localBuild` term, zh/en in sync) and browser tab title (`DEFAULT_CLIENT_TITLE`). The whale logo and `ui-brand-official` placeholder are unchanged; the change is locale copy plus the Vite title constant only — re-`pnpm run build` and refresh to apply |

## Quick start

Prerequisites:

- llama-server has loaded Qwen3.8-27B; the OpenAI endpoint defaults to `http://192.168.2.123:8098/v1`
- Node `^22.19 || >=24`, pnpm 11.7 (locked by the root `package.json` `packageManager`)

```sh
pnpm install
pnpm run build        # first run needs to emit each package's lib/
pnpm dsh web --port 3080
```

Open `http://127.0.0.1:3080` in a browser; new sessions default to Qwen3.8-27B-Q3. Headless works the same way: `pnpm dsh "task"`.

## Keys

llama-server does not validate keys, but pi-ai's OpenAI-compatible implementation requires a non-empty key. Any value works for `QWEN38_API_KEY`; either of:

- Environment variable: `export QWEN38_API_KEY=local`
- Managed credential: write it into `~/.dsh/.credentials.yaml` (writable from the Web credentials page)

## Overriding and switching models

User settings in `~/.dsh/settings.yaml` (hot-reloaded, no restart) merge per provider and override the built-in routes field by field:

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

## Known boundaries

- `web_search` still uses the official DeepSeek search (requires `DEEPSEEK_API_KEY`; errors without one); a free keyless DuckDuckGo search plugin is the next step.
- Session compaction ships built into `dsh-base` (pressure/context-overflow auto-trigger plus the `/compact` command); see the table above for the reasoning routing fix.
- When syncing from upstream (rebase / merge), the two `packages/bundle/base/cordis.patch.yml` pre-wirings must be preserved or redone.
