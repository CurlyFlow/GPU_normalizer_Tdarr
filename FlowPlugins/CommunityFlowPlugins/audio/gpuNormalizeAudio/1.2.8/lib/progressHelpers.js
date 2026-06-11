"use strict";

function formatEta(seconds) {
  const value = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseTimestampSeconds(value) {
  const parts = String(value || "").trim().split(":");
  if (parts.length !== 3) return 0;
  const hrs = Number.parseFloat(parts[0]);
  const mins = Number.parseFloat(parts[1]);
  const secs = Number.parseFloat(parts[2]);
  if (![hrs, mins, secs].every(Number.isFinite)) return 0;
  return hrs * 3600 + mins * 60 + secs;
}

function ffmpegProgressFraction(line, durationSeconds) {
  if (!(durationSeconds > 0)) return null;
  const microMatch = String(line).match(/^out_time_(?:us|ms)=([0-9]+)/);
  if (microMatch) {
    const seconds = Number.parseInt(microMatch[1], 10) / 1000000;
    return Math.max(0, Math.min(1, seconds / durationSeconds));
  }
  const timeMatch = String(line).match(/^out_time=([^\s]+)/);
  if (timeMatch) {
    return Math.max(0, Math.min(1, parseTimestampSeconds(timeMatch[1]) / durationSeconds));
  }
  return null;
}

function gpuProgressFraction(line) {
  const match = String(line).match(/^tdarr_progress\s+phase=\S+\s+fraction=([0-9.]+)/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function createProgressUpdater(args, totalWork, baselineSeconds = 0) {
  const started = Date.now();
  let lastPercentage = 0;
  let lastUpdate = 0;
  let lastEta = null;
  return (workDone, force = false) => {
    if (typeof args.updateWorker !== "function" || !(totalWork > 0)) return;
    const now = Date.now();
    const percentage = Math.max(lastPercentage, Math.min(99.9, (workDone / totalWork) * 100));
    if (!force && now - lastUpdate < 1000 && percentage - lastPercentage < 0.1) return;
    const elapsed = (now - started) / 1000;
    if (percentage <= 0) {
      const baselineEta = Math.max(0, baselineSeconds - elapsed);
      args.updateWorker({ percentage: 0, ETA: formatEta(baselineEta) });
      lastUpdate = now;
      lastEta = baselineEta > 0 ? baselineEta : null;
      return;
    }
    const rateEstimate = (elapsed / percentage) * (100 - percentage);
    let estimate = rateEstimate;
    if (baselineSeconds > 0) {
      const baselineCountdown = Math.max(0, baselineSeconds - elapsed);
      const lagWindow = Math.max(1, baselineSeconds * 0.3);
      const lagRatio = Math.max(0, (elapsed - (baselineSeconds * 0.7)) / lagWindow);
      const progressWeight = Math.min(0.6, lagRatio * 0.25);
      estimate = baselineCountdown + ((Math.max(rateEstimate, baselineCountdown) - baselineCountdown) * progressWeight);
    }
    let eta = estimate;
    if (lastEta !== null) {
      const sinceLast = Math.max(0, (now - lastUpdate) / 1000);
      const countdownEta = Math.max(0, lastEta - sinceLast);
      eta = estimate > countdownEta
        ? countdownEta + ((estimate - countdownEta) * 0.2)
        : estimate;
    }
    args.updateWorker({ percentage: Number(percentage.toFixed(2)), ETA: formatEta(eta) });
    lastPercentage = percentage;
    lastUpdate = now;
    lastEta = eta;
  };
}

module.exports = {
  createProgressUpdater,
  ffmpegProgressFraction,
  gpuProgressFraction,
};
