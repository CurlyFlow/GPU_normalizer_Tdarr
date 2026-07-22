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
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)runtime/",
    moduleSystems: ["cjs"],
  },
};
