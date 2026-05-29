"use strict";

const {
  q,
} = require("./common");

const SPLICE_RELAY_CODE = "import fcntl,os,sys\npath=sys.argv[1]\nchunk=int(sys.argv[2]) if len(sys.argv)>2 else 4194304\npipe_size=int(sys.argv[3]) if len(sys.argv)>3 else 0\nif not hasattr(os,'splice'):\n    raise SystemExit('os.splice unavailable')\nout=os.open(path, os.O_WRONLY)\ntry:\n    if pipe_size>0:\n        try:\n            fcntl.fcntl(out, 1031, pipe_size)\n        except Exception:\n            pass\n    while True:\n        try:\n            n=os.splice(0, out, chunk)\n        except InterruptedError:\n            continue\n        if n == 0:\n            break\nfinally:\n    os.close(out)\n";

const FIFO_WRITE_RELAY_CODE = "import fcntl,os,sys\nsize=int(sys.argv[1])\npath=sys.argv[2]\nchunk=int(sys.argv[3]) if len(sys.argv)>3 else 1048576\nout=os.open(path, os.O_WRONLY)\ntry:\n    if size>0:\n        try:\n            fcntl.fcntl(out, 1031, size)\n        except Exception:\n            pass\n    with os.fdopen(out, 'wb', buffering=0) as fo:\n        out=None\n        while True:\n            data=os.read(0, chunk)\n            if not data:\n                break\n            fo.write(data)\nfinally:\n    if out is not None:\n        os.close(out)\n";

const DECODE_RELAY_CODE = "import os, queue, signal, sys, threading\nlimit=max(1, int(sys.argv[1]))\nin_path=sys.argv[2]\nout_path=sys.argv[3]\nchunk=1024*1024\nslots=max(1, limit//chunk)\nq=queue.Queue(maxsize=slots)\nstop=object()\ndef writer():\n    fd=os.open(out_path, os.O_WRONLY)\n    with os.fdopen(fd, 'wb', buffering=0) as out:\n        while True:\n            item=q.get()\n            if item is stop:\n                break\n            out.write(item)\ndef term(*_):\n    os._exit(143)\nsignal.signal(signal.SIGTERM, term)\nt=threading.Thread(target=writer, daemon=True)\nt.start()\nwith open(in_path, 'rb', buffering=0) as inp:\n    while True:\n        data=inp.read(chunk)\n        if not data:\n            break\n        q.put(data)\nq.put(stop)\nt.join()\n";

const PIPE_SIZER_CODE = "import fcntl, os, signal, sys, time\nsize=int(sys.argv[1])\nfds=[]\nfor path in sys.argv[2:]:\n    try:\n        fd=os.open(path, os.O_RDONLY | os.O_NONBLOCK)\n        fcntl.fcntl(fd, 1031, size)\n        fds.append(fd)\n    except Exception:\n        pass\nsignal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\ntry:\n    while True:\n        time.sleep(60)\nfinally:\n    for fd in fds:\n        os.close(fd)\n";

function buildDirectMuxRelayCommand({ plan, pythonPath, spliceRelay, outputPipeMiB = 0 }) {
  const pipeBytes = Math.max(0, Number(outputPipeMiB) || 0) * 1024 * 1024;
  if (spliceRelay) return [String(pythonPath), "-c", SPLICE_RELAY_CODE, plan.fifoOutput, String(4 * 1024 * 1024), String(pipeBytes)];
  if (pipeBytes > 0) return [String(pythonPath), "-c", FIFO_WRITE_RELAY_CODE, String(pipeBytes), plan.fifoOutput, String(1024 * 1024)];
  return ["sh", "-lc", `cat > ${q(plan.fifoOutput)}`];
}

function buildDecodeRelayCommands({ enabled, pythonPath, relayMiB, fallbackDecodeInput, originalDecodeInput, fallbackPlan, originalPlan }) {
  if (!enabled) return { fallbackDecodeRelayCommand: "", originalDecodeRelayCommand: "" };
  const bytes = String(relayMiB * 1024 * 1024);
  return {
    fallbackDecodeRelayCommand: `${q(pythonPath)} -c ${q(DECODE_RELAY_CODE)} ${bytes} ${q(fallbackDecodeInput)} ${q(fallbackPlan.fifoInput)}`,
    originalDecodeRelayCommand: `${q(pythonPath)} -c ${q(DECODE_RELAY_CODE)} ${bytes} ${q(originalDecodeInput)} ${q(originalPlan.fifoInput)}`,
  };
}

function buildPipeSizerCommands({ pythonPath, pipeMiB, outputPipeMiB, directMuxEnabled, fallbackPlan, originalPlan, directMuxInputPlans }) {
  const pipeSizerCommands = [];
  if (pipeMiB > 0) {
    pipeSizerCommands.push(`${q(pythonPath)} -c ${q(PIPE_SIZER_CODE)} ${String(pipeMiB * 1024 * 1024)} ${[fallbackPlan.fifoInput, originalPlan.fifoInput].map(q).join(" ")}`);
  }
  // Output FIFO sizing is handled by the direct-mux relay process itself so no extra FIFO endpoint is held open.
  return pipeSizerCommands;
}

module.exports = {
  buildDecodeRelayCommands,
  buildDirectMuxRelayCommand,
  buildPipeSizerCommands,
};
