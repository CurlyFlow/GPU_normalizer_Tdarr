"use strict";

const {
  ffmpegProgressFraction,
  logProfileStage,
  q,
} = require("./common");
const {
  buildOutputProbeCommand,
  parseOutputProbe,
  validateOutputStreams,
} = require("./outputValidation");
const { verifyAudioOutputClock } = require("./audioOutputClock");
const { observeAudioOutputValues, verifyAudioOutputValues } = require("./audioOutputValues");
const { bindAudioHandoff } = require("./mediaAudioHandoff");
const { transportAudioOutput } = require("./audioOutputTransport");
const { gainSkippedStereoCommand } = require("./audioGainPolicy");

async function publishOutputPackage({
  args,
  ffmpegPath,
  outputContract,
  audioSpecs,
  pluginStartedAt,
  tmpOutputFilePath,
  outputFilePath,
  cleanupAll,
  publishLabel = "publish GPU normalize output",
  resultMessage,
  runChecked,
  observeValues,
  verifyValues,
  transportAudio,
  verifyLabel = "validate GPU normalize output streams",
}) {
  const transaction = {
    cleanup: "pending",
    outputFilePath,
    publish: "pending",
    state: "verify_tmp",
    tmpOutputFilePath,
    verifyTmp: "pending",
  };
  const verifyRes = await runChecked(buildOutputProbeCommand({
    ffmpegPath,
    outputPath: tmpOutputFilePath,
  }), { label: verifyLabel });
  validateOutputStreams(outputContract, parseOutputProbe(verifyRes.output));
  const valueBasis = await observeValues(args, tmpOutputFilePath, audioSpecs, outputContract);
  const transported = await transportAudio(args, tmpOutputFilePath, audioSpecs, outputContract);
  if (transported !== tmpOutputFilePath) {
    tmpOutputFilePath = transported;
    transaction.tmpOutputFilePath = transported;
    const transportProbe = await runChecked(buildOutputProbeCommand({ ffmpegPath, outputPath: transported }),
      { label: "validate transported package streams" });
    validateOutputStreams(outputContract, parseOutputProbe(transportProbe.output));
  }
  await verifyAudioOutputClock(args, tmpOutputFilePath, audioSpecs, outputContract);
  await verifyValues(args, tmpOutputFilePath, audioSpecs, outputContract, valueBasis);
  transaction.verifyTmp = "done";
  transaction.state = "publish";
  logProfileStage(args, { scope: "plugin", name: "verify_output", wall_sec: verifyRes.wallSec });
  const publishRes = await runChecked(`mv -f ${q(tmpOutputFilePath)} ${q(outputFilePath)}`, { label: publishLabel });
  bindAudioHandoff(args, tmpOutputFilePath, outputFilePath);
  transaction.publish = "done";
  transaction.state = "cleanup";
  logProfileStage(args, { scope: "plugin", name: "publish_output", wall_sec: publishRes.wallSec });
  try {
    const cleanupFinalRes = await runChecked(cleanupAll, { label: "cleanup GPU normalize intermediates" });
    transaction.cleanup = "done";
    logProfileStage(args, { scope: "plugin", name: "cleanup", wall_sec: cleanupFinalRes.wallSec });
  } catch (err) {
    transaction.cleanup = "failed";
    args.jobLog(`GPU normalize cleanup after publish failed; output already published: ${err.message || err}`);
  }
  transaction.state = "complete";
  logProfileStage(args, { scope: "plugin", name: "whole_plugin", wall_sec: (Date.now() - pluginStartedAt) / 1000 });
  args.jobLog(resultMessage);
  if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
  return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
}

function createOutputFinalizer({ model, runtimeContext, observeValues = observeAudioOutputValues, verifyValues = verifyAudioOutputValues,
  transportAudio = transportAudioOutput }) {
  const { args, pluginStartedAt } = model.core;
  const { durationSeconds, tmpOutputFilePath, outputFilePath } = model.runtimeConfig.outputPathConfig;
  const {
    buildMux, cleanupAll, finalAudioSpecs,
    audioPlans, skippedAudioPlans, removedAudioPlans = [], finalOutputContract, updateProgress,
  } = model.planSetup;
  const { runChecked } = runtimeContext;
  const gainSkipped = new Map();
  const skipNormalization = async (plan, reason) => {
    if (!audioPlans.includes(plan)) throw Error("Gain outcome belongs to an unknown audio plan");
    if (gainSkipped.has(plan.idx)) return await gainSkipped.get(plan.idx);
    const task = (async () => {
      args.jobLog(`GPU Normalize Audio: gain gate exceeded (${reason}); retaining only audio stream ${plan.sourceIdx}${plan.stereoFallback ? " as requested stereo without normalization" : " unchanged"}.`);
      if (plan.stereoFallback) await runChecked(gainSkippedStereoCommand(args, plan,
        model.runtimeConfig.audioConfig.audioBitrate), { label: "encode gain-skipped stereo without normalization" });
    })();
    gainSkipped.set(plan.idx, task);
    return await task;
  };
  const finalizeOutput = async ({ completedWork, muxWork, directMuxCompleted }) => {
    const resolved = gainSkipped.size ? model.planSetup.finalOutputFor(new Set(gainSkipped.keys()))
      : { buildMux, audioSpecs: finalAudioSpecs, outputContract: finalOutputContract };
    if (directMuxCompleted && gainSkipped.size) throw Error("Direct mux cannot publish changed gain outcomes");
    if (directMuxCompleted) {
      logProfileStage(args, { scope: "plugin", name: "final_mux", wall_sec: 0, direct_paired: 1 });
    } else {
      const muxRes = await runChecked(resolved.buildMux(), {
        label: "mux normalized audio streams",
        parseLine: (line) => {
          const fraction = ffmpegProgressFraction(line, durationSeconds);
          if (fraction !== null) updateProgress(completedWork + muxWork * fraction);
        },
      });
      logProfileStage(args, { scope: "plugin", name: "final_mux", wall_sec: muxRes.wallSec });
    }
    return await publishOutputPackage({
      args,
      ffmpegPath: args.ffmpegPath,
      outputContract: resolved.outputContract,
      audioSpecs: resolved.audioSpecs,
      pluginStartedAt,
      tmpOutputFilePath,
      outputFilePath,
      cleanupAll,
      resultMessage: `GPU Normalize Audio result: ${audioPlans.length - gainSkipped.size} normalized audio stream(s), ${gainSkipped.size} gain-limited stream(s), ${skippedAudioPlans.length} unselected stream(s), and ${removedAudioPlans.length} removed stream(s).`,
      runChecked,
      observeValues,
      verifyValues,
      transportAudio,
    });
  };

  return {
    finalizeOutput,
    skipNormalization,
  };
}

module.exports = {
  createOutputFinalizer,
};
