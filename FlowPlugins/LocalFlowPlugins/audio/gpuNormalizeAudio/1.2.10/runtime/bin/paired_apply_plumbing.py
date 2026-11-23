import errno
import fcntl
import os
import time

from runtime_env import env_present


class PairedApplyFifoSet:
    def __init__(self, plan):
        self.plan = plan

    def cleanup_pair(self):
        for path in self.plan['fifoPaths']:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    def make_fifos(self):
        for path in self.plan['fifoPaths']:
            os.mkfifo(path)


class DirectMuxFdPlumbing:
    def __init__(self, plan):
        self.plan = plan
        self.direct_mux_pipe_writes = {}

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
        if env_present('LOUDNORM_GPU_PAIR_FALLBACK_APPLY_ORCHESTRATOR_FIFO_FD_NO_ANCHOR'):
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
