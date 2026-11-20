"use strict";

const details = () => ({
  name: "Media Pipeline Helper",
  description: "Explicit prepare/finish stages around GPU Normalize Audio. Owns media admission, repair, video/subtitles, publication, application handoff and acknowledged audited download rejection.",
  style: { borderColor: "#a78bfa" }, tags: "video,media,prepare,publish,helper",
  isStartPlugin: false, pType: "", requiresVersion: "2.31.01", sidebarPosition: -1, icon: "faCogs",
  inputs: [
    { label: "Phase", name: "phase", type: "string", defaultValue: "prepare", inputUI: { type: "dropdown", options: ["prepare", "finish"] }, tooltip: "Use prepare before GPU Normalize Audio and finish after both its outputs. Connect prepare output3 directly to finish to resume a verified finished checkpoint." },
    { label: "Minimum File Size (MB)", name: "minFileSizeMB", type: "string", defaultValue: "0", inputUI: { type: "text" }, tooltip: "Prepare: inclusive original input size in decimal MB. 0 disables this bound. Rejection records evidence and confirms native downloader failure before cleanup." },
    { label: "Maximum File Size (MB)", name: "maxFileSizeMB", type: "string", defaultValue: "50000", inputUI: { type: "text" }, tooltip: "Prepare: inclusive maximum original input size in decimal MB. 0 disables this bound." },
    { label: "Keep Audio and Subtitle Languages", name: "keepLanguages", type: "string", defaultValue: "eng,und", inputUI: { type: "text" }, tooltip: "Prepare: comma-separated language codes kept during cleanup. Audio normalization has a separate explicit language selection in GPU Normalize Audio." },
    { label: "Remove Commentary Tracks", name: "removeCommentary", type: "boolean", defaultValue: true, inputUI: { type: "switch" }, tooltip: "Prepare: remove identified commentary audio and subtitles." },
    { label: "Remove SDH Subtitles", name: "removeSdh", type: "boolean", defaultValue: false, inputUI: { type: "switch" }, tooltip: "Prepare: remove subtitles identified as subtitles for the deaf and hard of hearing." },
    { label: "Subtitle Codecs to Remove", name: "removeSubtitleCodecs", type: "string", defaultValue: "hdmv_pgs_subtitle,dvd_subtitle,dvb_subtitle,eia_608,timed_id3,pgs,vobsub", inputUI: { type: "text" }, tooltip: "Prepare: comma-separated codec names. Empty keeps all codecs permitted by the other cleanup settings." },
    { label: "Companion Subtitle Languages", name: "sidecarLanguages", type: "string", defaultValue: "eng", inputUI: { type: "text" }, tooltip: "Finish: comma-separated languages selected from companion SRT files." },
    { label: "Companion Subtitle Default Language", name: "sidecarDefaultLanguage", type: "string", defaultValue: "eng", inputUI: { type: "text" }, tooltip: "Finish: language assigned to untagged companion subtitles." },
    { label: "Include Forced Companion Subtitles", name: "sidecarIncludeForced", type: "boolean", defaultValue: true, inputUI: { type: "switch" }, tooltip: "Finish: include matching forced companion subtitles." },
    { label: "Include Untagged Companion Subtitles", name: "sidecarIncludeUntagged", type: "boolean", defaultValue: true, inputUI: { type: "switch" }, tooltip: "Finish: include untagged companion subtitles using the configured default language." },
    { label: "HEVC Video Preset", name: "videoPreset", type: "string", defaultValue: "p5", inputUI: { type: "dropdown", options: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] }, tooltip: "Finish: NVENC preset p1–p7. Already-HEVC video is copied." },
    { label: "HEVC Video Quality (QP)", name: "videoQuality", type: "string", defaultValue: "25", inputUI: { type: "text" }, tooltip: "Finish: integer0–51; lower values retain more quality. Applies only when video encoding is required." },
    { label: "Max Concurrent CPU Tasks", name: "maxConcurrentCpuJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Shared CPU slots for preparation, probes, copy muxing and publication. 0 disables the guard. No CPU slot is held while the next audio node runs or downloader ACK is awaited." },
    { label: "Max Concurrent GPU Tasks", name: "maxConcurrentJobs", type: "string", defaultValue: "1", inputUI: { type: "text" }, tooltip: "Shared GPU limit with GPU Normalize Audio. Finish uses GPU slots only for NVENC video encoding. 0 disables the guard." },
    { label: "Debug Logging", name: "debugLogging", type: "boolean", defaultValue: false, inputUI: { type: "switch" }, tooltip: "Default off. Enables full successful helper FFmpeg output." },
    { label: "FFprobe Executable", name: "ffprobePath", type: "string", defaultValue: "", inputUI: { type: "text" }, tooltip: "Optional individual executable path. Empty uses FFPROBE or ffprobe from PATH; FFmpeg comes from the actual Tdarr worker configuration. No host-specific binary directory is assumed." },
    { label: "Completed Directory", name: "outputDirectory", type: "string", defaultValue: "", inputUI: { type: "directory" }, tooltip: "Required: same completed root on both helper nodes. Publication preserves package ownership and byte identity." },
    { label: "Decision and Publication State Directory", name: "namingStateDirectory", type: "string", defaultValue: "", inputUI: { type: "directory" }, tooltip: "Required: same existing private persistent directory on both helper nodes. Stores immutable identity/hash/media/decision/ACK/cleanup evidence outside packages." },
    { label: "Arr Application", name: "arr", type: "string", defaultValue: "radarr", inputUI: { type: "dropdown", options: ["radarr", "sonarr"] }, tooltip: "Finish: application receiving the published package." },
    { label: "Arr Host", name: "arr_host", type: "string", defaultValue: "", inputUI: { type: "text" }, tooltip: "Finish: existing application API origin." },
    { label: "Arr API Key", name: "arr_api_key", type: "string", defaultValue: "", inputUI: { type: "text" }, tooltip: "Finish only: existing credential. Kept node-local, never included in the prepare/audio continuation or logs." },
    { label: "Import Receipt Directory", name: "recovery_receipt_directory", type: "string", defaultValue: "", inputUI: { type: "directory" }, tooltip: "Finish: existing private normal import receipt directory." },
  ],
  outputs: [
    { number: 1, tooltip: "Prepare: verified prepared media for the audio node. Finish: committed publication with separately recorded application-import outcome." },
    { number: 2, tooltip: "Confirmed rejection: durable decision evidence, native downloader Failed acknowledgment and owned package/Tdarr cleanup completed." },
    { number: 3, tooltip: "Prepare only: verified finished checkpoint. Connect directly to helper finish; do not normalize or encode again." },
  ],
});

module.exports = { details };
