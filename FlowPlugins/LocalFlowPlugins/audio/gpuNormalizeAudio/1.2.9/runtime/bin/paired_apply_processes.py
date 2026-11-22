import os
import signal
import subprocess
import sys
import threading


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


class PairedApplyProcessSupervisor:
    def __init__(self):
        self.processes = []

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

    def run_foreground(self, name, command):
        managed = self.start_shell(name, command)
        return managed.wait()

    def close_all(self):
        for managed in self.processes:
            if managed.proc.poll() is None:
                self.wait_silent(managed)
            else:
                managed.close()
