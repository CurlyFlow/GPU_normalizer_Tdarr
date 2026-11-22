import json
import signal
import sys
import time

from paired_apply_plumbing import DirectMuxFdPlumbing, PairedApplyFifoSet
from paired_apply_processes import PairedApplyProcessSupervisor
from paired_apply_topologies import PairedApplyTopologyExecutor


PLAN_SCHEMA = 'gpuNormalizeAudio.pairedApplyPlan.v1'


def _fail(message):
    raise ValueError(f'invalid paired apply plan: {message}')


def _require(condition, message):
    if not condition:
        _fail(message)


def _require_string(value, path, *, allow_empty=False):
    _require(isinstance(value, str), f'{path} must be a string')
    if not allow_empty:
        _require(bool(value), f'{path} must not be empty')


def _require_string_list(value, path):
    _require(isinstance(value, list), f'{path} must be a list')
    for index, item in enumerate(value):
        _require_string(item, f'{path}[{index}]')


def _validate_runtime(runtime, path):
    _require(isinstance(runtime, dict), f'{path} must be an object')
    _require_string(runtime.get('command'), f'{path}.command')
    if 'emitStdout' in runtime:
        _require(isinstance(runtime['emitStdout'], bool), f'{path}.emitStdout must be a boolean')
    _require_string_list(runtime.get('teePaths') or [], f'{path}.teePaths')


def _validate_optional_shell_endpoint(value, path):
    _require(isinstance(value, dict), f'{path} must be an object')
    _require_string(value.get('command'), f'{path}.command')
    _require_string(value.get('errPath'), f'{path}.errPath')


def _validate_fd_write(value, path):
    _require(isinstance(value, dict), f'{path} must be an object')
    _require_string(value.get('path'), f'{path}.path')
    _require_string(value.get('token'), f'{path}.token')


def _validate_pipe_fd(value, path):
    _require(isinstance(value, dict), f'{path} must be an object')
    _require_string(value.get('readToken'), f'{path}.readToken')
    _require_string(value.get('writeToken'), f'{path}.writeToken')


def validate_plan(plan):
    _require(isinstance(plan, dict), 'root must be an object')
    _require(plan.get('schema') == PLAN_SCHEMA, f'schema must be {PLAN_SCHEMA}')
    _require(isinstance(plan.get('singleRuntime'), bool), 'singleRuntime must be a boolean')
    _require(isinstance(plan.get('shellProfile'), bool), 'shellProfile must be a boolean')
    _require_string(plan.get('profileFields'), 'profileFields', allow_empty=True)
    _require_string(plan.get('dualDecodeCommand'), 'dualDecodeCommand')
    _require_string_list(plan.get('fifoPaths'), 'fifoPaths')
    _require_string_list(plan.get('pipeSizerCommands') or [], 'pipeSizerCommands')

    runtimes = plan.get('runtimes')
    _require(isinstance(runtimes, dict), 'runtimes must be an object')
    if plan['singleRuntime']:
        _validate_runtime(runtimes.get('single'), 'runtimes.single')
    else:
        _validate_runtime(runtimes.get('fallback'), 'runtimes.fallback')
        _validate_runtime(runtimes.get('original'), 'runtimes.original')
        runtime_order = plan.get('runtimeOrder')
        _require(isinstance(runtime_order, list), 'runtimeOrder must be a list')
        seen = set()
        for index, entry in enumerate(runtime_order):
            _require(isinstance(entry, dict), f'runtimeOrder[{index}] must be an object')
            if 'sleepMs' in entry:
                _require(isinstance(entry['sleepMs'], int) and entry['sleepMs'] >= 0, f'runtimeOrder[{index}].sleepMs must be a non-negative integer')
                continue
            runtime = entry.get('runtime')
            _require(runtime in ('fallback', 'original'), f'runtimeOrder[{index}].runtime must be fallback or original')
            seen.add(runtime)
        _require(seen == {'fallback', 'original'}, 'runtimeOrder must include fallback and original runtimes')

    direct_mux = plan.get('directMux') or {}
    _require(isinstance(direct_mux, dict), 'directMux must be an object')
    fd_writes = direct_mux.get('fdWrites') or {}
    _require(isinstance(fd_writes, dict), 'directMux.fdWrites must be an object')
    for key, value in fd_writes.items():
        _require(key in ('fallback', 'original'), 'directMux.fdWrites keys must be fallback/original')
        _validate_fd_write(value, f'directMux.fdWrites.{key}')
    pipe_fds = direct_mux.get('pipeFds') or {}
    _require(isinstance(pipe_fds, dict), 'directMux.pipeFds must be an object')
    for key, value in pipe_fds.items():
        _require(key in ('fallback', 'original'), 'directMux.pipeFds keys must be fallback/original')
        _validate_pipe_fd(value, f'directMux.pipeFds.{key}')
    if direct_mux.get('enabled'):
        _validate_optional_shell_endpoint(direct_mux, 'directMux')

    decode_relay = plan.get('decodeRelay') or {}
    _require(isinstance(decode_relay, dict), 'decodeRelay must be an object')
    if decode_relay.get('enabled'):
        _validate_optional_shell_endpoint(decode_relay.get('fallback'), 'decodeRelay.fallback')
        _validate_optional_shell_endpoint(decode_relay.get('original'), 'decodeRelay.original')
    return plan


class PairedApplyOrchestrator:
    def __init__(self, plan):
        self.plan = plan
        self.supervisor = PairedApplyProcessSupervisor()
        self.fifo_set = PairedApplyFifoSet(plan)
        self.fd_plumbing = DirectMuxFdPlumbing(plan)
        self.topology_executor = PairedApplyTopologyExecutor(
            plan,
            self.supervisor,
            self.fd_plumbing,
            now_ns=self.now_ns,
            emit_profile=self.emit_profile,
        )
        self.terminated = False
        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)

    def _handle_signal(self, signum, _frame):
        self.terminated = True
        self.supervisor.terminate_all()
        raise SystemExit(128 + signum)

    def now_ns(self):
        return time.monotonic_ns()

    def emit_profile(self, name, start_ns, **fields):
        if not self.plan.get('shellProfile'):
            return
        elapsed = (self.now_ns() - start_ns) / 1_000_000_000
        extras = ' '.join(f'{key}={value}' for key, value in fields.items())
        print(
            f'profile_stage scope=plugin name={name} wall_sec={elapsed:.9f} '
            f'{self.plan["profileFields"]} {extras}',
            file=sys.stderr,
            flush=True,
        )

    def run(self):
        self.plan['profileStartNs'] = self.now_ns()
        try:
            self.fifo_set.cleanup_pair()
            mkfifo_start_ns = self.now_ns()
            self.fifo_set.make_fifos()
            self.emit_profile('paired_apply_shell_mkfifo', mkfifo_start_ns, exit_code=0)
            return self.topology_executor.run()
        finally:
            self.fd_plumbing.close_direct_mux_pipe_writes()
            self.supervisor.terminate_all()
            self.supervisor.close_all()
            self.fifo_set.cleanup_pair()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        raise SystemExit('usage: paired_apply_orchestrator.py <plan.json>')
    with open(argv[0], 'r', encoding='utf-8') as handle:
        plan = json.load(handle)
    validate_plan(plan)
    raise SystemExit(PairedApplyOrchestrator(plan).run())


if __name__ == '__main__':
    main()
