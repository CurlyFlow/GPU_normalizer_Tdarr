"use strict";

const fs = require('node:fs');
const crypto = require('node:crypto');
const { fileStamp } = require('./mediaEvidenceFiles');

function nativePcmFormat(stream) {
  if (/^pcm_[su]64/.test(stream?.codec || stream?.codec_name || '')) {
    throw new Error('Integer64 PCM needs an exact integer comparator; floating-point conversion is not acceptance');
  }
  // AAC's default float decoder and explicit float32 PCM lose no precision in f32.
  // Unknown, integer32 and double decoders use f64; never round them to float32.
  return /^(aac|pcm_f32le|pcm_f32be)$/.test(stream?.codec || stream?.codec_name || '') ? 'f32le' : 'f64le';
}

function pcmBytes(format) {
  if (format === 'f32le') return 4;
  if (format === 'f64le') return 8;
  throw new Error(`Unsupported comparison PCM format: ${format}`);
}

function validateNativePcmPair(value) {
  for (const pcm of [value.source, value.candidate]) {
    const width = pcm?.format === "f32le" ? 4 : pcm?.format === "f64le" ? 8 : 0;
    if (!width || pcm.finite !== true || pcm.aligned !== true || !Number.isSafeInteger(pcm.samples) || pcm.samples < 1
        || !Number.isSafeInteger(pcm.bytes) || pcm.bytes !== pcm.samples * width
        || !/^[a-f0-9]{64}$/.test(pcm.sha256)) throw Error("Invalid native PCM identity");
  }
  if (value.source.format !== value.candidate.format || value.source.sha256 !== value.candidate.sha256
      || value.source.bytes !== value.candidate.bytes) throw Error("Native audio samples differ");
}

class PcmFingerprint {
  constructor(format) {
    this.width = pcmBytes(format);
    this.format = format;
    this.hash = crypto.createHash('sha256');
    this.bytes = 0;
    this.samples = 0;
    this.finite = true;
    this.pending = Buffer.alloc(0);
    this.finished = false;
  }

  update(chunk) {
    if (this.finished || !Buffer.isBuffer(chunk)) throw Error('Invalid PCM fingerprint update');
    this.bytes += chunk.length;
    if (!Number.isSafeInteger(this.bytes)) throw Error('PCM evidence exceeds exact byte-count bounds');
    this.hash.update(chunk);
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const end = data.length - data.length % this.width;
    for (let offset = 0; offset < end; offset += this.width) {
      const value = this.width === 8 ? data.readDoubleLE(offset) : data.readFloatLE(offset);
      if (!Number.isFinite(value)) this.finite = false;
    }
    this.samples += end / this.width;
    this.pending = Buffer.from(data.subarray(end));
  }

  finish() {
    if (this.finished) throw Error('PCM fingerprint already completed');
    this.finished = true;
    return { format: this.format, bytes: this.bytes, samples: this.samples,
      aligned: this.pending.length === 0, finite: this.finite, sha256: this.hash.digest('hex') };
  }
}

function compareRaw(srcCpuRaw, gpuRaw, opts = {}) {
  const started = Date.now(), format = opts.format || 'f32le', width = pcmBytes(format);
  const descriptors = [];
  try {
    for (const file of [srcCpuRaw, gpuRaw]) descriptors.push(fs.openSync(file, 'r'));
    const before = descriptors.map(fd => fs.fstatSync(fd, { bigint: true }));
    if (before.some(stat => !stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('Invalid raw audio evidence');
    const [bytesSrcCpu, bytesGpu] = before.map(stat => Number(stat.size));
    const totalBytes = Math.floor(Math.min(bytesSrcCpu, bytesGpu) / width) * width;
    const fingerprints = descriptors.map(() => new PcmFingerprint(format));
    const buffers = descriptors.map(() => Buffer.allocUnsafe(16 * 1024 * 1024));
    let offset = 0, samples = 0, sumRef2 = 0, sumDiff2 = 0, peakDiff = 0, equal = 0;
    while (offset < totalBytes) {
      const want = Math.min(buffers[0].length, totalBytes - offset);
      const reads = descriptors.map((fd, index) => fs.readSync(fd, buffers[index], 0, want, offset));
      if (reads.some(read => read !== want)) throw new Error('Incomplete raw audio read');
      buffers.forEach((buffer, index) => fingerprints[index].update(buffer.subarray(0, want)));
      const View = width === 8 ? Float64Array : Float32Array;
      const [reference, candidate] = buffers.map(buffer => new View(buffer.buffer, buffer.byteOffset, want / width));
      for (let index = 0; index < reference.length; index++) {
        const ref = reference[index], value = candidate[index];
        if (!Number.isFinite(ref) || !Number.isFinite(value)) continue;
        const diff = value - ref;
        sumRef2 += ref * ref;
        sumDiff2 += diff * diff;
        peakDiff = Math.max(peakDiff, Math.abs(diff));
        if (Object.is(ref, value)) equal++;
      }
      samples += want / width;
      offset += want;
    }
    for (let index = 0; index < descriptors.length; index++) {
      if (fileStamp(before[index]) !== fileStamp(fs.fstatSync(descriptors[index], { bigint: true }))
          || fileStamp(before[index]) !== fileStamp(fs.statSync([srcCpuRaw, gpuRaw][index], { bigint: true }))) {
        throw new Error('Raw audio changed during comparison');
      }
    }
    const evidence = fingerprints.map(value => value.finish());
    const actualHashes = evidence.map(value => value.sha256);
    const expected = [opts.srcCpuIdentity, opts.gpuIdentity];
    const identityMatch = expected.every((identity, index) => !identity
      || (identity.sha256 === actualHashes[index] && identity.bytes === Number(before[index].size)));
    const rmsSrcCpu = samples > 0 ? Math.sqrt(sumRef2 / samples) : 0;
    const rmsDiff = samples > 0 ? Math.sqrt(sumDiff2 / samples) : 0;
    const elapsed = (Date.now() - started) / 1000;
    return { format, samples, bytes_src_cpu: bytesSrcCpu, bytes_gpu: bytesGpu,
      length_match: bytesSrcCpu === bytesGpu, aligned: bytesSrcCpu % width === 0 && bytesGpu % width === 0,
      finite: evidence.every(value => value.finite), identity_match: identityMatch, elapsed_sec: Number(elapsed.toFixed(3)),
      throughput_mib_s: elapsed > 0 ? Number((totalBytes / (1024 * 1024) / elapsed).toFixed(1)) : null,
      rms_src_cpu: rmsSrcCpu, rms_diff: rmsDiff, peak_diff: peakDiff,
      equal_fraction: samples > 0 ? equal / samples : 0,
      snr_db: sumDiff2 === 0 ? 999 : 10 * Math.log10(Math.max(sumRef2, 1e-300) / Math.max(sumDiff2, 1e-300)),
      energy_similarity: rmsSrcCpu === 0 && rmsDiff === 0 ? 1 : Math.max(0, 1 - rmsDiff / Math.max(rmsSrcCpu, 1e-30)) };
  } finally {
    descriptors.forEach(fd => fs.closeSync(fd));
  }
}

module.exports = { nativePcmFormat, pcmBytes, compareRaw, PcmFingerprint, validateNativePcmPair };
