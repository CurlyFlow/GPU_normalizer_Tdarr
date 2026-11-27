"use strict";

function audioClockMaps(args, audioSpecs, outputContract) {
  if (!Array.isArray(audioSpecs) || !audioSpecs.length) throw Error("Missing effective audio clock mapping");
  const expectedAudio = outputContract?.filter(stream => stream.type === "audio");
  if (!expectedAudio || expectedAudio.length !== audioSpecs.length) throw Error("Missing effective output audio contract");
  return audioSpecs.map((spec, candidateIndex) => {
    let sourceIndex, channels, compareSamples = false;
    if (spec.kind === "source") {
      const match = /^0:a:(\d+)$/.exec(spec.mapArg);
      if (!match) throw Error("Invalid original audio clock mapping");
      sourceIndex = Number(match[1]);
      channels = Number(spec.stream?.channels);
      const sourceCodec = String(spec.stream?.codec_name || spec.stream?.codec || "").toLowerCase();
      if (!sourceCodec || !expectedAudio[candidateIndex].codecName) throw Error("Unknown copied audio codec contract");
      compareSamples = expectedAudio[candidateIndex].codecName === sourceCodec;
    } else if (["normalizedFile", "directNormalized", "encodedDirectNormalized"].includes(spec.kind)) {
      sourceIndex = spec.plan?.sourceAudioIdx;
      channels = Number(spec.plan?.channels);
      if (spec.plan?.sourceInput !== args.inputFileObj._id) throw Error("Foreign normalized audio clock source");
    } else throw Error("Unsupported audio clock transformation");
    return { id: `a${candidateIndex}`, sourceIndex, candidateIndex, channels, rate: null, sampleBytes: 8, compareSamples };
  });
}

module.exports = { audioClockMaps };
