from __future__ import annotations

import fcntl
import os
import queue
import signal
import sys
import threading
import time


F_SETPIPE_SZ = 1031


def _set_pipe_size(fd, size):
    if size <= 0:
        return
    try:
        fcntl.fcntl(fd, F_SETPIPE_SZ, size)
    except Exception:
        pass


def splice_relay(argv):
    path = argv[0]
    chunk = int(argv[1]) if len(argv) > 1 else 4 * 1024 * 1024
    pipe_size = int(argv[2]) if len(argv) > 2 else 0
    if not hasattr(os, 'splice'):
        raise SystemExit('os.splice unavailable')
    out = os.open(path, os.O_WRONLY)
    try:
        _set_pipe_size(out, pipe_size)
        while True:
            try:
                n = os.splice(0, out, chunk)
            except InterruptedError:
                continue
            if n == 0:
                break
    finally:
        os.close(out)


def fifo_write_relay(argv):
    size = int(argv[0])
    path = argv[1]
    chunk = int(argv[2]) if len(argv) > 2 else 1024 * 1024
    out = os.open(path, os.O_WRONLY)
    try:
        _set_pipe_size(out, size)
        with os.fdopen(out, 'wb', buffering=0) as fo:
            out = None
            while True:
                data = os.read(0, chunk)
                if not data:
                    break
                fo.write(data)
    finally:
        if out is not None:
            os.close(out)


def decode_relay(argv):
    limit = max(1, int(argv[0]))
    in_path = argv[1]
    out_path = argv[2]
    chunk = 1024 * 1024
    slots = max(1, limit // chunk)
    relay_queue = queue.Queue(maxsize=slots)
    stop = object()

    def writer():
        fd = os.open(out_path, os.O_WRONLY)
        with os.fdopen(fd, 'wb', buffering=0) as out:
            while True:
                item = relay_queue.get()
                if item is stop:
                    break
                out.write(item)

    def term(*_):
        os._exit(143)

    signal.signal(signal.SIGTERM, term)
    thread = threading.Thread(target=writer, daemon=True)
    thread.start()
    with open(in_path, 'rb', buffering=0) as inp:
        while True:
            data = inp.read(chunk)
            if not data:
                break
            relay_queue.put(data)
    relay_queue.put(stop)
    thread.join()


def tee_decode_relay(argv):
    limit = max(1, int(argv[0]))
    in_path = argv[1]
    out_paths = argv[2:]
    if len(out_paths) < 2:
        raise SystemExit('tee requires one input FIFO and at least two output FIFOs')
    chunk = 1024 * 1024
    slots = max(1, limit // chunk)
    relay_queues = [queue.Queue(maxsize=slots) for _ in out_paths]
    stop = object()

    def writer(path, relay_queue):
        fd = os.open(path, os.O_WRONLY)
        with os.fdopen(fd, 'wb', buffering=0) as out:
            while True:
                item = relay_queue.get()
                if item is stop:
                    break
                out.write(item)

    def term(*_):
        os._exit(143)

    signal.signal(signal.SIGTERM, term)
    threads = [threading.Thread(target=writer, args=(path, relay_queue), daemon=True) for path, relay_queue in zip(out_paths, relay_queues)]
    for thread in threads:
        thread.start()
    with open(in_path, 'rb', buffering=0) as inp:
        while True:
            data = inp.read(chunk)
            if not data:
                break
            for relay_queue in relay_queues:
                relay_queue.put(data)
    for relay_queue in relay_queues:
        relay_queue.put(stop)
    for thread in threads:
        thread.join()


def pipe_sizer(argv):
    size = int(argv[0])
    fds = []
    for path in argv[1:]:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            _set_pipe_size(fd, size)
            fds.append(fd)
        except Exception:
            pass
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        while True:
            time.sleep(60)
    finally:
        for fd in fds:
            os.close(fd)


COMMANDS = {
    'decode': decode_relay,
    'fifo-write': fifo_write_relay,
    'pipe-sizer': pipe_sizer,
    'splice': splice_relay,
    'tee': tee_decode_relay,
}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in COMMANDS:
        commands = ', '.join(sorted(COMMANDS))
        raise SystemExit(f'usage: paired_apply_relay.py <{commands}> ...')
    command = argv.pop(0)
    COMMANDS[command](argv)


if __name__ == '__main__':
    main()
