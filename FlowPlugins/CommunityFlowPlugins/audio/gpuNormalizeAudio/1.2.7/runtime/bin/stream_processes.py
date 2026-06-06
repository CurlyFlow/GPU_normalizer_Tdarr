from __future__ import annotations

import os
import subprocess
import sys


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
    pipe_mib = os.environ.get('LOUDNORM_GPU_DECODE_PIPE_MIB')
    if pipe_mib:
        try:
            popen_kwargs['pipesize'] = max(1, int(float(pipe_mib) * 1024 * 1024))
        except ValueError:
            pass
    try:
        proc = subprocess.Popen(decode_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr, **popen_kwargs)
    except (OSError, TypeError, PermissionError):
        proc = subprocess.Popen(decode_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr)
    if proc.stdout is None:
        raise RuntimeError(f'{label} failed to open decode stdout')
    return proc, proc.stdout


def finish_decode_pass(proc, label):
    if proc is None:
        return
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f'{label} failed with exit code {code}')


def start_encode_pass(args, streaming_io, encode_command):
    if not streaming_io:
        return None, open(args.output_f32, 'wb')
    if encode_command and encode_command[0] == '__loudnorm_open_fifo_write__':
        if len(encode_command) != 2:
            raise RuntimeError('encode direct FIFO write command is invalid')
        return None, open(encode_command[1], 'wb')
    if encode_command and encode_command[0] == '__loudnorm_open_fd_write__':
        if len(encode_command) != 2:
            raise RuntimeError('encode inherited FD write command is invalid')
        try:
            fd = int(encode_command[1])
        except (TypeError, ValueError) as exc:
            raise RuntimeError('encode inherited FD write command has invalid fd') from exc
        return None, os.fdopen(fd, 'wb', buffering=0)
    popen_kwargs = {}
    pipe_mib = os.environ.get('LOUDNORM_GPU_ENCODE_PIPE_MIB')
    if pipe_mib:
        try:
            popen_kwargs['pipesize'] = max(1, int(float(pipe_mib) * 1024 * 1024))
        except ValueError:
            pass
    try:
        proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr, **popen_kwargs)
    except (OSError, TypeError, PermissionError):
        proc = subprocess.Popen(encode_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr)
    if proc.stdin is None:
        raise RuntimeError('encode failed to open stdin')
    return proc, proc.stdin


def finish_encode_pass(proc, handle):
    if proc is None:
        try:
            handle.close()
        except BrokenPipeError:
            pass
        return
    try:
        handle.close()
    except BrokenPipeError:
        pass
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f'encode failed with exit code {code}')


def close_decode_pass(proc, handle, label):
    exc_active = sys.exc_info()[0] is not None
    handle.close()
    if exc_active and proc is not None:
        proc.kill()
        proc.wait()
    else:
        finish_decode_pass(proc, label)
