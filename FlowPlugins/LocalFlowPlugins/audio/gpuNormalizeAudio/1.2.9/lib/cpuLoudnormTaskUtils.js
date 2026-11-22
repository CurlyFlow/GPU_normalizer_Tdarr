"use strict";

const {
  loudnormNumber,
} = require("./common");

function validateLoudnormValues(values) {
  for (const loudnormKey of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) loudnormNumber(values, loudnormKey);
}

module.exports = {
  validateLoudnormValues,
};
