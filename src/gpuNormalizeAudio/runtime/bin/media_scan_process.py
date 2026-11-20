"""Bounded, fail-closed transport for plugin media evidence processes."""

import os
import selectors
import signal
import subprocess
import time


_outer_process_group = None


def adopt_process_group():
    """Keep scans inside the detached group owned by the terminal launcher."""
    global _outer_process_group
    if os.getpgrp() != os.getpid() or os.getsid(0) != os.getpid():
        raise ValueError('A terminal-owned session leader is required')
    _outer_process_group = os.getpid()


def validate_probe_diagnostics(diagnostics, streams):
    """Only tolerate FFprobe's missing decoder warning for declared bin_data.

    AV_CODEC_ID_BIN_DATA (98314) describes opaque data, not damaged A/V.
    Match both the exact message and the stream index from this input's probe.
    """
    allowed = {f"Unsupported codec with id 98314 for input stream {stream['index']}"
               for stream in streams if stream.get('codec_type') == 'data'
               and stream.get('codec_name') == 'bin_data'
               and type(stream.get('index')) is int and stream['index'] >= 0}
    if any(line not in allowed for line in diagnostics.decode('utf-8').splitlines()):
        raise ValueError('Media scanner reported unverified diagnostics; evidence is incomplete')


def evidence_chunks(file, command, timeout, *, diagnostics=None):
    own_session = _outer_process_group is None
    if not own_session and os.getpgrp() != _outer_process_group:
        raise ValueError('Terminal process-group ownership changed')
    before = os.stat(file, follow_symlinks=False)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size,
                              value.st_mtime_ns, value.st_ctime_ns)
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=own_session)
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, 'evidence')
            selector.register(child.stderr, selectors.EVENT_READ, 'errors')
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Media evidence scan exceeded its deadline')
                for key, _ in selector.select(min(remaining, 1)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    elif key.data == 'errors':
                        if diagnostics is None:
                            raise ValueError('Media scanner reported diagnostics; evidence is incomplete')
                        diagnostics.extend(chunk)
                        if len(diagnostics) > 65536:
                            raise ValueError('Media scan diagnostics exceed the evidence bound')
                    else:
                        yield chunk
        if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            raise ValueError('Media evidence process failed')
        if identity(before) != identity(os.stat(file, follow_symlinks=False)):
            raise ValueError('Media changed during evidence scan')
    finally:
        if child.poll() is None:
            try:
                if own_session:
                    os.killpg(child.pid, signal.SIGKILL)
                else:
                    child.kill()
            except ProcessLookupError:
                pass
        child.wait()
        child.stdout.close()
        child.stderr.close()
