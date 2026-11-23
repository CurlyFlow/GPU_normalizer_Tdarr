"use strict";

const assert = require("node:assert/strict");

const MAX_SAMPLES = BigInt(Number.MAX_SAFE_INTEGER);
// Default SWR filter_size=32, cutoff=.97 and exact rational phases. These
// source-defined pairs have even filter lengths 32/66 in Jellyfin7.1.2.
const FILTER_LENGTH = new Map([["44100:192000", 32n], ["48000:192000", 32n],
  ["32000:192000", 32n], ["192000:96000", 66n], ["96000:192000", 32n]]);
const AAC_RATES = new Set([96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350]);

function requireRate(rate) {
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && rate <= 192000, "Invalid count-model rate");
}

function resampledSamples(samples, inputRate, outputRate) {
  assert.ok(typeof samples === "bigint" && samples >= 0n && samples <= MAX_SAMPLES, "Invalid source sample count");
  requireRate(inputRate); requireRate(outputRate);
  if (inputRate === outputRate) return samples;
  const length = FILTER_LENGTH.get(`${inputRate}:${outputRate}`);
  assert.ok(length, "Unqualified resampler count pair");
  let effective = samples;
  if (samples < length + 1n) {
    // invert_initial_buffer cannot start until F+1 samples exist. EOF adds
    // ceil(min(N,F)/2); after the initial mirror, the usable extent is B-F/2.
    const reflected = ((samples < length ? samples : length) + 1n) / 2n;
    if (samples + reflected < length + 1n) return 0n;
    effective = samples + reflected - length / 2n;
  }
  // Once initialized, phase plus buffered-input conservation and EOF reflection
  // leave this exact rational extent. This is not a universal short-input ceil.
  const count = (effective * BigInt(outputRate) + BigInt(inputRate) - 1n) / BigInt(inputRate);
  assert.ok(count <= MAX_SAMPLES, "Resampled count exceeds its bound");
  return count;
}

// Count projection only. Callers still need the approved rate/transform, actual
// priming and stored windows, full CPU values, source clocks and file generations.
function normalizedAacCounts({ sourceSamples, sourceRate, processingRate, encodedRate }) {
  assert.ok(AAC_RATES.has(encodedRate), "Unsupported native AAC count rate");
  const processingSamples = resampledSamples(sourceSamples, sourceRate, processingRate);
  const validSamples = resampledSamples(processingSamples, processingRate, encodedRate);
  assert.ok(validSamples > 0n, "Normalized stream has no qualified output samples");
  const decodedSamples = ((validSamples + 1023n) / 1024n) * 1024n;
  assert.ok(decodedSamples <= MAX_SAMPLES, "AAC decoded count exceeds its bound");
  return { sourceSamples, processingSamples, validSamples, decodedSamples,
    paddingSamples: decodedSamples - validSamples };
}

// Possible default CPU rate paths, not an observed processing mode or approval.
// The actual CPU rate/value proof, selected transform and stored windows remain
// mandatory. Ambiguous valid extents cannot be hidden by equal AAC block counts.
function normalizedAacCountDomain({ sourceSamples, sourceRate, encodedRate, stereo }) {
  requireRate(sourceRate);
  assert.equal(typeof stereo, "boolean", "Invalid stereo preparation");
  assert.ok(AAC_RATES.has(encodedRate), "Unsupported native AAC count rate");
  const preparationRate = stereo ? 192000 : sourceRate;
  const preparationSamples = resampledSamples(sourceSamples, sourceRate, preparationRate);
  const rates = [...new Set([preparationRate, 192000])].filter(rate =>
    encodedRate === (rate === 192000 ? 96000 : rate));
  assert.ok(rates.length, "No native normalization rate profile");
  const options = rates.map(processingRate => ({ processingRate,
    counts: normalizedAacCounts({ sourceSamples: preparationSamples, sourceRate: preparationRate,
      processingRate, encodedRate }) }));
  const { validSamples, decodedSamples, paddingSamples } = options[0].counts;
  assert.ok(options.every(option => option.counts.validSamples === validSamples
    && option.counts.decodedSamples === decodedSamples && option.counts.paddingSamples === paddingSamples),
  "Ambiguous normalized sample extent");
  return { sourceSamples, preparationRate, preparationSamples,
    profiles: options.map(option => ({ processingRate: option.processingRate,
      processingSamples: option.counts.processingSamples })), validSamples, decodedSamples, paddingSamples };
}

module.exports = { resampledSamples, normalizedAacCounts, normalizedAacCountDomain };
