"use strict";

const { q } = require("./common");

function renderShellCommand(argv) {
  return argv.map((arg) => q(arg)).join(" ");
}

module.exports = {
  renderShellCommand,
};
