from __future__ import annotations

import errno
import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time


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


class ManagedProcess:
    def __init__(self, name, proc, handles=None, output_thread=None):
        self.name = name
        self.proc = proc
        self.handles = list(handles or [])
        self.output_thread = output_thread

    def wait(self):
        code = self.proc.wait()
        if self.output_thread is not None:
            self.output_thread.join()
        self.close()
        return code

    def close(self):
        while self.handles:
            handle = self.handles.pop()
            try:
                handle.close()
            except Exception:
                pass


class PairedApplyOrchestrator:
    def __init__(self, plan):
        self.plan = plan
        self.processes = []
        self.direct_mux_pipe_writes = {}
        self.terminated = False
        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)

    def _handle_signal(self, signum, _frame):
        self.terminated = True
        self.terminate_all()
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

    def cleanup_pair(self):
        for path in self.plan['fifoPaths']:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    def make_fifos(self):
        for path in self.plan['fifoPaths']:
            os.mkfifo(path)

    def terminate_process(self, managed):
        proc = managed.proc
        if proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass

    def terminate_all(self):
        for managed in self.processes:
            self.terminate_process(managed)

    def wait_silent(self, managed):
        try:
            return managed.wait()
        except Exception:
            return 0

    def _tee_output(self, pipe, paths, emit_stdout):
        handles = [open(path, 'ab', buffering=0) for path in paths]
        try:
            while True:
                chunk = pipe.read(65536)
                if not chunk:
                    break
                if emit_stdout:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                for handle in handles:
                    handle.write(chunk)
        finally:
            for handle in handles:
                handle.close()
            pipe.close()

    def start_shell(self, name, command, *, tee_paths=(), emit_stdout=True, stderr_path=None, pass_fds=(), parent_fds=()):
        handles = []
        stdout = None
        stderr = None
        output_thread = None
        if tee_paths:
            stdout = subprocess.PIPE
            stderr = subprocess.STDOUT
        elif stderr_path:
            stderr = open(stderr_path, 'ab', buffering=0)
            handles.append(stderr)
        try:
            proc = subprocess.Popen(
                ['/bin/bash', '-lc', command],
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
                pass_fds=tuple(pass_fds),
            )
        finally:
            for fd in tuple(pass_fds) + tuple(parent_fds):
                if fd is None:
                    continue
                try:
                    os.close(fd)
                except OSError:
                    pass
        if tee_paths:
            output_thread = threading.Thread(target=self._tee_output, args=(proc.stdout, tee_paths, emit_stdout), daemon=True)
            output_thread.start()
        managed = ManagedProcess(name, proc, handles=handles, output_thread=output_thread)
        self.processes.append(managed)
        return managed

    def close_direct_mux_pipe_writes(self):
        for fd, _token in list(self.direct_mux_pipe_writes.values()):
            try:
                os.close(fd)
            except OSError:
                pass
        self.direct_mux_pipe_writes.clear()

    def prepare_direct_mux_command(self, command):
        pipe_fds = ((self.plan.get('directMux') or {}).get('pipeFds') or {})
        if not pipe_fds:
            return command, ()
        if self.direct_mux_pipe_writes:
            raise RuntimeError('direct mux OS pipe writers are already prepared')
        pass_fds = []
        try:
            for key, pipe_spec in pipe_fds.items():
                read_fd, write_fd = os.pipe()
                read_token = pipe_spec['readToken']
                write_token = pipe_spec['writeToken']
                if read_token not in command:
                    os.close(read_fd)
                    os.close(write_fd)
                    raise RuntimeError(f'direct mux command missing OS pipe read token for {key}')
                command = command.replace(read_token, str(read_fd))
                pass_fds.append(read_fd)
                self.direct_mux_pipe_writes[key] = (write_fd, write_token)
            return command, tuple(pass_fds)
        except BaseException:
            for fd in pass_fds:
                try:
                    os.close(fd)
                except OSError:
                    pass
            self.close_direct_mux_pipe_writes()
            raise

    def open_fifo_writer_fd(self, path):
        if os.environ.get('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORCHESTRATOR_FIFO_FD_NO_ANCHOR'):
            fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            try:
                flags = fcntl.fcntl(fd, fcntl.F_GETFL)
                fcntl.fcntl(fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
                return fd, None
            except BaseException:
                os.close(fd)
                raise
        anchor_fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        fd = None
        try:
            fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            flags = fcntl.fcntl(fd, fcntl.F_GETFL)
            fcntl.fcntl(fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
            return fd, anchor_fd
        except BaseException:
            if fd is not None:
                os.close(fd)
            os.close(anchor_fd)
            raise

    def open_fifo_writer_fd_with_retry(self, path, timeout_sec=10.0):
        deadline = time.monotonic() + timeout_sec
        while True:
            try:
                return self.open_fifo_writer_fd(path)
            except OSError as exc:
                if exc.errno != errno.ENXIO or time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)

    def prepare_runtime_command(self, key, command):
        pipe_write = self.direct_mux_pipe_writes.pop(key, None)
        if pipe_write is not None:
            fd, token = pipe_write
            if token not in command:
                os.close(fd)
                raise RuntimeError(f'{key} runtime command missing inherited OS pipe fd token')
            return command.replace(token, str(fd)), (fd,), ()
        fd_write = ((self.plan.get('directMux') or {}).get('fdWrites') or {}).get(key)
        if not fd_write:
            return command, (), ()
        fd, anchor_fd = self.open_fifo_writer_fd_with_retry(fd_write['path'])
        token = fd_write['token']
        if token not in command:
            os.close(fd)
            os.close(anchor_fd)
            raise RuntimeError(f'{key} runtime command missing inherited FIFO fd token')
        return command.replace(token, str(fd)), (fd,), (anchor_fd,)

    def run_foreground(self, name, command):
        managed = self.start_shell(name, command)
        return managed.wait()

    def start_pipe_sizers(self):
        return [self.start_shell(f'pipe_sizer_{idx}', command) for idx, command in enumerate(self.plan.get('pipeSizerCommands') or [])]

    def start_direct_mux(self):
        direct_mux = self.plan.get('directMux') or {}
        if not direct_mux.get('enabled'):
            return None, None
        start_ns = self.now_ns()
        command, pass_fds = self.prepare_direct_mux_command(direct_mux['command'])
        return start_ns, self.start_shell('direct_mux', command, stderr_path=direct_mux['errPath'], pass_fds=pass_fds)

    def start_decode_relays(self):
        decode_relay = self.plan.get('decodeRelay') or {}
        if not decode_relay.get('enabled'):
            return {}
        return {
            'fallback': self.start_shell('fallback_relay', decode_relay['fallback']['command'], stderr_path=decode_relay['fallback']['errPath']),
            'original': self.start_shell('original_relay', decode_relay['original']['command'], stderr_path=decode_relay['original']['errPath']),
        }

    def start_runtime(self, key):
        runtime = self.plan['runtimes'][key]
        start_ns = self.now_ns()
        command, pass_fds, parent_fds = self.prepare_runtime_command(key, runtime['command'])
        managed = self.start_shell(
            f'{key}_runtime',
            command,
            tee_paths=runtime.get('teePaths') or [],
            emit_stdout=runtime.get('emitStdout', True),
            pass_fds=pass_fds,
            parent_fds=parent_fds,
        )
        return start_ns, managed

    def run_single(self):
        self.start_pipe_sizers()
        direct_mux_start_ns, direct_mux_proc = self.start_direct_mux()
        runtime_start_ns, runtime_proc = self.start_runtime('single')
        dual_decode_start_ns = self.now_ns()
        ffmpeg_code = self.run_foreground('dual_decode', self.plan['dualDecodeCommand'])
        self.emit_profile('paired_apply_shell_dual_decode', dual_decode_start_ns, exit_code=ffmpeg_code)
        if ffmpeg_code != 0:
            self.terminate_process(runtime_proc)
            if direct_mux_proc is not None:
                self.terminate_process(direct_mux_proc)
            self.wait_silent(runtime_proc)
            if direct_mux_proc is not None:
                self.wait_silent(direct_mux_proc)
            return ffmpeg_code

        runtime_wait_start_ns = self.now_ns()
        runtime_code = runtime_proc.wait()
        self.emit_profile('paired_apply_shell_runtime', runtime_start_ns, exit_code=runtime_code)
        self.emit_profile('paired_apply_shell_wait_runtime', runtime_wait_start_ns, exit_code=runtime_code)

        mux_code = None
        if direct_mux_proc is not None:
            direct_mux_wait_start_ns = self.now_ns()
            if runtime_code != 0:
                self.terminate_process(direct_mux_proc)
                self.wait_silent(direct_mux_proc)
                mux_code = 0
            else:
                mux_code = direct_mux_proc.wait()
            self.emit_profile('paired_apply_shell_direct_mux', direct_mux_start_ns, exit_code=mux_code)
            self.emit_profile('paired_apply_shell_wait_direct_mux', direct_mux_wait_start_ns, exit_code=mux_code)

        total_code = mux_code if mux_code is not None else runtime_code
        self.emit_profile('paired_apply_shell_total', self.plan['profileStartNs'], exit_code=total_code)
        if runtime_code != 0:
            return runtime_code
        if mux_code not in (None, 0):
            return mux_code
        return 0

    def start_dual_runtimes(self):
        runtimes = {}
        for entry in self.plan['runtimeOrder']:
            if 'sleepMs' in entry:
                time.sleep(entry['sleepMs'] / 1000)
                continue
            key = entry['runtime']
            runtimes[key] = self.start_runtime(key)
        return runtimes

    def run_dual(self):
        self.start_pipe_sizers()
        direct_mux_start_ns, direct_mux_proc = self.start_direct_mux()
        relays = self.start_decode_relays()
        runtimes = self.start_dual_runtimes()

        dual_decode_start_ns = self.now_ns()
        ffmpeg_code = self.run_foreground('dual_decode', self.plan['dualDecodeCommand'])
        self.emit_profile('paired_apply_shell_dual_decode', dual_decode_start_ns, exit_code=ffmpeg_code)
        if ffmpeg_code != 0:
            for _, proc in runtimes.values():
                self.terminate_process(proc)
            for proc in relays.values():
                self.terminate_process(proc)
            for _, proc in runtimes.values():
                self.wait_silent(proc)
            return ffmpeg_code

        fallback_start_ns, fallback_proc = runtimes['fallback']
        original_start_ns, original_proc = runtimes['original']
        fallback_wait_start_ns = self.now_ns()
        fallback_code = fallback_proc.wait()
        self.emit_profile('paired_apply_shell_runtime_fallback', fallback_start_ns, exit_code=fallback_code)
        self.emit_profile('paired_apply_shell_wait_fallback', fallback_wait_start_ns, exit_code=fallback_code)
        original_wait_start_ns = self.now_ns()
        original_code = original_proc.wait()
        self.emit_profile('paired_apply_shell_runtime_original', original_start_ns, exit_code=original_code)
        self.emit_profile('paired_apply_shell_wait_original', original_wait_start_ns, exit_code=original_code)

        fallback_relay_code = relays['fallback'].wait() if 'fallback' in relays else 0
        original_relay_code = relays['original'].wait() if 'original' in relays else 0

        mux_code = 0
        if direct_mux_proc is not None:
            direct_mux_wait_start_ns = self.now_ns()
            if fallback_code != 0 or original_code != 0:
                self.terminate_process(direct_mux_proc)
                self.wait_silent(direct_mux_proc)
            else:
                mux_code = direct_mux_proc.wait()
            self.emit_profile('paired_apply_shell_direct_mux', direct_mux_start_ns, exit_code=mux_code)
            self.emit_profile('paired_apply_shell_wait_direct_mux', direct_mux_wait_start_ns, exit_code=mux_code)

        self.emit_profile('paired_apply_shell_total', self.plan['profileStartNs'], exit_code=mux_code)
        for code in (fallback_code, original_code, fallback_relay_code, original_relay_code, mux_code):
            if code != 0:
                return code
        return 0

    def run(self):
        self.plan['profileStartNs'] = self.now_ns()
        try:
            self.cleanup_pair()
            mkfifo_start_ns = self.now_ns()
            self.make_fifos()
            self.emit_profile('paired_apply_shell_mkfifo', mkfifo_start_ns, exit_code=0)
            return self.run_single() if self.plan.get('singleRuntime') else self.run_dual()
        finally:
            self.close_direct_mux_pipe_writes()
            self.terminate_all()
            for managed in self.processes:
                if managed.proc.poll() is None:
                    self.wait_silent(managed)
                else:
                    managed.close()
            self.cleanup_pair()


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
