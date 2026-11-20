import base64
import ctypes
import json
import os
import time

from cuda_driver import CUipcMemHandle, chk, has_ipc_api
from runtime_env import env_flag, env_string


def device_slot_export_enabled():
    return bool(env_string('LOUDNORM_GPU_DEVICE_SLOT_EXPORT_JSONL', '', strip=True))


def device_slot_output_only_enabled():
    return device_slot_export_enabled() and env_flag('LOUDNORM_GPU_DEVICE_SLOT_OUTPUT_ONLY')


class DeviceSlotExporter:
    def __init__(self, cuda, args, cfg):
        self.cuda = cuda
        self.args = args
        self.cfg = cfg
        self.jsonl_path = env_string('LOUDNORM_GPU_DEVICE_SLOT_EXPORT_JSONL', '', strip=True)
        self.handle_dir = env_string('LOUDNORM_GPU_DEVICE_SLOT_HANDLE_DIR', '', strip=True)
        self.stream_id = env_string('LOUDNORM_GPU_DEVICE_SLOT_STREAM_ID', 'primary', strip=True) or 'primary'
        self.release_file = env_string('LOUDNORM_GPU_DEVICE_SLOT_RELEASE_FILE', '', strip=True)
        self.ready_file = env_string('LOUDNORM_GPU_DEVICE_SLOT_READY_FILE', '', strip=True)
        self.stream_manifest_path = env_string('LOUDNORM_GPU_DEVICE_SLOT_STREAM_MANIFEST', '', strip=True)
        self.stream_ack_dir = env_string('LOUDNORM_GPU_DEVICE_SLOT_STREAM_ACK_DIR', '', strip=True)
        self.max_in_flight = _env_int('LOUDNORM_GPU_DEVICE_SLOT_MAX_IN_FLIGHT', 0)
        self.hold_seconds = _env_float('LOUDNORM_GPU_DEVICE_SLOT_HOLD_SECONDS', 0.0)
        self.retain_chunks = env_flag('LOUDNORM_GPU_DEVICE_SLOT_RETAIN_CHUNKS', False)
        self.sync_ready = env_flag('LOUDNORM_GPU_DEVICE_SLOT_EXPORT_SYNC', True)
        self.handles = {}
        self.retained_slots = []
        self.chunk_index = 0
        if not self.jsonl_path:
            raise RuntimeError('LOUDNORM_GPU_DEVICE_SLOT_EXPORT_JSONL is required for device slot export')
        if not has_ipc_api(cuda):
            raise RuntimeError('CUDA IPC export requested but cuIpcGetMemHandle is unavailable')
        parent = os.path.dirname(os.path.abspath(self.jsonl_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        if self.handle_dir:
            os.makedirs(self.handle_dir, exist_ok=True)
        if self.stream_manifest_path:
            stream_parent = os.path.dirname(os.path.abspath(self.stream_manifest_path))
            if stream_parent:
                os.makedirs(stream_parent, exist_ok=True)
        if self.stream_ack_dir:
            os.makedirs(self.stream_ack_dir, exist_ok=True)

    def _handle_record(self, device_ptr, *, cache=True, handle_index=None):
        key = int(device_ptr)
        cached = self.handles.get(key) if cache else None
        if cached is not None:
            return cached
        handle = CUipcMemHandle()
        chk(self.cuda.cuIpcGetMemHandle(ctypes.byref(handle), ctypes.c_void_p(key)), 'cuIpcGetMemHandle(loudnorm output slot)')
        handle_bytes = ctypes.string_at(ctypes.byref(handle), ctypes.sizeof(handle))
        record = {
            'handle_b64': base64.b64encode(handle_bytes).decode('ascii'),
            'handle_path': '',
        }
        if self.handle_dir:
            index = self.chunk_index if handle_index is None else handle_index
            handle_path = os.path.join(self.handle_dir, f'{self.stream_id}-slot-{index}.handle')
            with open(handle_path, 'wb') as handle_file:
                handle_file.write(handle_bytes)
            record['handle_path'] = handle_path
        if cache:
            self.handles[key] = record
        return record

    def export(self, *, device_ptr, byte_count, frame_count, frame_offset):
        if self.sync_ready:
            chk(self.cuda.cuCtxSynchronize(), 'cuCtxSynchronize(loudnorm device slot ready)')
        source_ptr = int(device_ptr)
        export_ptr = source_ptr
        if self.retain_chunks:
            retained = ctypes.c_void_p()
            chk(self.cuda.cuMemAlloc_v2(ctypes.byref(retained), int(byte_count)), 'cuMemAlloc(loudnorm retained device slot)')
            try:
                chk(
                    self.cuda.cuMemcpyDtoD_v2(retained, ctypes.c_void_p(source_ptr), int(byte_count)),
                    'cuMemcpyDtoD(loudnorm retained device slot)',
                )
            except Exception:
                self.cuda.cuMemFree_v2(retained)
                raise
            export_ptr = int(retained.value)
        handle = self._handle_record(
            export_ptr,
            cache=not self.retain_chunks,
            handle_index=self.chunk_index,
        )
        ack_path = ''
        retained_record = None
        if self.stream_ack_dir:
            ack_path = os.path.join(self.stream_ack_dir, f'{self.stream_id}-slot-{self.chunk_index}.ack')
        if self.retain_chunks:
            retained_record = {'ptr': retained, 'ack_path': ack_path}
            self.retained_slots.append(retained_record)
        record = {
            'schema': 'opx.loudnorm.device_slot.v1',
            'stream_id': self.stream_id,
            'chunk_index': self.chunk_index,
            'device_ptr_hex': f'0x{export_ptr:x}',
            'source_device_ptr_hex': f'0x{source_ptr:x}',
            'frame_offset': int(frame_offset),
            'frames': int(frame_count),
            'bytes': int(byte_count),
            'channels': int(self.args.channels),
            'rate': int(self.args.rate),
            'sample_bytes': int(self.cfg.sizing.output_sample_bytes),
            'output_format': self.args.output_format,
            'ready': bool(self.sync_ready),
            'retained': bool(self.retain_chunks),
            'ack_path': ack_path,
            'handle_b64': handle['handle_b64'],
            'handle_path': handle['handle_path'],
            'pid': os.getpid(),
            'created_unix': time.time(),
        }
        with open(self.jsonl_path, 'a', encoding='utf-8') as manifest:
            manifest.write(json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n')
            manifest.flush()
        print(
            f'LOUDNORM_DEVICE_SLOT stream={self.stream_id} chunk={self.chunk_index} '
            f'frame_offset={int(frame_offset)} frames={int(frame_count)} bytes={int(byte_count)} '
            f'ptr=0x{export_ptr:x} ready={1 if self.sync_ready else 0} retained={1 if self.retain_chunks else 0}',
            file=os.sys.stderr,
            flush=True,
        )
        if self.stream_manifest_path:
            offset_bytes = int(frame_offset) * int(self.args.channels) * int(self.cfg.sizing.output_sample_bytes)
            with open(self.stream_manifest_path, 'a', encoding='utf-8') as stream_manifest:
                stream_manifest.write(f'{offset_bytes} {int(byte_count)} {handle["handle_path"]} {ack_path}\n')
                stream_manifest.flush()
        self._apply_backpressure()
        self.chunk_index += 1

    def _apply_backpressure(self):
        if not self.max_in_flight or not self.retained_slots:
            return
        while len(self.retained_slots) >= self.max_in_flight:
            self._wait_and_release_oldest_ack()

    def _wait_and_release_oldest_ack(self):
        record = self.retained_slots[0]
        ack_path = record.get('ack_path') or ''
        if not ack_path:
            return
        deadline = time.monotonic() + (self.hold_seconds if self.hold_seconds > 0 else 300.0)
        while not os.path.exists(ack_path):
            if time.monotonic() >= deadline:
                raise RuntimeError(f'timed out waiting for loudnorm device slot ack: {ack_path}')
            time.sleep(0.01)
        self._free_retained_record(self.retained_slots.pop(0))

    def _free_retained_record(self, record):
        retained = record.get('ptr')
        if retained is not None and retained.value:
            chk(self.cuda.cuMemFree_v2(retained), 'cuMemFree(loudnorm retained device slot)')
            retained.value = None

    def wait_for_release(self):
        if self.ready_file:
            parent = os.path.dirname(os.path.abspath(self.ready_file))
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(self.ready_file, 'w', encoding='utf-8') as ready:
                ready.write(f'chunks={self.chunk_index}\n')
        if self.release_file:
            timeout = self.hold_seconds if self.hold_seconds > 0 else 300.0
            deadline = time.monotonic() + timeout
            print(
                f'LOUDNORM_DEVICE_SLOT_WAIT release_file={self.release_file} chunks={self.chunk_index} timeout_sec={timeout:.3f}',
                file=os.sys.stderr,
                flush=True,
            )
            while not os.path.exists(self.release_file):
                if time.monotonic() >= deadline:
                    raise RuntimeError('timed out waiting for loudnorm device slot release file')
                time.sleep(0.05)
            print('LOUDNORM_DEVICE_SLOT_RELEASED', file=os.sys.stderr, flush=True)
        elif self.hold_seconds > 0:
            print(
                f'LOUDNORM_DEVICE_SLOT_HOLD chunks={self.chunk_index} seconds={self.hold_seconds:.3f}',
                file=os.sys.stderr,
                flush=True,
            )
            time.sleep(self.hold_seconds)
        while self.retained_slots:
            record = self.retained_slots[0]
            if record.get('ack_path'):
                self._wait_and_release_oldest_ack()
            else:
                self._free_retained_record(self.retained_slots.pop(0))
        self.retained_slots = []


def maybe_export_device_slot(ctx, *, this_output_bytes, this_frames, frame_offset):
    if not device_slot_export_enabled():
        return
    owner = getattr(ctx, 'cuda_session', None) or ctx
    exporter = getattr(owner, '_device_slot_exporter', None)
    if exporter is None:
        exporter = DeviceSlotExporter(ctx.cuda, ctx.args, ctx.cfg)
        owner._device_slot_exporter = exporter
    exporter.export(
        device_ptr=ctx.bindings.out_arg.value,
        byte_count=this_output_bytes,
        frame_count=this_frames,
        frame_offset=frame_offset,
    )


def wait_for_device_slot_export_release(ctx):
    exporter = getattr(ctx, '_device_slot_exporter', None)
    if exporter is None:
        session = getattr(ctx, 'cuda_session', None)
        exporter = getattr(session, '_device_slot_exporter', None) if session is not None else None
    if exporter is not None:
        exporter.wait_for_release()


def _env_float(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return max(0.0, float(value))
    except ValueError:
        return default


def _env_int(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return max(0, int(value))
    except ValueError:
        return default
