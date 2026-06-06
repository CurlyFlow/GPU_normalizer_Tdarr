"use strict";

function profileValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(6) : String(value);
  return String(value).replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.=:+-]/g, "_");
}

function logProfileStage(args, fields) {
  if (args.logFullCliOutput !== true) return;
  args.jobLog(`profile_stage ${Object.entries(fields).map(([key, value]) => `${key}=${profileValue(value)}`).join(" ")}`);
}

module.exports = {
  logProfileStage,
};
