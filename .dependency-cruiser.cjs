"use strict";

module.exports = {
  forbidden: [
    {
      name: "no-circular-js-dependencies",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "release-code-must-not-import-local-source",
      severity: "error",
      from: { path: "^FlowPlugins/" },
      to: { path: "^src/" },
    },
    {
      name: "output-data-and-command-policy-stay-below-orchestration",
      severity: "error",
      from: { path: "^src/gpuNormalizeAudio/lib/(audioChannelHelpers|outputAudioSpecs|outputMux|outputValidation|commandRenderer|common)\\.js$" },
      to: {
        path: "^src/gpuNormalizeAudio/lib/",
        pathNot: "^src/gpuNormalizeAudio/lib/(audioChannelHelpers|outputAudioSpecs|outputMux|outputValidation|commandRenderer|common)\\.js$",
      },
    },
    {
      name: "stats-does-not-own-processing-or-publication",
      severity: "error",
      from: { path: "^src/gpuNormalizeAudio/lib/(cpuLoudnorm|splitStats)" },
      to: { path: "^src/gpuNormalizeAudio/lib/(plugin|pairedApply|outputFinalizer|streamProcessor)" },
    },
    {
      name: "paired-apply-does-not-own-stats-scheduling",
      severity: "error",
      from: { path: "^src/gpuNormalizeAudio/lib/pairedApply" },
      to: {
        path: "^src/gpuNormalizeAudio/lib/(cpuLoudnorm|splitStats)",
        pathNot: "^src/gpuNormalizeAudio/lib/(cpuLoudnormTelemetry|splitStatsPolicy)\\.js$",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)runtime/",
    moduleSystems: ["cjs"],
  },
};
