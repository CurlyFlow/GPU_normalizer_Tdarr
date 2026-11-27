"use strict";

const {
  channelCount,
  sourceChannelLayout,
  shouldEncodeCopiedAudioForMp4,
  streamSummary,
} = require("./audioChannelHelpers");
const {
  sortAudioPlansByLanguage,
} = require("./audioLanguageOrder");
const {
  createAudioSelection,
} = require("./audioSelection");
const {
  intNum,
  langTag,
  num,
  q,
  sampleBytes,
} = require("./common");

function buildAudioPlanPaths({
  workDir,
  base,
  suffix,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
}) {
  return {
    rawInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.input.${gpuInputExt}`,
    rawInputFormat: gpuInputFormat,
    gains: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.gains.f32`,
    statsCache: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.bin`,
    measureErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.measure.err`,
    statsErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stats.err`,
    sourceErr: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.source.err`,
    rawGpu: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.output.${gpuOutputExt}`,
    rawGpuFormat: gpuOutputFormat,
    normalizedAudio: `${workDir}/${base}.gpu-normalized.${suffix}.${runId}.m4a`,
    fifoInput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-in.fifo`,
    fifoOutput: `${workDir}/${base}.gpu-normalize.${suffix}.${runId}.stream-out.fifo`,
  };
}

function createSourceAudioPlans({
  args,
  audioStreams,
  workDir,
  base,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
}) {
  return audioStreams.map((stream, idx) => {
    const streamChannels = channelCount(args.inputs.channels, stream, 2);
    const suffix = `a${idx}`;
    return {
      idx,
      sourceIdx: idx,
      channels: streamChannels,
      channelLayout: sourceChannelLayout(stream, streamChannels),
      sourceSampleRate: intNum(stream.sample_rate, 0),
      sourceSampleFmt: String(stream.sample_fmt || "").trim().toLowerCase(),
      sourceCodecName: String(stream.codec_name || "").trim().toLowerCase(),
      language: langTag((stream.tags || {}).language || stream.language || "und"),
      stereoFallback: false,
      sourceInput: args.inputFileObj._id,
      sourceAudioIdx: idx,
      ...buildAudioPlanPaths({
        workDir,
        base,
        suffix,
        runId,
        gpuInputExt,
        gpuInputFormat,
        gpuOutputExt,
        gpuOutputFormat,
      }),
    };
  });
}

function createStereoFallbackPlan({
  args,
  audioStreams,
  sourceIdx,
  fallbackOrdinal,
  idx,
  workDir,
  base,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
}) {
  const stream = audioStreams[sourceIdx];
  const suffix = sourceIdx === 0 && fallbackOrdinal === 0 ? "stereo" : `stereo.a${sourceIdx}`;
  return {
    idx,
    sourceIdx,
    channels: 2,
    channelLayout: "stereo",
    sourceSampleRate: intNum(stream.sample_rate, 0),
    sourceSampleFmt: String(stream.sample_fmt || "").trim().toLowerCase(),
    sourceCodecName: String(stream.codec_name || "").trim().toLowerCase(),
    language: langTag((stream.tags || {}).language || stream.language || "und"),
    stereoFallback: true,
    sourceInput: args.inputFileObj._id,
    sourceAudioIdx: sourceIdx,
    ...buildAudioPlanPaths({
      workDir,
      base,
      suffix,
      runId,
      gpuInputExt,
      gpuInputFormat,
      gpuOutputExt,
      gpuOutputFormat,
    }),
  };
}

function createAudioRuntimePlans({
  audioPlans,
  sampleRate,
  durationSeconds,
  statsCachePathFor,
  statsErrPathFor,
}) {
  return audioPlans.map((plan) => {
    const statsCaches = [plan.statsCache];
    const statsErrs = [plan.statsErr];
    if (plan.sourceSampleRate > 0 && plan.sourceSampleRate !== sampleRate) {
      statsCaches.push(statsCachePathFor(plan, plan.sourceSampleRate));
      statsErrs.push(statsErrPathFor(plan, plan.sourceSampleRate));
    }
    return {
      ...plan,
      statsCaches,
      statsErrs,
      work: Math.max(1, durationSeconds * plan.channels),
      estimatedRawInputBytes: Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawInputFormat)),
      estimatedRawOutputBytes: Math.ceil(durationSeconds * sampleRate * plan.channels * sampleBytes(plan.rawGpuFormat)),
    };
  });
}

function createAudioPlanRuntimeContext({
  audioPlans,
  sampleRate,
  durationSeconds,
  tmpOutputFilePath,
}) {
  const statsCachePathFor = (plan, statsSampleRate) => statsSampleRate === sampleRate
    ? plan.statsCache
    : plan.statsCache.replace(/\.stats\.bin$/, `.r${statsSampleRate}.stats.bin`);
  const statsErrPathFor = (plan, statsSampleRate) => statsSampleRate === sampleRate
    ? plan.statsErr
    : plan.statsErr.replace(/\.stats\.err$/, `.r${statsSampleRate}.stats.err`);
  const runtimePlans = createAudioRuntimePlans({
    audioPlans,
    sampleRate,
    durationSeconds,
    statsCachePathFor,
    statsErrPathFor,
  });
  const trackedStatsCaches = new Map(runtimePlans.map((plan) => [plan, new Set(plan.statsCaches)]));
  const trackedStatsErrs = new Map(runtimePlans.map((plan) => [plan, new Set(plan.statsErrs)]));

  const trackStatsCachePath = (plan, statsCache) => {
    const caches = trackedStatsCaches.get(plan);
    if (caches) caches.add(statsCache);
    return statsCache;
  };
  const trackStatsErrPath = (plan, statsErr) => {
    const errs = trackedStatsErrs.get(plan);
    if (errs) errs.add(statsErr);
    return statsErr;
  };
  const trackStatsPaths = (plan, statsSampleRate) => {
    const statsCache = statsCachePathFor(plan, statsSampleRate);
    const statsErr = statsErrPathFor(plan, statsSampleRate);
    trackStatsCachePath(plan, statsCache);
    trackStatsErrPath(plan, statsErr);
    return { statsCache, statsErr };
  };

  const audioWork = runtimePlans.reduce((sum, plan) => sum + plan.work, 0);
  const muxWork = Math.max(1, audioWork * 0.03);
  const totalWork = audioWork + muxWork;
  const etaWorkUnitsPerSecond = Math.max(1, num(process.env.LOUDNORM_GPU_ETA_WORK_UNITS_PER_SECOND, 30));
  const baselineEtaSeconds = Math.max(5, totalWork / etaWorkUnitsPerSecond);
  const firstPassStatsCacheFor = (statsCache) => statsCache.replace(/\.stats\.bin$/, ".first-pass.stats.bin");
  const statsCachesForCleanup = (plan) => [...(trackedStatsCaches.get(plan) || new Set(plan.statsCaches || [plan.statsCache]))];
  const statsErrsForCleanup = (plan) => [...(trackedStatsErrs.get(plan) || new Set(plan.statsErrs || [plan.statsErr]))];
  const cleanupFilesForPlan = (plan) => [
    plan.rawInput,
    plan.gains,
    ...statsCachesForCleanup(plan),
    ...statsCachesForCleanup(plan).map(firstPassStatsCacheFor),
    plan.measureErr,
    ...statsErrsForCleanup(plan),
    plan.sourceErr,
    plan.rawGpu,
    plan.normalizedAudio,
    plan.fifoInput,
    plan.fifoOutput,
    `${plan.fifoInput}.stats`,
    `${plan.fifoOutput}.stats`,
  ];
  const allIntermediateFiles = runtimePlans.flatMap(cleanupFilesForPlan);
  // A retimed output retains the encoded input until complete finish acceptance.
  // Without transport, the temporary package has already been renamed away.
  const cleanupAll = `rm -f ${allIntermediateFiles.map(q).join(" ")}`;

  return {
    allIntermediateFiles,
    audioPlans: runtimePlans,
    audioWork,
    baselineEtaSeconds,
    cleanupAll,
    cleanupFilesForPlan,
    muxWork,
    statsCachePathFor,
    statsErrPathFor,
    totalWork,
    trackStatsCachePath,
    trackStatsPaths,
  };
}

function createAudioPlanStatus({
  normalizePlans,
  copyPlans,
  removePlans,
  compatibilityMuxRequired,
}) {
  if (normalizePlans.length + copyPlans.length === 0) {
    return {
      kind: "noAudioOutput",
      hasAudioOutput: false,
      needsGpuWork: false,
      needsMux: false,
    };
  }
  if (normalizePlans.length === 0 && removePlans.length === 0 && !compatibilityMuxRequired) {
    return {
      kind: "passThrough",
      hasAudioOutput: true,
      needsGpuWork: false,
      needsMux: false,
    };
  }
  if (normalizePlans.length === 0) {
    return {
      kind: "muxOnly",
      hasAudioOutput: true,
      needsGpuWork: false,
      needsMux: true,
    };
  }
  return {
    kind: "normalize",
    hasAudioOutput: true,
    needsGpuWork: true,
    needsMux: true,
  };
}

function createAudioPlanSet({
  actionSet,
  sourcePlans,
  runtimeContext,
  compatibilityMuxRequired,
}) {
  const runtimePlans = runtimeContext.audioPlans;
  const status = createAudioPlanStatus({
    normalizePlans: runtimePlans,
    copyPlans: actionSet.copy,
    removePlans: actionSet.remove,
    compatibilityMuxRequired,
  });

  return {
    actions: actionSet,
    source: sourcePlans.slice(),
    normalize: runtimePlans,
    copy: actionSet.copy,
    remove: actionSet.remove,
    fallback: {
      stereo: runtimePlans.filter((plan) => plan.stereoFallback),
      undetected: actionSet.fallback.undetected,
    },
    status,
    runtime: {
      normalize: runtimePlans,
      statsCachePathFor: runtimeContext.statsCachePathFor,
      statsErrPathFor: runtimeContext.statsErrPathFor,
      trackStatsCachePath: runtimeContext.trackStatsCachePath,
      trackStatsPaths: runtimeContext.trackStatsPaths,
    },
    muxInputs: {
      copyOriginal: actionSet.muxInputs.copyOriginal,
      final: {
        normalize: runtimePlans,
        copy: actionSet.copy,
      },
    },
    cleanup: {
      allIntermediateFiles: runtimeContext.allIntermediateFiles,
      cleanupAll: runtimeContext.cleanupAll,
      cleanupFilesForPlan: runtimeContext.cleanupFilesForPlan,
    },
    work: {
      audio: runtimeContext.audioWork,
      mux: runtimeContext.muxWork,
      total: runtimeContext.totalWork,
      baselineEtaSeconds: runtimeContext.baselineEtaSeconds,
    },
  };
}

function buildAudioPlanContext({
  args,
  audioStreams,
  container,
  stereoLanguageOrder,
  normalizeOnlyLanguages,
  removeOtherLanguages,
  fallbackToUndetectedAudio = true,
  ensureStereo,
  stereoFallbackFirstOnly,
  sampleRate,
  durationSeconds,
  workDir,
  base,
  runId,
  gpuInputExt,
  gpuInputFormat,
  gpuOutputExt,
  gpuOutputFormat,
  tmpOutputFilePath,
  debugLogging,
}) {
  const allSourceAudioPlans = createSourceAudioPlans({
    args,
    audioStreams,
    workDir,
    base,
    runId,
    gpuInputExt,
    gpuInputFormat,
    gpuOutputExt,
    gpuOutputFormat,
  });
  const sortedSourceAudioPlans = sortAudioPlansByLanguage(allSourceAudioPlans, stereoLanguageOrder);
  const {
    actionSet,
    audioPlans,
    fallbackUndetectedAudioPlans,
    removedAudioPlans,
    selectedLanguageKeys,
    shouldRemoveOtherLanguages,
    skippedAudioPlans,
    sourceAudioActions,
  } = createAudioSelection({
    sourceAudioPlans: sortedSourceAudioPlans,
    normalizeOnlyLanguages,
    removeOtherLanguages,
    fallbackToUndetectedAudio,
    ensureStereo,
    stereoFallbackFirstOnly,
    createStereoFallbackPlan: ({ sourceIdx, fallbackOrdinal, idx }) => createStereoFallbackPlan({
        args,
        audioStreams,
        sourceIdx,
        fallbackOrdinal,
        idx,
        workDir,
        base,
        runId,
        gpuInputExt,
        gpuInputFormat,
        gpuOutputExt,
        gpuOutputFormat,
    }),
  });
  const describePlan = (plan) => {
    const source = allSourceAudioPlans[plan.sourceIdx];
    const sourceText = source ? `#${source.sourceIdx} ${source.language} ${source.channels}ch` : `#${plan.sourceIdx}`;
    if (plan.stereoFallback) return `create normalized stereo from ${sourceText}`;
    return `normalize ${sourceText}`;
  };
  const encodeRetainedAudio = (plan) => shouldEncodeCopiedAudioForMp4(container, audioStreams[plan.sourceIdx]);
  const describeCopy = (plan) => encodeRetainedAudio(plan)
    ? `encode #${plan.sourceIdx} ${plan.language} ${plan.channels}ch to AAC without normalization`
    : `copy #${plan.sourceIdx} ${plan.language} ${plan.channels}ch unchanged`;
  const describeRemove = (plan) => `remove #${plan.sourceIdx} ${plan.language} ${plan.channels}ch`;
  const logDebugPlanSummary = () => {
    if (!debugLogging) return;
    args.jobLog(`GPU normalize audio streams: normalize_scope=${normalizeOnlyLanguages.length > 0 ? "only_languages" : "all"} normalize_only_languages=${normalizeOnlyLanguages.join(",") || "all"} remove_other_languages=${shouldRemoveOtherLanguages ? "true" : "false"} fallback_to_undetected_audio=${fallbackToUndetectedAudio ? "true" : "false"} selected_languages=${selectedLanguageKeys.join(",") || (normalizeOnlyLanguages.length > 0 ? "none" : "all")} normalized_count=${audioPlans.length} copied_audio_count=${skippedAudioPlans.length} fallback_undetected_count=${fallbackUndetectedAudioPlans.length} removed_audio_count=${removedAudioPlans.length} channel_input=${String(args.inputs.channels || "auto")} effective_channels=${audioPlans.map((plan) => plan.channels).join(",") || "none"} ensure_stereo=${ensureStereo ? "true" : "false"} stereo_scope=${ensureStereo ? (stereoFallbackFirstOnly ? "first_language" : "all_non_stereo_audio") : "off"} stereo_language_order=${stereoLanguageOrder.join(",") || "source"}`);
    if (skippedAudioPlans.length > 0) args.jobLog(`GPU normalize retained audio: ${skippedAudioPlans.map(describeCopy).join("; ")}`);
    if (fallbackUndetectedAudioPlans.length > 0) args.jobLog(`GPU normalize fallback to undetected audio streams: ${fallbackUndetectedAudioPlans.map((plan) => `${plan.sourceIdx}:${plan.language}`).join(",")}`);
    if (removedAudioPlans.length > 0) args.jobLog(`GPU normalize removed audio streams: ${removedAudioPlans.map((plan) => `${plan.sourceIdx}:${plan.language}`).join(",")}`);
  };
  const inputAudioSummary = audioStreams.map(streamSummary).join("; ");
  const normalizeScopeText = normalizeOnlyLanguages.length > 0 ? `only ${normalizeOnlyLanguages.join(", ")}` : "all audio languages";
  const stereoPlanText = ensureStereo
    ? `ensure stereo for ${stereoFallbackFirstOnly ? "first selected language" : "each selected non-stereo stream"}`
    : "do not add generated stereo";
  const runtimeContext = createAudioPlanRuntimeContext({
    audioPlans,
    sampleRate,
    durationSeconds,
    tmpOutputFilePath,
  });
  const audioPlanSet = createAudioPlanSet({
    actionSet,
    sourcePlans: allSourceAudioPlans,
    runtimeContext,
    compatibilityMuxRequired: skippedAudioPlans.some(encodeRetainedAudio),
  });

  return {
    allSourceAudioPlans,
    audioPlanSet,
    audioPlans: audioPlanSet.normalize,
    copyOriginalAudioPlans: audioPlanSet.muxInputs.copyOriginal,
    fallbackUndetectedAudioPlans,
    describeRemove,
    skippedAudioPlans: audioPlanSet.copy,
    removedAudioPlans,
    sourceAudioActions: audioPlanSet.actions.source,
    inputAudioSummary,
    normalizeScopeText,
    stereoPlanText,
    describePlan,
    describeCopy,
    logDebugPlanSummary,
    statsCachePathFor: audioPlanSet.runtime.statsCachePathFor,
    statsErrPathFor: audioPlanSet.runtime.statsErrPathFor,
    trackStatsCachePath: audioPlanSet.runtime.trackStatsCachePath,
    trackStatsPaths: audioPlanSet.runtime.trackStatsPaths,
    audioWork: audioPlanSet.work.audio,
    muxWork: audioPlanSet.work.mux,
    totalWork: audioPlanSet.work.total,
    baselineEtaSeconds: audioPlanSet.work.baselineEtaSeconds,
    cleanupFilesForPlan: audioPlanSet.cleanup.cleanupFilesForPlan,
    allIntermediateFiles: audioPlanSet.cleanup.allIntermediateFiles,
    cleanupAll: audioPlanSet.cleanup.cleanupAll,
  };
}

module.exports = {
  buildAudioPlanContext,
};
