const fs = require('fs');

const plugin = require('/app/Tdarr_Node/assets/app/plugins/FlowPlugins/CommunityFlowPlugins/opxGpuNormalizeExactDev/1.0.0/index.js');

async function main() {
  const input = '/mnt/tdarr-dev/bench/results/source-port-canary-20260504/bbb_12s_plugin.mov';
  const workDir = '/mnt/tdarr-dev/bench/results/source-port-canary-20260504/plugin-short-work';
  fs.mkdirSync(workDir, { recursive: true });
  const logs = [];
  const args = {
    inputFileObj: {
      _id: input,
      ffProbeData: {
        format: { duration: '12.000000' },
        streams: [
          { codec_type: 'video' },
          { codec_type: 'audio', duration: '12.000000', tags: { language: 'eng' } },
        ],
      },
    },
    ffmpegPath: 'tdarr-ffmpeg',
    platform: 'linux',
    workDir,
    deps: { fsextra: { ensureDirSync: (dir) => fs.mkdirSync(dir, { recursive: true }) } },
    variables: {},
    inputs: {
      plannerMode: 'gpuSourcePort',
      gpuPlanCorePath: '/app/server/opx/bin/opx-loudnorm-gpu-source-port',
      sourceCorePath: '/app/server/opx/bin/opx-loudnorm-source-cpu.plugin-dev',
      gpuApplyPath: '/app/server/opx/bin/opx-gpu-apply-sample-gains',
      gpuChunkMiB: '64',
      i: '-18.0',
      lra: '7.0',
      tp: '-2.0',
      maxGain: '15',
      sampleRate: '192000',
      channels: '6',
      audioBitrate: '192k',
      maxPcmMiB: '8192',
    },
    jobLog: (line) => logs.push(String(line)),
    logFullCliOutput: false,
    updateWorker: () => {},
  };
  const started = Date.now();
  const result = await plugin.plugin(args);
  const elapsed = (Date.now() - started) / 1000;
  const output = result.outputFileObj._id;
  console.log(JSON.stringify({ elapsed, output, size: fs.statSync(output).size, logs }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
