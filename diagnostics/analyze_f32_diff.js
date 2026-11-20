const fs = require('fs');

const [cpuPath, gpuPath, byteArg, channelsArg = '6', rateArg = '48000'] = process.argv.slice(2);
if (!cpuPath || !gpuPath || !byteArg) {
  throw new Error('usage: node analyze_f32_diff.js cpu.f32 gpu.f32 firstByte [channels] [rate]');
}

const channels = Number(channelsArg);
const rate = Number(rateArg);
const firstByte = BigInt(byteArg);
const sample = Number(firstByte / 4n);
const frame = Math.floor(sample / channels);
console.log(JSON.stringify({ firstByte: String(firstByte), sample, frame, channel: sample % channels, byteInFloat: Number(firstByte % 4n), sec: frame / rate }));

const cpu = fs.openSync(cpuPath, 'r');
const gpu = fs.openSync(gpuPath, 'r');

function readFrames(fd, start, frames) {
  const buf = Buffer.alloc(frames * channels * 4);
  fs.readSync(fd, buf, 0, buf.length, start * channels * 4);
  return new Float32Array(buf.buffer, buf.byteOffset, frames * channels);
}

const start = Math.max(0, frame - 5);
const a = readFrames(cpu, start, 20);
const b = readFrames(gpu, start, 20);
for (let fr = 0; fr < 20; fr += 1) {
  let diff = false;
  for (let c = 0; c < channels; c += 1) {
    if (a[fr * channels + c] !== b[fr * channels + c]) diff = true;
  }
  if (diff || Math.abs((start + fr) - frame) <= 1) {
    let line = `frame=${start + fr} sec=${((start + fr) / rate).toFixed(6)}`;
    for (let c = 0; c < channels; c += 1) {
      const av = a[fr * channels + c];
      const bv = b[fr * channels + c];
      line += ` c${c}=${av.toPrecision(8)}/${bv.toPrecision(8)} d=${(bv - av).toExponential(3)}`;
    }
    console.log(line);
  }
}

function rmsAt(offset, startFrame, frames) {
  const aa = readFrames(cpu, startFrame, frames);
  const bb = readFrames(gpu, startFrame + offset, frames);
  let sum = 0;
  let max = 0;
  let eq = 0;
  for (let i = 0; i < aa.length; i += 1) {
    const d = bb[i] - aa[i];
    sum += d * d;
    const ad = Math.abs(d);
    if (ad > max) max = ad;
    if (aa[i] === bb[i]) eq += 1;
  }
  return { offset, rms: Math.sqrt(sum / aa.length), max, eq: eq / aa.length };
}

const scanStart = Math.max(0, frame - 24000);
for (const off of [-1024, -512, -256, -128, -64, -32, -16, -8, -4, -2, -1, 0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
  console.log(JSON.stringify(rmsAt(off, scanStart, 48000)));
}

fs.closeSync(cpu);
fs.closeSync(gpu);
