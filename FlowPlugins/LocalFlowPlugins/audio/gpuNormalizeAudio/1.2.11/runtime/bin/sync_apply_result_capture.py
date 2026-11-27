import array
import ctypes
import sys

from cuda_driver import chk
from feedback_apply import (
    FFMPEG_STATE_AUDIT_D_WORDS,
    FFMPEG_STATE_AUDIT_I_WORDS,
    FEEDBACK_STATE_D_WORDS,
    FEEDBACK_STATE_I_WORDS,
    copy_feedback_state_d_from_device,
    copy_feedback_state_i_from_device,
)


def capture_sync_apply_close_results(ctx, result):
    _capture_native_output_sums_audit(ctx)
    _capture_exact_profile_counts(ctx, result)
    _capture_ffmpeg_state_audit(ctx, result)


def _capture_native_output_sums_audit(ctx):
    native_output_sums_audit = getattr(ctx, 'native_first_pass_output_sums_audit', None)
    if sys.exc_info()[0] is None and ctx.cfg.exact.emit_first_pass_json and native_output_sums_audit is not None:
        ctx.cfg._first_pass_output_sums_host_audit = native_output_sums_audit['sums']
        ctx.cfg._first_pass_output_sums_host_audit_source = 'native'


def _capture_exact_profile_counts(ctx, result):
    if not (ctx.cfg.loudnorm_mode.exact_limiter_active and ctx.cfg.exact.exact_profile_counts):
        return
    result.exact_counts_host = array.array('d', [0.0]) * 128
    chk(
        ctx.cuda.cuMemcpyDtoH_v2(
            ctypes.c_void_p(result.exact_counts_host.buffer_info()[0]),
            ctx.buffers.d_feedback_state_d,
            128 * 8,
        ),
        'cuMemcpyDtoH(exact profile counts)',
    )


def _capture_ffmpeg_state_audit(ctx, result):
    cfg = ctx.cfg
    if not (
        sys.exc_info()[0] is None
        and cfg.loudnorm_mode.exact_limiter_active
        and cfg.exact.audit_ffmpeg_state_snapshots
        and ctx.buffers.d_feedback_state_i.value
        and ctx.buffers.d_feedback_state_d.value
    ):
        return

    result.ffmpeg_state_audit_i_host = array.array('I', [0]) * FEEDBACK_STATE_I_WORDS
    result.ffmpeg_state_audit_d_host = array.array('d', [0.0]) * FEEDBACK_STATE_D_WORDS
    copy_feedback_state_i_from_device(
        ctx.cuda,
        result.ffmpeg_state_audit_i_host,
        ctx.buffers.d_feedback_state_i,
        'cuMemcpyDtoH(ffmpeg_state_audit_i)',
    )
    copy_feedback_state_d_from_device(
        ctx.cuda,
        result.ffmpeg_state_audit_d_host,
        ctx.buffers.d_feedback_state_d,
        'cuMemcpyDtoH(ffmpeg_state_audit_d)',
    )
    _capture_ffmpeg_state_snapshots(ctx, result)


def _capture_ffmpeg_state_snapshots(ctx, result):
    cfg = ctx.cfg
    if not (getattr(cfg.exact, 'audit_ffmpeg_state_snapshots', False) and ctx.buffers.d_ffmpeg_state_audit_i.value and ctx.buffers.d_ffmpeg_state_audit_d.value):
        return
    audit_max_events = cfg.exact.audit_ffmpeg_state_max_events or max(8, cfg.input_shape.windows * 3 + 8)
    result.ffmpeg_state_audit_snapshot_i_host = array.array('I', [0]) * (1 + audit_max_events * FFMPEG_STATE_AUDIT_I_WORDS)
    result.ffmpeg_state_audit_snapshot_d_host = array.array('d', [0.0]) * (audit_max_events * FFMPEG_STATE_AUDIT_D_WORDS)
    chk(
        ctx.cuda.cuMemcpyDtoH_v2(
            ctypes.c_void_p(result.ffmpeg_state_audit_snapshot_i_host.buffer_info()[0]),
            ctx.buffers.d_ffmpeg_state_audit_i,
            len(result.ffmpeg_state_audit_snapshot_i_host) * 4,
        ),
        'cuMemcpyDtoH(ffmpeg_state_audit_snapshot_i)',
    )
    result.ffmpeg_state_audit_snapshot_count = min(int(result.ffmpeg_state_audit_snapshot_i_host[0]), audit_max_events)
    if result.ffmpeg_state_audit_snapshot_count > 0:
        chk(
            ctx.cuda.cuMemcpyDtoH_v2(
                ctypes.c_void_p(result.ffmpeg_state_audit_snapshot_d_host.buffer_info()[0]),
                ctx.buffers.d_ffmpeg_state_audit_d,
                len(result.ffmpeg_state_audit_snapshot_d_host) * 8,
            ),
            'cuMemcpyDtoH(ffmpeg_state_audit_snapshot_d)',
        )
