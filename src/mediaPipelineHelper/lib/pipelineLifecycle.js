"use strict";

const { initializePluginInputs } = require("./pluginBootstrap");
const { createMediaRuntime } = require("./pipelineMediaRuntime");
const { prepareMedia } = require("./pipelinePreparation");
const { processVideo } = require("./pipelineVideo");
const { publishPackage } = require("./pipelinePublication");
const { notifyPublishedPackage } = require("./pipelineImport");
const { runResourceTask } = require("./concurrencyLock");
const { rejectInput } = require("./inputRejection");
const { checkInputSize, pruneBelowMinimumCompanion } = require("./inputSize");
const { prepareContract, finishContract, holdUnprovenFinishedCheckpoint } = require("./pipelineContract");
const { mediaTools } = require("./mediaTools");
const { rejectInferiorPublication } = require("./pipelineQualityRejection");
const { recordProcessingDecision } = require("./pipelineDecisionAudit");
const { pipelineSettings } = require("./pipelineSettings");

function pipelineContext(args, context, dependencies) {
  (dependencies.initialize || initializePluginInputs)(args, context.details);
  const inheritedConcurrency = args.inputs.phase === "finish" ? args.variables?.mediaPipelineConcurrency : null;
  const inputs = {
    ...args.inputs,
    ...(inheritedConcurrency?.maxConcurrentCpuJobs !== undefined ? { maxConcurrentCpuJobs: inheritedConcurrency.maxConcurrentCpuJobs } : {}),
    ...(inheritedConcurrency?.maxConcurrentJobs !== undefined ? { maxConcurrentJobs: inheritedConcurrency.maxConcurrentJobs } : {}),
    removeRejectedFromTdarr: false,
  };
  const settings = pipelineSettings(inputs);
  const runtime = dependencies.runtime || createMediaRuntime(context.pluginRoot, mediaTools(args));
  const working = { ...args, inputs, variables: { ...args.variables, removeFromTdarr: false } };
  const runPhase = dependencies.runPhase || ((resource, task) => runResourceTask(working, resource, task));
  return { working, settings, runtime, runPhase, publish: dependencies.publish || publishPackage };
}

async function finishRejection({ working, runPhase, publish }) {
  await runPhase("cpu", () => publish(working, { prepareRejection: true }));
  const rejected = await publish(working);
  working.variables = rejected.variables;
  if (working.variables.mediaPipelineAudit?.beforeEvidence && working.variables.mediaPipelineRejectionAudit?.after) {
    await recordProcessingDecision(working, "rejected");
  }
  return { ...rejected, variables: working.variables };
}

async function preparePipeline(args, context, dependencies = {}) {
  const phase = pipelineContext(args, context, dependencies);
  const { working, settings, runtime, runPhase, publish } = phase;
  // A new prepare invocation must not borrow any prior job's continuation.
  delete working.variables.mediaPipeline;
  delete working.variables.mediaPipelineAudio;
  delete working.variables.mediaPipelineAudioIntent;
  delete working.variables.mediaPipelineIntegrity;
  delete working.variables.mediaPipelineReplacement;
  delete working.variables.gpuNormalizeAudioRejection;
  delete working.variables.gpuNormalizeAudioInputRecovery;
  delete working.variables.gpuNormalizeAudioNaming;
  delete working.variables.gpuNormalizeAudioImport;
  delete working.variables.mediaPipelineAudioExpectation;
  delete working.variables.mediaPipelineAudit;
  delete working.variables.mediaPipelinePreparation;
  delete working.variables.mediaPipelinePreparationEvidence;
  delete working.variables.mediaPipelinePreparationIntent;
  delete working.variables.mediaPipelinePreparationPlan;
  delete working.variables.mediaPipelineConcurrency;
  delete working.variables.gpuNormalizeAudioClock;
  delete working.variables.gpuNormalizeAudioValues;
  delete working.variables.gpuNormalizeAudioTransport;
  delete working.variables.gpuNormalizeAudioHandoff;
  delete working.variables.mediaPipelineVideo;
  const prunedCompanion = await (dependencies.pruneSmallCompanion || pruneBelowMinimumCompanion)(working);
  if (prunedCompanion) return prunedCompanion;
  const checkpoint = await runPhase("cpu", () => publish(working, { resumeOnly: true }));
  const inheritedConcurrency = {
    maxConcurrentCpuJobs: working.inputs.maxConcurrentCpuJobs,
    maxConcurrentJobs: working.inputs.maxConcurrentJobs,
  };
  if (checkpoint.outputNumber === 3) {
    if (!checkpoint.variables?.mediaPipelineReplacement) holdUnprovenFinishedCheckpoint();
    working.variables = { ...checkpoint.variables, mediaPipelineConcurrency: inheritedConcurrency };
    // The owned terminal consumer verified the retained generation. Its logical
    // source name may already have moved through the publication journal.
    working.inputFileObj = checkpoint.outputFileObj;
    prepareContract(working, "finished");
    return { outputFileObj: working.inputFileObj, outputNumber: 3, variables: working.variables };
  }
  if (checkpoint.outputNumber !== 1) throw new Error("Unsupported checkpoint admission outcome");
  // Owned restart restores the original before its path or size is inspected.
  // A sealed publication is a handoff, not a new normalization input.
  const inputRejection = await (dependencies.checkSize || checkInputSize)(working);
  if (inputRejection) {
    working.variables = inputRejection.variables;
    return await finishRejection(phase);
  }
  await runPhase("cpu", () => (dependencies.audit || recordProcessingDecision)(working, "admission", {
    container: "mp4", video: { codec: "HEVC", preset: settings.videoPreset, quality: settings.videoQuality },
    streamPolicy: settings, audio: "explicit following audio node; its effective input plan is captured before execution",
  }));
  try {
    working.inputFileObj = await runPhase("cpu", () => prepareMedia(working, settings, runtime));
  } catch (error) {
    if (error.code !== "UNRECOVERABLE_MEDIA_INPUT") throw error;
    working.variables = rejectInput(working, "unreadableMedia").variables;
    working.variables.gpuNormalizeAudioRejection.evidence = error.evidence;
    return await finishRejection(phase);
  }
  await runPhase("cpu", () => runtime.verifyPreparation(working, settings));
  working.variables = { ...working.variables, mediaPipelineConcurrency: inheritedConcurrency };
  prepareContract(working, "prepared");
  return { outputFileObj: working.inputFileObj, outputNumber: 1, variables: working.variables };
}

async function finishPipeline(args, context, dependencies = {}) {
  const phase = pipelineContext(args, context, dependencies);
  const { working, settings, runtime, runPhase, publish } = phase;
  if (finishContract(working)) return await finishRejection(phase);
  if (working.variables.mediaPipeline.state === "prepared") {
    working.inputFileObj = await runPhase("cpu", () => runtime.probe(working.inputFileObj._id, working.inputFileObj));
    working.inputFileObj = await processVideo(working, settings, runtime, runPhase);
    await runPhase("cpu", () => runtime.verifyFinish(working, settings));
    await runPhase("cpu", () => (dependencies.audit || recordProcessingDecision)(working, "beforeReplace"));
    working.inputFileObj = await runPhase("cpu", () => runtime.replace(working));
  }
  const published = await runPhase("cpu", () => publish(working));
  if (published.outputNumber !== 1) throw new Error("Publication did not return a committed package");
  working.inputFileObj = published.outputFileObj;
  working.variables = published.variables;
  if (published.variables.gpuNormalizeAudioNaming?.deferredPublication === true) {
    working.jobLog("Episode verified and replaced in staging; deferring multi-episode package publication until remaining siblings finish.");
    return { ...published, variables: { ...working.variables, gpuNormalizeAudioImport: { state: "deferred-sibling", imported: false } } };
  }
  await runPhase("cpu", () => (dependencies.audit || recordProcessingDecision)(working, "published"));
  if (!String(working.inputs.arr_host || "").trim()) {
    working.jobLog("Package published; no application endpoint configured.");
    return { ...published, variables: { ...published.variables, gpuNormalizeAudioImport: { state: "published", imported: false } } };
  }
  const imported = await (dependencies.notify || notifyPublishedPackage)(working);
  working.variables = imported.variables;
  if (imported.variables.gpuNormalizeAudioImport?.imported !== true) {
    const rejected = await (dependencies.rejectQuality || rejectInferiorPublication)(working);
    if (rejected) return rejected;
  }
  return { outputFileObj: imported.outputFileObj, outputNumber: 1,
    variables: imported.variables };
}

module.exports = { pipelineSettings, preparePipeline, finishPipeline };
