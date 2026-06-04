"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const {
  details,
} = require("./lib/pluginDetails");
const {
  runGpuNormalizePlugin,
} = require("./lib/pluginMain");

const PLUGIN_ROOT = __dirname;

exports.details = details;

const plugin = async (args) => {
  return await runGpuNormalizePlugin(args, {
    details,
    pluginRoot: PLUGIN_ROOT,
  });
};
exports.plugin = plugin;
