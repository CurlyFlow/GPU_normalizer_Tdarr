"use strict";

const sonarjs = require("eslint-plugin-sonarjs");

module.exports = [
  {
    files: ["FlowPlugins/**/*.js", "scripts/**/*.js"],
    ignores: ["**/node_modules/**"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        __dirname: "readonly",
        Buffer: "readonly",
        console: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
      sourceType: "commonjs",
    },
    plugins: {
      sonarjs,
    },
    rules: {
      "max-lines": ["error", { "max": 1000, "skipBlankLines": true, "skipComments": true }],
      "sonarjs/cognitive-complexity": ["error", 75],
    },
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        __dirname: "readonly",
        Buffer: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        exports: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
      sourceType: "commonjs",
    },
    plugins: {
      sonarjs,
    },
    rules: {
      "no-undef": "error",
      "max-lines": ["error", { "max": 1000, "skipBlankLines": true, "skipComments": true }],
      "sonarjs/cognitive-complexity": ["error", 45],
      "sonarjs/no-identical-functions": "error",
    },
  },
  {
    files: ["work/compare/**/*.js", "work/cpu_gpu_compare.js", "work/compare-self-test.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly", Buffer: "readonly", console: "readonly", module: "readonly",
        process: "readonly", require: "readonly", setInterval: "readonly", setTimeout: "readonly",
      },
    },
    rules: {
      "max-lines": ["error", { "max": 1000, "skipBlankLines": true, "skipComments": true }],
      "no-undef": "error",
    },
  },
];
