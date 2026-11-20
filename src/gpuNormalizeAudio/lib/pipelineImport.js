"use strict";

const path = require("node:path");
const { recoverPublishedFile } = require("./publishedImportRecovery");

async function getId(args, app, host, headers, title) {
  const imdb = /\b(tt|nm|co|ev|ch|ni)\d{7,10}\b/i.exec(title)?.[0] || "";
  const entity = app === "radarr" ? "movie" : "series";
  if (imdb) {
    const response = await args.deps.axios({ method: "get", headers, timeout: 15000, maxContentLength: 4194304,
      url: `${host}/api/v3/${entity}/lookup?term=imdb:${imdb}` });
    const id = Number(response.data?.[0]?.id ?? -1);
    if (id !== -1) return id;
  }
  const response = await args.deps.axios({ method: "get", headers, timeout: 15000, maxContentLength: 4194304,
      url: `${host}/api/v3/parse?title=${encodeURIComponent(title)}` });
  return Number(response.data?.[entity]?.id ?? -1);
}

async function notifyPublishedPackage(args) {
  const app = String(args.inputs.arr);
  if (!["radarr", "sonarr"].includes(app)) throw new Error("Unsupported Arr application");
  const host = String(args.inputs.arr_host).trim().replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", "X-Api-Key": String(args.inputs.arr_api_key), Accept: "application/json" };
  const original = args.originalLibraryFile?._id || "";
  const current = args.inputFileObj?._id || "";
  try {
    // The verified release name owns title/year. Real media basenames can be
    // arbitrary (and omit both); do not strip a release's last dotted token.
    const titles = [args.variables?.gpuNormalizeAudioNaming?.publishedName,
      path.basename(original, path.extname(original)), path.basename(current, path.extname(current))];
    let id = -1;
    for (const title of new Set(titles.filter(value => typeof value === "string" && value))) {
      id = await getId(args, app, host, headers, title);
      if (id !== -1) break;
    }
    let notified = id !== -1;
    if (notified) {
      await args.deps.axios({ method: "post", url: `${host}/api/v3/command`, headers, timeout: 15000, maxContentLength: 4194304,
        data: JSON.stringify(app === "radarr" ? { name: "RefreshMovie", movieIds: [id] }
          : { name: "RefreshSeries", seriesId: id }) });
      args.jobLog("Arr refresh queued.");
    }
    args.variables = { ...args.variables, gpuNormalizeAudioImport: {
      state: notified ? "refreshQueued" : "importPending", imported: false,
      retryScope: "handoff", pendingReason: notified ? "awaitingImport" : "unidentified",
    } };
    if (args.inputs.recovery_receipt_directory) {
      const result = await recoverPublishedFile({ application: app, host,
        "apiKey": String(args.inputs.arr_api_key), file: current,
        receiptDirectory: String(args.inputs.recovery_receipt_directory),
        publicationDirectory: String(args.inputs.namingStateDirectory),
        ...(args.variables.gpuNormalizeAudioNaming?.publicationPlan
          ? { publicationPlan: args.variables.gpuNormalizeAudioNaming.publicationPlan } : {}) });
      notified = notified || result.imported === true;
      args.variables = { ...args.variables, gpuNormalizeAudioImport: {
        ...result, state: result.imported ? "imported" : (notified ? "refreshQueued" : "importPending"),
        retryScope: "handoff",
      } };
      args.jobLog(result.imported ? "Ordinary Arr import verified." : "Arr import remains governed by normal import decisions.");
    }
    return { outputFileObj: args.inputFileObj, outputNumber: notified ? 1 : 2, variables: args.variables };
  } catch {
    args.variables = { ...args.variables, gpuNormalizeAudioImport: {
      state: "importPending", imported: false, pendingReason: "notificationFailed", retryScope: "handoff",
    } };
    args.jobLog("Package published; Arr handoff remains pending. Retry the handoff from publication evidence.");
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }
}

module.exports = { notifyPublishedPackage };
