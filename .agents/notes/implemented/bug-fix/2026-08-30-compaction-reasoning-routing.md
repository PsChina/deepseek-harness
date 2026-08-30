# Agent Note: Compaction reasoning follows the routed request

Status: implemented

English | [中文](2026-08-30-compaction-reasoning-routing.zh.md)

## Problem

The default compaction summarizer rebuilt an auxiliary model request from only the routed provider and model. An explicit reasoning effort recorded in the latest request header therefore disappeared, allowing the adapter's provider default to consume generation space that the active conversation had not selected.

## Decision

`dsh-compaction-basic` inherits an explicit reasoning effort from the latest request header when the summarization target is the same provider/model, while ignoring an adapter-materialized default marker. It also inherits an explicit effort from matching `AgentOptions` when no newer durable header provides one. `llm-pi-ai` sends an auxiliary-call purpose marker as `X-DSH-Purpose`, allowing compatible gateways to identify a compaction request without inspecting model-visible messages.

The Qwen compatibility proxy treats a compaction request with no explicit effort as `none`, and treats an explicit disabled-thinking marker as `none`. An explicit `reasoning_effort` remains authoritative, so a selected `minimal` request keeps its `minimal` budget while an unqualified auxiliary request cannot fall back to the provider's high-reasoning default.

## Alternatives considered

**Leave the compaction target at provider/model only.** Rejected because the auxiliary call then silently changes a durable, user-visible request control and can reserve most of the remaining context before the summary is generated.

**Force every compaction call to `off` in Harness.** Rejected as the only fix because pi-ai represents `off` as disabled thinking without a reasoning field, while an older gateway may interpret an omitted field as its ordinary default. The gateway must recognize the purpose or disabled marker as well.

**Fix only the gateway default.** Rejected as the primary fix because the Harness request would still be semantically incomplete and another adapter or gateway could reintroduce the loss. Gateway handling remains a defense-in-depth safeguard.

## Consequences

Compaction uses the same explicit reasoning selection as the active conversation when it targets that route. Compatible Qwen gateways can safely run unqualified compaction with zero reasoning budget, while preserving explicit effort for callers that intentionally choose one. The wire-purpose header is adapter metadata and does not enter model input or the session transcript.
