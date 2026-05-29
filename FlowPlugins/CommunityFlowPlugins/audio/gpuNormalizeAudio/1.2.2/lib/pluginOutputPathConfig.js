"use strict";

const {
  parseDurationSeconds,
} = require("./common");

function createPluginOutputPathConfig({
  args,
  getContainer,
  getFileName,
  getPluginWorkDir,
}) {
  const durationSeconds = parseDurationSeconds(args.inputFileObj) || 1;
  const container = getContainer(args.inputFileObj._id);
  const workDir = getPluginWorkDir(args);
  const base = getFileName(args.inputFileObj._id);
  const runId = `${process.pid}-${Date.now()}`;
  const outputFilePath = `${workDir}/${base}.${container}`;
  const tmpOutputFilePath = `${workDir}/${base}.tmp-${runId}.${container}`;
  if (outputFilePath === args.inputFileObj._id) throw new Error(`GPU normalize output path equals input path: ${outputFilePath}`);

  return {
    base,
    container,
    durationSeconds,
    outputFilePath,
    runId,
    tmpOutputFilePath,
    workDir,
  };
}

module.exports = {
  createPluginOutputPathConfig,
};
