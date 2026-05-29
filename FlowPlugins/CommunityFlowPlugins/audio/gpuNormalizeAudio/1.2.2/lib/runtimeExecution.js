"use strict";

const {
  envFlag,
  normalizeNsysSample,
  q,
} = require("./common");

function createRuntimeExecution({
  args,
  base,
  runId,
  workDir,
  runShell,
  planLabelFor,
}) {
  const runChecked = async (command, opts) => {
    const res = await runShell(command, { args, ...opts });
    if (!(opts.allowedCodes || [0]).includes(res.code)) throw new Error(`${opts.label} failed`);
    return res;
  };

  const nsysRuntimeProfile = envFlag("LOUDNORM_GPU_NSYS");
  const nsysTrace = String(process.env.LOUDNORM_GPU_NSYS_TRACE || "cuda,osrt,nvtx").trim() || "cuda,osrt,nvtx";
  const nsysSample = normalizeNsysSample(process.env.LOUDNORM_GPU_NSYS_SAMPLE || "none");
  const nsysOutputDir = String(process.env.LOUDNORM_GPU_NSYS_OUTPUT_DIR || workDir).trim() || workDir;
  const wrapRuntimeProfile = (command, plan, label) => {
    if (!nsysRuntimeProfile) return command;
    const profileBase = `${nsysOutputDir}/${base}.gpu-normalize.${runId}.${label}.stream${plan.idx}`.replace(/[^A-Za-z0-9_./-]/g, "_");
    args.jobLog(`GPU normalize Nsight Systems profile enabled for ${planLabelFor(plan)}: ${profileBase}.nsys-rep`);
    return [
      "mkdir", "-p", q(nsysOutputDir), "&&",
      "nsys", "profile",
      "--force-overwrite=true",
      "--export=sqlite",
      `--trace=${q(nsysTrace)}`,
      `--sample=${q(nsysSample)}`,
      `--output=${q(profileBase)}`,
      command,
    ].join(" ");
  };

  return {
    runChecked,
    wrapRuntimeProfile,
  };
}

async function runLimitedParallel(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  });
  await Promise.all(runners);
  if (firstError) throw firstError;
  return results;
}

module.exports = {
  createRuntimeExecution,
  runLimitedParallel,
};
