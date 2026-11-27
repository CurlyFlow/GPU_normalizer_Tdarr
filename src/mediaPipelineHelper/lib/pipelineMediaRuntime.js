"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { runTerminalWorker } = require("./pipelineTerminalWorker");
const { mediaTools } = require("./mediaTools");
const { verifyPreparationEvidence } = require("./pipelinePreparationEvidence");
const { verifyVideoInWorker } = require("./pipelineVideoWorker");
const { retainPreparationIntent } = require("./pipelinePreparationIntent");
const { verifyFinish } = require("./pipelineFinish");
const { retainedReceipt } = require("./mediaEvidenceFiles");
const { inspectMedia } = require("./mediaSourceProbe");
const {
  buildMp4LeadingChapterMetadata,
  ensureMp4Av1DoviBoxes,
  wireMp4ChapterMetadataInput,
} = require("./mediaIsoCarriers");

function probeFailure(message, code, mediaProbe) {
  return Object.assign(new Error(message), { code, mediaProbe });
}

function privateDiagnostic(args, text) {
  for (const credential of [args.configVars?.config?.apiKey, args.inputs?.arr_api_key]) {
    if (typeof credential === "string" && credential.length >= 4) text = text.split(credential).join("[redacted]");
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\b[a-f0-9]{32,64}\b/gi, "[redacted-token]")
    .replace(/((?:api[_-]?key|token|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

async function readableInput(args) {
  const file = args.inputFileObj._id;
  const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || await fs.realpath(file) !== file) {
    throw Error("FFmpeg readability requires a canonical single-link source");
  }
  const fileIdentity = fields.map(field => String(before[field]));
  return await new Promise((resolve, reject) => {
    const child = spawn(mediaTools(args).ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", "-threads", "1",
      "-fflags", "+genpts", "-err_detect", "ignore_err", "-i", args.inputFileObj._id,
      "-map", "0:v:0?", "-map", "0:a:0?", "-t", "1", "-frames:v", "1", "-f", "null", "-"],
    { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 60000);
    child.stderr.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-16384); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("FFmpeg input reader could not start")); });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (expired || signal || code === null) return reject(new Error("FFmpeg input readability was not established"));
      try {
        const after = await fs.lstat(file, { bigint: true });
        if (fields.some((field, index) => String(after[field]) !== fileIdentity[index])) {
          throw Error("Input changed during the FFmpeg readability decision");
        }
        return resolve({ readable: code === 0, exitCode: code,
          diagnostic: privateDiagnostic(args, diagnostic), fileIdentity });
      } catch (error) { return reject(error); }
    });
  });
}

async function probeWorkingFile(file, previous, ffprobe = "ffprobe") {
  const metadata = await new Promise((resolve, reject) => {
    const child = spawn(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 60000);
    child.stdout.on("data", (data) => {
      output += data.toString();
      if (Buffer.byteLength(output) > 4194304) stop();
    });
    // Warnings do not invalidate readable streams. Drain without retaining
    // unbounded diagnostics; exit status, JSON and the deadline own admission.
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error("Working media probe could not start")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) return reject(probeFailure(
        `Media could not be read by FFprobe (${failed ? "deadline/output bound" : `exit ${code}`}); original retained`,
        failed ? "MEDIA_PROBE_BOUND" : "MEDIA_PROBE_UNREADABLE",
        { status: failed ? "bounded-probe-incomplete" : "unreadable", exitCode: code }));
      try { return resolve(JSON.parse(output)); }
      catch { return reject(new Error("Working media probe returned invalid metadata")); }
    });
  });
  if (!Array.isArray(metadata.streams) || metadata.streams.length === 0) {
    throw probeFailure("FFprobe found no readable media streams; original retained",
      "MEDIA_PROBE_UNREADABLE", { status: "no-streams", metadata });
  }
  const stat = await fs.stat(file);
  return { ...previous, _id: file, file, container: path.extname(file).slice(1),
    file_size: stat.size / (1024 * 1024), ffProbeData: metadata,
    meta: { ...previous.meta, Directory: path.dirname(file) } };
}

function requireCliSuccess(result, cancelled, label) {
  if (cancelled || result.cliExitCode === null) {
    const error = new Error("Media processing cancelled");
    error.code = "PIPELINE_CANCELLED";
    throw error;
  }
  if (result.cliExitCode !== 0) throw new Error(`${label} failed; original package retained`);
}

function createMediaRuntime(pluginRoot, tools = mediaTools({})) {
  const helpers = path.resolve(pluginRoot, "../../../../FlowHelpers/1.0.0");
  const { CLI } = require(path.join(helpers, "cliUtils"));
  const { getPluginWorkDir } = require(path.join(helpers, "fileUtils"));
  const { getEncoder } = require(path.join(helpers, "hardwareUtils"));
  return {
    probe: (file, previous) => probeWorkingFile(file, previous, tools.ffprobe),
    readableInput,
    verifyFinish: (args, settings) => verifyFinish(args, settings, getPluginWorkDir(args), tools),
    async verifyPreparation(args, settings) {
      try {
        const proof = await verifyPreparationEvidence(args, getPluginWorkDir(args));
        retainPreparationIntent(args, settings, getPluginWorkDir(args));
        return proof;
      } catch (error) {
        error.code = "MEDIA_PREPARATION_HELD";
        error.preserveMediaEvidence = true;
        throw error;
      }
    },
    async verifyVideo(args, output, settings, sidecars, encoder) {
      try {
        const receipt = await verifyVideoInWorker({ sourceFile: args.inputFileObj._id, candidateFile: output._id,
          directory: getPluginWorkDir(args), settings: { videoPreset: settings.videoPreset, videoQuality: settings.videoQuality },
          sidecars, encoder: encoder ? { encoder: encoder.encoder, outputArgs: encoder.outputArgs || [] } : null,
          ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe },
        { onProgress: () => args.jobLog("Final video verification is still running; original remains unchanged.") });
        args.variables.mediaPipelineVideo = [...(args.variables.mediaPipelineVideo || []), receipt];
        if (receipt.status !== "pass") throw Error(`Video stage held: ${receipt.errors.slice(0, 3).join("; ")}`);
        return receipt.output.file === output._id ? output : await probeWorkingFile(receipt.output.file, output, tools.ffprobe);
      } catch (error) {
        error.code = "MEDIA_VIDEO_HELD";
        error.preserveMediaEvidence = true;
        throw error;
      }
    },
    async auditRecovery(args, evidence, repaired) {
      const result = await runTerminalWorker(args, {
        fileObjects: { inputFileObj: repaired, originalLibraryFile: args.originalLibraryFile },
        stagingRoot: args.librarySettings.folder, completedRoot: args.inputs.outputDirectory,
        stateRoot: args.inputs.namingStateDirectory, workRoot: getPluginWorkDir(args), inputRecovery: evidence,
      }, "repairAudit");
      if (result.audited !== true) throw Error("Input repair audit was not retained");
      args.variables = { ...args.variables, gpuNormalizeAudioInputRecovery: result };
    },
    async encoder(args) {
      const value = await getEncoder({ targetCodec: "hevc", hardwareEncoding: true, hardwareType: "nvenc", args });
      if (value.encoder !== "hevc_nvenc" || value.isGpu !== true) {
        throw new Error("Configured NVENC video encoder is unavailable");
      }
      return value;
    },
    async extractSubtitle(args, stream, target) {
      const temporary = path.join(path.dirname(target), `.subtitle-${randomUUID()}.srt`);
      try {
        const cli = new CLI({ cli: mediaTools(args).ffmpeg,
          spawnArgs: ["-nostdin", "-n", "-copyts", "-i", args.inputFileObj._id, "-map", stream, "-c:s", "srt", temporary],
          spawnOpts: {}, jobLog: args.logFullCliOutput ? args.jobLog : () => {},
          outputFilePath: temporary, inputFileObj: args.inputFileObj,
          logFullCliOutput: args.logFullCliOutput, updateWorker: args.updateWorker, args });
        const result = await cli.runCli();
        requireCliSuccess(result, cli.cancelled, "Subtitle extraction");
        await fs.link(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    async execute(args, { label, container, inputs, outputs, extraOutputs = [] }) {
      const directory = path.join(getPluginWorkDir(args), `media-${randomUUID()}`);
      await fs.mkdir(directory, { recursive: true });
      const original = args.originalLibraryFile._id;
      const output = path.join(directory, `${path.basename(original, path.extname(original))}.${container}`);
      const activeTools = mediaTools(args);
      let execInputs = inputs, execOutputs = outputs, sourceMedia = null, chapterMetaPath = null;
      if (container === "mp4" && inputs[0] === "-i" && typeof inputs[1] === "string") {
        sourceMedia = inspectMedia(inputs[1], activeTools.ffprobe);
        const chapterMeta = buildMp4LeadingChapterMetadata(sourceMedia);
        if (chapterMeta) {
          chapterMetaPath = path.join(directory, `.chapters-${randomUUID()}.ffmeta`);
          await fs.writeFile(chapterMetaPath, chapterMeta, { mode: 0o600 });
          ({ inputs: execInputs, outputs: execOutputs } = wireMp4ChapterMetadataInput(inputs, outputs, chapterMetaPath));
        }
      }
      try {
        const spawnArgs = ["-nostdin", "-n", ...execInputs, ...execOutputs, output, ...extraOutputs];
        args.jobLog(label);
        const cli = new CLI({ cli: activeTools.ffmpeg, spawnArgs, spawnOpts: {},
          jobLog: args.logFullCliOutput ? args.jobLog : () => {}, outputFilePath: output,
          inputFileObj: args.inputFileObj, logFullCliOutput: args.logFullCliOutput,
          updateWorker: args.updateWorker, args });
        const result = await cli.runCli();
        requireCliSuccess(result, cli.cancelled, label);
        if (sourceMedia) ensureMp4Av1DoviBoxes(sourceMedia.streams, output);
      } finally {
        if (chapterMetaPath) await fs.rm(chapterMetaPath, { force: true });
      }
      args.logOutcome("tSuc");
      return await probeWorkingFile(output, args.inputFileObj, activeTools.ffprobe);
    },
    async replace(args) {
      try {
        const result = await runTerminalWorker(args, {
          fileObjects: { inputFileObj: args.inputFileObj, originalLibraryFile: args.originalLibraryFile },
          stagingRoot: args.librarySettings.folder, completedRoot: args.inputs.outputDirectory,
          stateRoot: args.inputs.namingStateDirectory, ...tools,
          integrity: retainedReceipt(args.variables.mediaPipelineIntegrity), retainOriginal: true,
        }, "replacement");
        if (!result.replacement || typeof result.output !== "string") throw Error("Invalid retained replacement result");
        args.variables.mediaPipelineReplacement = result.replacement;
        return await probeWorkingFile(result.output, args.inputFileObj, tools.ffprobe);
      } catch (error) {
        error.code = "MEDIA_REPLACEMENT_HELD";
        error.preserveMediaEvidence = true;
        throw error;
      }
    },
  };
}

module.exports = { createMediaRuntime, probeWorkingFile, readableInput };
