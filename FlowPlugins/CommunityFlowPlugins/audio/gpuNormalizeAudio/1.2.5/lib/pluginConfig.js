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

function createPluginRuntimeConfig({
  args,
  runtimeBin,
  getContainer,
  getFileName,
  getPluginWorkDir,
}) {
  const runtimePathConfig = createPluginRuntimePathConfig({ args, runtimeBin });
  const {
    useGpuSourcePort,
  } = runtimePathConfig;
  const audioConfig = createPluginAudioConfig({
    args,
    useGpuSourcePort,
  });
  const outputPathConfig = createPluginOutputPathConfig({
    args,
    getContainer,
    getFileName,
    getPluginWorkDir,
  });

  return {
    audioConfig,
    outputPathConfig,
    runtimePathConfig,
  };
}

module.exports = {
  createPluginRuntimeConfig,
};
