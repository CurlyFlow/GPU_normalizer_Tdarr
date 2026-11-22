"""Lock inherited fd 3; its parent retains the shared open-file description."""
import fcntl
import sys


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit(2)
    try:
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(75)
