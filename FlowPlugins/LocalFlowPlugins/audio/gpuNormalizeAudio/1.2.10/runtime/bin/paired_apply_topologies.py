import time


class PairedApplyTopologyExecutor:
    def __init__(self, plan, supervisor, fd_plumbing, *, now_ns, emit_profile):
        self.plan = plan
        self.supervisor = supervisor
        self.fd_plumbing = fd_plumbing
        self.now_ns = now_ns
        self.emit_profile = emit_profile

    def start_pipe_sizers(self):
        return [self.supervisor.start_shell(f'pipe_sizer_{idx}', command) for idx, command in enumerate(self.plan.get('pipeSizerCommands') or [])]

    def start_direct_mux(self):
        direct_mux = self.plan.get('directMux') or {}
        if not direct_mux.get('enabled'):
            return None, None
        start_ns = self.now_ns()
        command, pass_fds = self.fd_plumbing.prepare_direct_mux_command(direct_mux['command'])
        return start_ns, self.supervisor.start_shell('direct_mux', command, stderr_path=direct_mux['errPath'], pass_fds=pass_fds)

    def start_decode_relays(self):
        decode_relay = self.plan.get('decodeRelay') or {}
        if not decode_relay.get('enabled'):
            return {}
        return {
            'fallback': self.supervisor.start_shell('fallback_relay', decode_relay['fallback']['command'], stderr_path=decode_relay['fallback']['errPath']),
            'original': self.supervisor.start_shell('original_relay', decode_relay['original']['command'], stderr_path=decode_relay['original']['errPath']),
        }

    def start_runtime(self, key):
        runtime = self.plan['runtimes'][key]
        start_ns = self.now_ns()
        command, pass_fds, parent_fds = self.fd_plumbing.prepare_runtime_command(key, runtime['command'])
        managed = self.supervisor.start_shell(
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
        ffmpeg_code = self.supervisor.run_foreground('dual_decode', self.plan['dualDecodeCommand'])
        self.emit_profile('paired_apply_shell_dual_decode', dual_decode_start_ns, exit_code=ffmpeg_code)
        if ffmpeg_code != 0:
            self.supervisor.terminate_process(runtime_proc)
            if direct_mux_proc is not None:
                self.supervisor.terminate_process(direct_mux_proc)
            self.supervisor.wait_silent(runtime_proc)
            if direct_mux_proc is not None:
                self.supervisor.wait_silent(direct_mux_proc)
            return ffmpeg_code

        runtime_wait_start_ns = self.now_ns()
        runtime_code = runtime_proc.wait()
        self.emit_profile('paired_apply_shell_runtime', runtime_start_ns, exit_code=runtime_code)
        self.emit_profile('paired_apply_shell_wait_runtime', runtime_wait_start_ns, exit_code=runtime_code)

        mux_code = None
        if direct_mux_proc is not None:
            direct_mux_wait_start_ns = self.now_ns()
            if runtime_code != 0:
                self.supervisor.terminate_process(direct_mux_proc)
                self.supervisor.wait_silent(direct_mux_proc)
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
        ffmpeg_code = self.supervisor.run_foreground('dual_decode', self.plan['dualDecodeCommand'])
        self.emit_profile('paired_apply_shell_dual_decode', dual_decode_start_ns, exit_code=ffmpeg_code)
        if ffmpeg_code != 0:
            for _, proc in runtimes.values():
                self.supervisor.terminate_process(proc)
            for proc in relays.values():
                self.supervisor.terminate_process(proc)
            for _, proc in runtimes.values():
                self.supervisor.wait_silent(proc)
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
                self.supervisor.terminate_process(direct_mux_proc)
                self.supervisor.wait_silent(direct_mux_proc)
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
        return self.run_single() if self.plan.get('singleRuntime') else self.run_dual()
