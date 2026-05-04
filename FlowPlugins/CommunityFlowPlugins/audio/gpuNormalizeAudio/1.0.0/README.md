# GPU Normalize Audio Plugin Folder

This directory contains the complete public plugin package layout.

## Files

```text
index.js
runtime/bin/loudnorm-gpu-source-port
runtime/cuda/compile_cuda_ptx.py
runtime/cuda/loudnorm_source_port_kernels.cu
runtime/cuda/loudnorm_source_port_kernels.ptx
```

Tdarr loads only `index.js` as the FlowPlugin. The files under `runtime/` are the CUDA/runtime pieces used by the plugin after they are installed into the Tdarr container.

Default container install target:

```text
/app/server/gpu-normalizer/bin/
```

The plugin inputs can override every runtime path.
