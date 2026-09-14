# Agent Note: Qwen3.8 vision capability and in-session hot switch

Status: implemented

English | [中文](2026-09-13-qwen38-vision-hot-switch.zh.md)

## Problem

The local `qwen38` route points at a long-running Qwen3.8 llama-server process. That process can serve text while reporting `modalities.vision: false` because it was started without a multimodal projector. Advertising image input in the Harness catalog without loading the projector lets the client admit an image that the server still cannot process. Restarting the process during a coding turn would also discard the active request.

## Decision

Both `Qwen3.8-27B-Q3` and `Qwen3.8-27B-Q2` advertise `text` and `image` input through the existing [unified image request pipeline](2026-08-20-unified-image-request-pipeline.md). The default provider, model, endpoint, and session selection remain unchanged, so a running session keeps its model identity and durable history.

An existing llama-server process completes its current request before restarting with its existing arguments plus a matching projector and `--no-mmproj-offload`. This keeps image decoding and projector computation on the CPU; only image embeddings enter GPU language inference. Builds exposing `--mmproj-device` use `--mmproj-device none` as the explicit equivalent. The operator verifies `GET /props` reports `modalities.vision: true` before sending an image. The Harness Web process stays running; its settings watcher adopts the image-capable catalog, and the next request in the same session can carry an image without a model switch notice. The projector path is deployment-specific; the scaffold documents the Qwen3.8-27B BF16 filename used by this route.

The Windows startup wrapper uses the same CPU-only projector arguments and marks the endpoint ready only after `/health` succeeds and `/props` reports `modalities.vision: true`. A CUDA out-of-memory retry lowers `--n-gpu-layers` or `--ctx-size` while retaining the CPU projector; it never falls back silently to a text-only process.

## Alternatives considered

**Change only the Harness catalog.** This makes image admission pass the client-side modality check but leaves a text-only server, so the provider rejects the request. The route metadata and server projector are treated as one operational change.

**Restart the server immediately.** This interrupts the active coding request and loses its in-flight response. Waiting for the current request to finish preserves the session and limits the interruption to the server restart gap.

**Hot-load the projector through the current HTTP endpoint.** The deployed endpoint does not expose the llama-server model-loading operation. A controlled restart of the same process and port is the available transition.

**Offload the projector to the GPU.** This can change the Q3 model's existing GPU allocation and trigger an out-of-memory failure. `--no-mmproj-offload` keeps the projector in system memory at the cost of roughly 1 GB of RAM.

**Switch the session to a separate vision model route.** A route change would add a model-change notice and alter the active model while the user is coding. Keeping the same Qwen3.8 model preserves prompt history and selection semantics.

## Consequences

The active coding turn completes uninterrupted, and the same session continues after the server restart. Vision requests remain unavailable until the remote process reports `modalities.vision: true`; changing only local metadata is not sufficient. The CPU projector increases startup time and system-memory use, while the Q3 model's GPU allocation remains stable under `--no-mmproj-offload`. Startup fails closed instead of advertising a false vision capability; an OOM retry may trade generation speed or context capacity for headroom. No Harness Web restart or durable-session migration is required.
