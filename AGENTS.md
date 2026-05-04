# Agent Instructions

This repo is the public GPU Normalize Audio Tdarr plugin package.

## Scope

- Keep all plugin-specific source/runtime files under `FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/`.
- Keep `README.md`, `.gitignore`, and this `AGENTS.md` as repo-level metadata only.
- Do not add internal live Tdarr paths, hostnames, job IDs, private docs, or secrets to tracked files.
- The ignored `docs/` directory is local/internal only and must stay unpublished.

## Plugin Rules

- Tdarr plugin entrypoint: `FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/index.js`.
- Public plugin name: `GPU Normalize Audio`.
- Do not reintroduce internal prefixes or experimental naming.
- Normalize all audio streams sequentially; do not normalize only primary audio.
- Preserve video, subtitle, attachment, data, chapters, and metadata streams.
- Keep `channels=auto` as the default so each audio stream keeps its source channel count.

## Validation

- Run `node --check FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/index.js` after JS edits.
- Run `python3 -m py_compile FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/runtime/bin/loudnorm-gpu-source-port FlowPlugins/CommunityFlowPlugins/audio/gpuNormalizeAudio/1.0.0/runtime/cuda/compile_cuda_ptx.py` after Python edits.
- Search tracked files for internal terms before publishing.
