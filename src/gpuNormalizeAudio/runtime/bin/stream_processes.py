import os
import subprocess
import sys
import time

from runtime_env import env_optional_bytes_mib


class NullEncodeSink:
    loudnorm_null_write = True

    def write(self, data):
        return len(data)

    def close(self):
        return None


def start_decode_pass(args, streaming_io, decode_command, label):
    if not streaming_io:
        return None, open(args.input_f32, 'rb')
    if decode_command and decode_command[0] == '__loudnorm_open_fifo__':
        if len(decode_command) != 2:
            raise RuntimeError(f'{label} direct FIFO decode command is invalid')
        return None, open(decode_command[1], 'rb', buffering=0)
    if decode_command and decode_command[0] == '__loudnorm_stdin__':
        if len(decode_command) != 1:
            raise RuntimeError(f'{label} stdin decode command is invalid')
        return None, sys.stdin.buffer
    popen_kwargs = {}
    pipesize = env_optional_bytes_mib('LOUDNORM_GPU_DECODE_PIPE_MIB')
    if pipesize is not None:
        popen_kwargs['pipesize'] = pipesize
    try:
        proc = subprocess.Popen(decode_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr, **popen_kwargs)
    except (OSError, TypeError, PermissionError):
        proc = subprocess.Popen(decode_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr)
    if proc.stdout is None:
        raise RuntimeError(f'{label} failed to open decode stdout')
    return proc, proc.stdout


def finish_decode_pass(proc, label):
    if proc is None:
        return 0.0
    wait_t0 = time.perf_counter()
    code = proc.wait()
    wait_time = time.perf_counter() - wait_t0
    if code != 0:
        raise RuntimeError(f'{label} failed with exit code {code}')
    return wait_time


def start_encode_pass(args, streaming_io, encode_command):
    if not streaming_io:
        return None, open(args.output_f32, 'wb')
    if encode_command and encode_command[0] == '__loudnorm_open_fifo_write__':
        if len(encode_command) != 2:
            raise RuntimeError('encode direct FIFO write command is invalid')
        return None, open(encode_command[1], 'wb')
    if encode_command and encode_command[0] == '__loudnorm_open_fd_write__':
        if len(encode_command) not in (2, 3):
            raise RuntimeError('encode inherited FD write command is invalid')
        try:
            fd = int(encode_command[1])
        except (TypeError, ValueError) as exc:
            raise RuntimeError('encode inherited FD write command has invalid fd') from exc
        if len(encode_command) == 3:
            return None, encode_command[2].open_write_fd(fd)
        return None, os.fdopen(fd, 'wb', buffering=0)
    if encode_command and encode_command[0] == '__loudnorm_null_write__':
        if len(encode_command) != 1:
            raise RuntimeError('encode null write command is invalid')
        return None, NullEncodeSink()
    popen_kwargs = {}
    pipesize = env_optional_bytes_mib('LOUDNORM_GPU_ENCODE_PIPE_MIB')
    if pipesize is not None:
        popen_kwargs['pipesize'] = pipesize
    try:
        proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr, **popen_kwargs)
    except (OSError, TypeError, PermissionError):
        proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr)
    if proc.stdin is None:
        raise RuntimeError('encode failed to open stdin')
    return proc, proc.stdin


def finish_encode_pass(proc, handle):
    close_time = 0.0
    if proc is None:
        close_t0 = time.perf_counter()
        try:
            handle.close()
        except BrokenPipeError:
            pass
        finally:
            close_time = time.perf_counter() - close_t0
        return close_time, 0.0
    close_t0 = time.perf_counter()
    try:
        handle.close()
    except BrokenPipeError:
        pass
    finally:
        close_time = time.perf_counter() - close_t0
    wait_t0 = time.perf_counter()
    code = proc.wait()
    wait_time = time.perf_counter() - wait_t0
    if code != 0:
        raise RuntimeError(f'encode failed with exit code {code}')
    return close_time, wait_time


def close_decode_pass(proc, handle, label):
    exc_active = sys.exc_info()[0] is not None
    handle.close()
    if exc_active and proc is not None:
        proc.kill()
        proc.wait()
    else:
        finish_decode_pass(proc, label)
