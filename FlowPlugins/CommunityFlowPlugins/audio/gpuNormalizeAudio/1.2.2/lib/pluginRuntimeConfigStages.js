"use strict";

const {
  createPluginRuntimePathConfig,
} = require("./pluginRuntimePathConfig");
const {
  createPluginOutputPathConfig,
} = require("./pluginOutputPathConfig");
const {
  createPluginAudioConfig,
} = require("./pluginAudioConfig");

function createRuntimePathConfigStage({ args, runtimeBin }) {
  return createPluginRuntimePathConfig({ args, runtimeBin });
}

function createAudioConfigStage({ args, runtimePathConfig }) {
  return createPluginAudioConfig({
    args,
    useGpuSourcePort: runtimePathConfig.useGpuSourcePort,
  });
}

function createOutputPathConfigStage({
  args,
  getContainer,
  getFileName,
  getPluginWorkDir,
}) {
  return createPluginOutputPathConfig({
    args,
    getContainer,
    getFileName,
    getPluginWorkDir,
  });
}

module.exports = {
  createAudioConfigStage,
  createOutputPathConfigStage,
  createRuntimePathConfigStage,
};
