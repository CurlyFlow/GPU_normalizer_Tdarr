"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { withMovie } = require("./mediaMovieFile");
const { audioPresentation } = require("./mediaAudioWindow");
const { isMovieContainer, exactMovieTimescale, movieClockDenominator } = require("./outputAudioSpecs");

// Called only after private outputs exist, never during audio planning.
function finalMuxMovieTimescale({ inputFile, inputStreams, audioSpecs, outputFile }) {
  if (!isMovieContainer(path.extname(outputFile).slice(1).toLowerCase())) return null;
  assert.ok(inputStreams.length <= 256 && audioSpecs.length <= 128);
  const denominators = [1];
  if (isMovieContainer(path.extname(inputFile).slice(1).toLowerCase())) {
    denominators.push(withMovie(inputFile, (reader, top) => {
      const header = reader.one(reader.children(reader.one(top, "moov")), "mvhd");
      const { version } = reader.full(header);
      assert.ok(version === 0 || version === 1, "Unsupported original movie clock version");
      return reader.read(header, header.start + (version ? 20 : 12), 4);
    }));
  }
  const copiedAudio = new Set(audioSpecs.filter(spec => spec.kind === "source").map(spec => spec.stream.index));
  for (const stream of inputStreams) {
    const type = stream.codec_type || stream.type;
    if (type === "audio") {
      if (!copiedAudio.has(stream.index)) continue;
      if (stream.sample_rate !== undefined) denominators.push(stream.sample_rate);
    } else if (type !== "video") {
      // Subtitle (e.g. mov_text 1/1000000) and data tracks do not need their
      // microsecond timescale folded into mvhd; doing so inflates movie_timescale
      // (e.g. lcm(96000, 1e6)=24M) and overflows 32-bit stts chapter durations.
      continue;
    }
    if (stream.time_base === undefined) continue;
    const match = /^(\d{1,20})\/(\d{1,20})$/.exec(String(stream.time_base));
    assert.ok(match && BigInt(match[1]) > 0n && BigInt(match[2]) > 0n, "Invalid retained stream clock");
    denominators.push(movieClockDenominator({ numerator: match[1], denominator: match[2] }));
  }
  for (const spec of audioSpecs.filter(item => item.kind === "normalizedFile")) {
    const windows = audioPresentation(spec.plan.normalizedAudio).tracks;
    assert.equal(windows.length, 1, "Private normalized AAC must contain one audio stream");
    denominators.push(windows[0].rate, movieClockDenominator(windows[0].declaredEnd));
  }
  return exactMovieTimescale(denominators);
}

module.exports = { finalMuxMovieTimescale };
