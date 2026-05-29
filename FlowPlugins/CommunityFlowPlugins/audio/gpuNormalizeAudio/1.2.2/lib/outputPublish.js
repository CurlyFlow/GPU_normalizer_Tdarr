"use strict";

const {
  logProfileStage,
  q,
} = require("./common");

async function publishOutputPackage({
  args,
  pluginStartedAt,
  tmpOutputFilePath,
  outputFilePath,
  cleanupAll,
  publishLabel = "publish GPU normalize output",
  resultMessage,
  runChecked,
  verifyLabel = "verify GPU normalize output",
}) {
  const verifyRes = await runChecked(`test -s ${q(tmpOutputFilePath)}`, { label: verifyLabel });
  logProfileStage(args, { scope: "plugin", name: "verify_output", wall_sec: verifyRes.wallSec });
  const publishRes = await runChecked(`mv -f ${q(tmpOutputFilePath)} ${q(outputFilePath)}`, { label: publishLabel });
  logProfileStage(args, { scope: "plugin", name: "publish_output", wall_sec: publishRes.wallSec });
  const cleanupFinalRes = await runChecked(cleanupAll, { label: "cleanup GPU normalize intermediates" });
  logProfileStage(args, { scope: "plugin", name: "cleanup", wall_sec: cleanupFinalRes.wallSec });
  logProfileStage(args, { scope: "plugin", name: "whole_plugin", wall_sec: (Date.now() - pluginStartedAt) / 1000 });
  args.jobLog(resultMessage);
  if (typeof args.updateWorker === "function") args.updateWorker({ percentage: 100, ETA: "0:00:00" });
  return { outputFileObj: { _id: outputFilePath }, outputNumber: 1, variables: args.variables };
}

module.exports = {
  publishOutputPackage,
};
