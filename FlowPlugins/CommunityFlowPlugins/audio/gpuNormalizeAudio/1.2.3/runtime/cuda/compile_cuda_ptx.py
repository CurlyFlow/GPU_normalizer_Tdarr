import ctypes
import ctypes.util
import os
import sys
from pathlib import Path

RUNTIME_BIN = Path(__file__).resolve().parents[1] / 'bin'
sys.path.insert(0, str(RUNTIME_BIN))

from cuda_kernel_manifest import validate_kernel_symbols


def read_cuda_source_with_local_includes(path, seen=None):
    seen = set() if seen is None else seen
    path = path.resolve()
    if path in seen:
        raise RuntimeError(f'Circular CUDA include: {path}')
    seen.add(path)
    out = []
    for line in path.read_text().splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith('#include "') and stripped.endswith('"'):
            include_name = stripped[len('#include "'):-1]
            include_path = (path.parent / include_name).resolve()
            out.append(read_cuda_source_with_local_includes(include_path, seen))
        else:
            out.append(line)
    seen.remove(path)
    return ''.join(out)

NVRTC = os.environ.get('NVRTC_LIB') or ctypes.util.find_library('nvrtc')
if not NVRTC:
    for candidate in ('libnvrtc.so', 'libnvrtc.so.12'):
        if Path(candidate).exists():
            NVRTC = candidate
            break
if not NVRTC:
    raise RuntimeError('Unable to find NVRTC. Set NVRTC_LIB=/path/to/libnvrtc.so')

src_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
source_text = read_cuda_source_with_local_includes(src_path)
validate_kernel_symbols(source_text)
src = source_text.encode()
name = src_path.name.encode()

nvrtc = ctypes.CDLL(NVRTC)
nvrtc.nvrtcVersion.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
nvrtc.nvrtcCreateProgram.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
nvrtc.nvrtcCompileProgram.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
nvrtc.nvrtcGetProgramLogSize.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t)]
nvrtc.nvrtcGetProgramLog.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
nvrtc.nvrtcGetPTXSize.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t)]
nvrtc.nvrtcGetPTX.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
nvrtc.nvrtcDestroyProgram.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
nvrtc.nvrtcGetErrorString.argtypes = [ctypes.c_int]
nvrtc.nvrtcGetErrorString.restype = ctypes.c_char_p

major = ctypes.c_int()
minor = ctypes.c_int()
nvrtc.nvrtcVersion(ctypes.byref(major), ctypes.byref(minor))
print(f'nvrtc={major.value}.{minor.value}')

prog = ctypes.c_void_p()
rc = nvrtc.nvrtcCreateProgram(ctypes.byref(prog), src, name, 0, None, None)
if rc != 0:
    raise RuntimeError(nvrtc.nvrtcGetErrorString(rc).decode())

opts = [
    b'--gpu-architecture=compute_61',
    b'--std=c++11',
    b'--fmad=false',
    b'--prec-div=true',
    b'--prec-sqrt=true',
    b'--ftz=false',
]
arr = (ctypes.c_char_p * len(opts))(*opts)
rc = nvrtc.nvrtcCompileProgram(prog, len(opts), arr)
log_size = ctypes.c_size_t()
nvrtc.nvrtcGetProgramLogSize(prog, ctypes.byref(log_size))
if log_size.value > 1:
    log = ctypes.create_string_buffer(log_size.value)
    nvrtc.nvrtcGetProgramLog(prog, log)
    print(log.value.decode(errors='replace'))
if rc != 0:
    raise RuntimeError(nvrtc.nvrtcGetErrorString(rc).decode())

ptx_size = ctypes.c_size_t()
nvrtc.nvrtcGetPTXSize(prog, ctypes.byref(ptx_size))
ptx = ctypes.create_string_buffer(ptx_size.value)
nvrtc.nvrtcGetPTX(prog, ptx)
out_path.write_bytes(ptx.raw.rstrip(b'\x00'))
nvrtc.nvrtcDestroyProgram(ctypes.byref(prog))
print(f'wrote {out_path} bytes={out_path.stat().st_size}')
