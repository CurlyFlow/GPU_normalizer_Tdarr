"use strict";

const {
  createStreamRouteStrategy,
} = require("./streamRouteStrategies");
const {
  runRawFilePlan,
} = require("./rawFileProcessor");
const {
  envFlag,
  gpuProgressFraction,
  intNum,
  logProfileStage,
  niceCommand,
} = require("./common");
const {
  finishCompletedStream,
} = require("./streamCompletionTelemetry");
const {
  sleep,
} = require("./shell");

function cpuLoudnormHeadstartMs() {
  return Math.max(0, Math.min(60000, intNum(process.env.LOUDNORM_GPU_CPU_LOUDNORM_HEADSTART_MS, 0)));
}

function describePlanCapabilityBlockers({ splitStats, pairedApply }) {
  return [
    splitStats ? "split_stats" : "",
    pairedApply ? "paired_apply" : "",
  ].filter(Boolean);
}

function createStreamPlanCapabilities({
  processingPlans,
  canSplitStatsPlan,
  pairedFallbackApplyPartner,
}) {
  const planCapabilities = processingPlans.map((plan) => {
    const splitStats = typeof canSplitStatsPlan === "function" && canSplitStatsPlan(plan);
    const pairedApply = typeof pairedFallbackApplyPartner === "function" && !!pairedFallbackApplyPartner(plan);
    const parallelBlockers = describePlanCapabilityBlockers({ splitStats, pairedApply });
    return {
      parallelBlockers,
      pairedApply,
      plan,
      splitStats,
      supportsParallelStream: parallelBlockers.length === 0,
    };
  });
  const blockedParallelPlans = planCapabilities.filter((capability) => !capability.supportsParallelStream);
  return {
    blockedParallelPlans,
    planCapabilities,
    supportsParallelStream: blockedParallelPlans.length === 0,
  };
}

function createStreamProcessorPolicy({
  useGpuSourcePort,
  useStreamingSourcePort,
  gpuFirstPassMeasure,
  processingPlans,
  canSplitStatsPlan,
  pairedFallbackApplyPartner,
}) {
  const streamParallelismDefault = 2;
  const streamParallelism = Math.max(1, intNum(process.env.LOUDNORM_GPU_STREAM_PARALLELISM, streamParallelismDefault));
  const streamPlanCapabilities = createStreamPlanCapabilities({
    processingPlans,
    canSplitStatsPlan,
    pairedFallbackApplyPartner,
  });
  const supportsParallelSerialPair = processingPlans.length === 2
    && processingPlans.some((plan) => plan.stereoFallback)
    && processingPlans.some((plan) => !plan.stereoFallback)
    && processingPlans[0].sourceIdx === processingPlans[1].sourceIdx;
  const parallelSerialWithGpuFirstPass = gpuFirstPassMeasure && envFlag("LOUDNORM_GPU_PARALLEL_SERIAL_STREAMS_WITH_GPU_FIRST_PASS", true);
  const useStreamParallelism = useGpuSourcePort
    && useStreamingSourcePort
    && !gpuFirstPassMeasure
    && processingPlans.length > 1
    && streamParallelism > 1
    && streamPlanCapabilities.supportsParallelStream;
  const useParallelSerialStreams = useGpuSourcePort
    && useStreamingSourcePort
    && (!gpuFirstPassMeasure || parallelSerialWithGpuFirstPass)
    && processingPlans.length > 1
    && streamParallelism > 1
    && supportsParallelSerialPair
    && envFlag("LOUDNORM_GPU_PARALLEL_SERIAL_STREAMS", true)
    && streamPlanCapabilities.blockedParallelPlans.every((capability) => !capability.pairedApply);
  const streamRouteKind = useParallelSerialStreams
    ? "parallelSerialPair"
    : (useStreamParallelism ? "parallel" : "serial");

  return {
    streamRouteKind,
    streamPlanCapabilities,
    streamParallelism,
    useParallelSerialStreams,
    useStreamParallelism,
  };
}

function prefetchInitialCpuLoudnorm({
  earlyCpuPrefetch,
  earlyCpuPrefetchLimit,
  pairStereoFallbackApply,
  prefetchCpuLoudnormFrom,
}) {
  if (!earlyCpuPrefetch) {
    return 0;
  }
  const prefetchStart = pairStereoFallbackApply ? 0 : 1;
  const prefetchLimit = pairStereoFallbackApply
    ? Math.max(earlyCpuPrefetchLimit, 2)
    : earlyCpuPrefetchLimit;
  return prefetchCpuLoudnormFrom(prefetchStart, prefetchLimit, "before first GPU stream starts") || 0;
}

function createStreamingSourcePortBackend(streamCtx) {
  const { commands, execution, plans, progress } = streamCtx;
  return {
    name: "streamingSourcePort",
    run: async ({ planState, splitStatsForPlan, measurement }) => {
      const { completedWork, onPlanGpuProgress, plan, planLabel, spans, streamStartedAt } = planState;
      const { args } = execution;
      const fallbackNice = plan.stereoFallback
        ? Math.max(0, Math.min(19, intNum(process.env.LOUDNORM_GPU_PARALLEL_SERIAL_FALLBACK_APPLY_NICE, 0)))
        : 0;
      const decodeCommand = commands.buildStreamingDecodeCommand(plan, measurement.cpuLoudnormValues);
      const encodeCommand = commands.buildStreamingEncodeCommand(plan, measurement.cpuLoudnormValues);
      const statsCacheInput = (splitStatsForPlan || measurement.firstPassStatsCacheInput)
        ? (measurement.splitStatsCacheInput || measurement.firstPassStatsCacheInput || plan.statsCache)
        : "";
      const gpuPlan = commands.buildStreamingGpuPlan(
        plan,
        measurement.cpuLoudnormValues,
        decodeCommand,
        encodeCommand,
        statsCacheInput,
      );
      const runtimeCommand = niceCommand(gpuPlan, fallbackNice);
      if (fallbackNice > 0) args.jobLog(`GPU normalize lowering parallel serial stereo fallback apply priority with nice ${fallbackNice}`);
      const gpuRes = await commands.runShell(commands.wrapRuntimeProfile(runtimeCommand, plan, "streaming"), {
        args,
        label: `GPU streaming normalize ${planLabel}`,
        allowedCodes: [0, 42],
        capturePath: plan.sourceErr,
        logOnSuccess: execution.debugLogging,
        parseLine: (line) => {
          const fraction = gpuProgressFraction(line);
          if (fraction !== null) {
            progress.updateProgress(completedWork + spans.measure + spans.decode + spans.normalize * fraction);
            if (typeof onPlanGpuProgress === "function") onPlanGpuProgress(plan, fraction);
          }
        },
      });
      logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: gpuRes.wallSec });
      if (splitStatsForPlan || measurement.firstPassStatsCacheInput) logProfileStage(args, { scope: "plugin", name: "gpu_source_port_streaming_total", stream: plan.idx, source_stream: plan.sourceIdx, channels: plan.channels, wall_sec: (Date.now() - streamStartedAt) / 1000 });
      if (gpuRes.code === 42) {
        throw new Error(`GPU gain gate disagrees with the measured per-stream decision on ${planLabel}`);
      }
      if (gpuRes.code !== 0) throw new Error(`GPU streaming normalize failed on ${planLabel}`);
      progress.updateProgress(completedWork + spans.measure + spans.decode + spans.normalize + spans.encode, true);
      await finishCompletedStream({
        args,
        plan,
        planLabel,
        describePlan: plans.describePlan,
        streamStartedAt,
        cleanupFiles: commands.cleanupFilesForPlan(plan).filter((file) => file !== plan.normalizedAudio),
        runChecked: commands.runChecked,
      });
      return { completed: true };
    },
  };
}

function createRawFileBackend(streamCtx) {
  const { commands, execution, output, plans, progress } = streamCtx;
  return {
    name: "rawFile",
    run: async ({ planState, measurement }) => {
      const { completedWork, plan, planLabel, spans, streamStartedAt } = planState;
      return await runRawFilePlan({
        args: execution.args,
        debugLogging: execution.debugLogging,
        plan,
        planLabel,
        describePlan: plans.describePlan,
        completedWork,
        measureSpan: spans.measure,
        decodeSpan: spans.decode,
        normalizeSpan: spans.normalize,
        encodeSpan: spans.encode,
        streamStartedAt,
        durationSeconds: execution.durationSeconds,
        cpuLoudnormValues: measurement.cpuLoudnormValues,
        useGpuSourcePort: execution.useGpuSourcePort,
        targetI: execution.targetI,
        maxGain: execution.maxGain,
        buildRawApplyCommand: commands.buildRawApplyCommand,
        buildRawDecodeCommand: commands.buildRawDecodeCommand,
        buildRawEncodeCommand: commands.buildRawEncodeCommand,
        buildRawSourcePortGpuPlan: commands.buildRawSourcePortGpuPlan,
        buildSourceCoreGainsCommand: commands.buildSourceCoreGainsCommand,
        wrapRuntimeProfile: commands.wrapRuntimeProfile,
        runShell: commands.runShell,
        runChecked: commands.runChecked,
        skipNormalization: output.skipNormalization,
        updateProgress: progress.updateProgress,
      });
    },
  };
}

function selectStreamApplyBackend(streamCtx) {
  return streamCtx.execution.useStreamingSourcePort
    ? createStreamingSourcePortBackend(streamCtx)
    : createRawFileBackend(streamCtx);
}

function createStreamExecutionContext(deps, policy) {
  const streamCtx = {
    commands: deps.commands,
    execution: deps.execution,
    output: deps.output,
    pairedApply: deps.pairedApply,
    plans: deps.plans,
    policy,
    prefetch: deps.prefetch,
    progress: deps.progress,
    stats: deps.stats,
  };
  streamCtx.backend = selectStreamApplyBackend(streamCtx);
  return streamCtx;
}

function createStreamProcessor(streamPipelineInterfaces) {
  const { execution, pairedApply, plans, prefetch, progress, stats } = streamPipelineInterfaces;
  const {
    streamPlanCapabilities,
    streamParallelism,
    streamRouteKind,
    useParallelSerialStreams,
    useStreamParallelism,
  } = createStreamProcessorPolicy({
    useGpuSourcePort: execution.useGpuSourcePort,
    useStreamingSourcePort: execution.useStreamingSourcePort,
    gpuFirstPassMeasure: execution.gpuFirstPassMeasure,
    processingPlans: plans.processingPlans,
    canSplitStatsPlan: stats.canSplitStatsPlan,
    pairedFallbackApplyPartner: pairedApply.pairedFallbackApplyPartner,
  });

  const processStreams = async () => {
    const prefetchedCpuTasks = prefetchInitialCpuLoudnorm({
      earlyCpuPrefetch: prefetch.earlyCpuPrefetch,
      earlyCpuPrefetchLimit: prefetch.earlyCpuPrefetchLimit,
      pairStereoFallbackApply: pairedApply.pairStereoFallbackApply,
      prefetchCpuLoudnormFrom: prefetch.prefetchCpuLoudnormFrom,
    });
    const headstartMs = prefetchedCpuTasks > 0 ? cpuLoudnormHeadstartMs() : 0;
    if (headstartMs > 0) {
      execution.args.jobLog(`GPU normalize waiting ${headstartMs}ms CPU loudnorm headstart before first GPU stream starts`);
      await sleep(headstartMs);
    }
    progress.updateProgress(0, true);
    const streamExecutionContext = createStreamExecutionContext(streamPipelineInterfaces, {
      streamPlanCapabilities,
      streamParallelism,
      streamRouteKind,
      useParallelSerialStreams,
      useStreamParallelism,
    });
    const routeStrategy = createStreamRouteStrategy(streamExecutionContext.policy.streamRouteKind, {
      gpuFirstPassOriginalOnly: execution.gpuFirstPassOriginalOnly,
    });
    streamExecutionContext.route = routeStrategy;
    return await routeStrategy.run(streamExecutionContext);
  };

  return {
    processStreams,
  };
}

module.exports = {
  createStreamProcessor,
};
