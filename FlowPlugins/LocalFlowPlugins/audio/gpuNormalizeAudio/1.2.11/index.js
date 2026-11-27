"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const {
  details,
} = require("./lib/pluginDetails");
const {
  runGpuNormalizePlugin,
} = require("./lib/pluginMain");
const { audioInput, audioResult } = require("./lib/pipelineContract");

const PLUGIN_ROOT = __dirname;

exports.details = details;

const plugin = async (args) => {
  audioInput(args);
  const inputId = args.inputFileObj._id;
  const working = { ...args, inputs: { ...args.inputs, removeRejectedFromTdarr: false },
    variables: { ...args.variables, removeFromTdarr: false } };
  const result = await runGpuNormalizePlugin(working, {
    details,
    pluginRoot: PLUGIN_ROOT,
  });
  return audioResult(working, inputId, result);
};
exports.plugin = plugin;
