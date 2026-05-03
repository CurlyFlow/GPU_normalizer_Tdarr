import ctypes
import sys
from pathlib import Path

NVRTC = '/tmp/opencode/cuda-py/nvidia/cuda_nvrtc/lib/libnvrtc.so.12'

src_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
src = src_path.read_text().encode()
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

opts = [b'--gpu-architecture=compute_61', b'--std=c++11']
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
