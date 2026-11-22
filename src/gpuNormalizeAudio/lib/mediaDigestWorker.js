"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { fileDigest } = require("./mediaDigestCore");

if (parentPort && workerData?.file) {
  parentPort.postMessage(fileDigest(workerData.file));
}
