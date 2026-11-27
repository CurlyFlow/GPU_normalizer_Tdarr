"""Keep native code independent of Tdarr's in-place plugin synchronization."""
import ctypes
import os
import sys


def load_native_library(path):
    # The existing non-Linux native-library override keeps its platform loader.
    if sys.platform != 'linux':
        return ctypes.CDLL(path)

    import fcntl

    with open(path, 'rb') as source:
        before = os.fstat(source.fileno())
        image = source.read(16 * 1024 * 1024 + 1)
        after = os.fstat(source.fileno())
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size,
                              value.st_mtime_ns, value.st_ctime_ns)
    if (identity(before) != identity(after) or not 0 < len(image) <= 16 * 1024 * 1024
            or len(image) != before.st_size):
        raise OSError('Native library changed while reading its process image')

    descriptor = os.memfd_create('loudnorm-channel-stats', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        offset = 0
        while offset < len(image):
            written = os.write(descriptor, memoryview(image)[offset:])
            if written <= 0:
                raise OSError('Native process image write did not progress')
            offset += written
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS,
                    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        library = ctypes.CDLL(f'/proc/self/fd/{descriptor}')
    except BaseException:
        os.close(descriptor)
        raise

    # Retain one descriptor for this process-lifetime library. Reusing its fd
    # number could otherwise alias a later dlopen() name in the loader's cache.
    library._opx_image_fd = descriptor
    return library
