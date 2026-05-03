#!/usr/bin/env python3
from __future__ import annotations

import json
import urllib.request

API = "http://127.0.0.1:8266/api/v2"
FLOW_ID = "OPX_REAL_COMPARE_GPU_FLOW"


def post(path: str, payload: dict) -> str:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=120).read().decode()


def crud(collection: str, mode: str, doc_id: str, obj: dict | None = None):
    payload = {"data": {"collection": collection, "mode": mode, "docID": doc_id}}
    if obj is not None:
        payload["data"]["obj"] = obj
    body = post("/cruddb", payload)
    return json.loads(body) if body else None


flow = crud("FlowsJSONDB", "getById", FLOW_ID)
found = False
for plugin in flow.get("flowPlugins", []):
    if plugin.get("pluginName") == "opxGpuNormalizeExactDev":
        inputs = plugin.setdefault("inputsDB", {})
        inputs["plannerMode"] = "gpuSourcePort"
        inputs["gpuPlanCorePath"] = "/app/server/opx/bin/opx-loudnorm-gpu-source-port"
        inputs["channels"] = "6"
        inputs["sampleRate"] = "192000"
        inputs["gpuChunkMiB"] = "64"
        found = True
if not found:
    raise SystemExit("opxGpuNormalizeExactDev not found")
crud("FlowsJSONDB", "update", FLOW_ID, flow)
updated = crud("FlowsJSONDB", "getById", FLOW_ID)
for plugin in updated.get("flowPlugins", []):
    if plugin.get("pluginName") == "opxGpuNormalizeExactDev":
        print(json.dumps(plugin.get("inputsDB", {}), indent=2))
