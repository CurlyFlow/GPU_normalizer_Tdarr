from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ExactLimiterChunkPlan:
    this_frames: int
    exact_run_end_frame: int
    exact_run_flag: int
    input_base_frame: int
    input_frames: int
    sparse_split: bool = False


def plan_exact_limiter_chunk(*, total_frames, frame_offset, chunk_bytes, frame_bytes, exact_use_final_flush, exact_prefinal_frames, exact_final_flush_frames, exact_sparse_chunks, prelimiter_unsafe_flags, windows, frames_per_window, limiter_lookahead_frames, exact_prefill_output=False, exact_safe_chunk_bytes=None, exact_unsafe_chunk_bytes=None):
    remaining_frames = total_frames - frame_offset
    selected_chunk_bytes = chunk_bytes
    current_flag = None
    if exact_sparse_chunks and prelimiter_unsafe_flags is not None and frame_offset < exact_prefinal_frames:
        first_window = min(windows - 1, frame_offset // frames_per_window) if windows else 0
        current_flag = prelimiter_unsafe_flags[first_window] if windows else 1
        if current_flag == 0 and exact_safe_chunk_bytes:
            selected_chunk_bytes = exact_safe_chunk_bytes
        elif current_flag != 0 and exact_unsafe_chunk_bytes:
            selected_chunk_bytes = exact_unsafe_chunk_bytes
    max_output_frames = max(1, selected_chunk_bytes // frame_bytes)
    if exact_use_final_flush and frame_offset < exact_prefinal_frames:
        this_frames = min(max_output_frames, exact_prefinal_frames - frame_offset)
    else:
        this_frames = min(max_output_frames, remaining_frames)

    exact_run_end_frame = frame_offset + this_frames
    exact_run_flag = 1
    sparse_split = False

    if exact_sparse_chunks and prelimiter_unsafe_flags is not None and frame_offset < exact_prefinal_frames:
        first_window = min(windows - 1, frame_offset // frames_per_window) if windows else 0
        if current_flag is None:
            current_flag = prelimiter_unsafe_flags[first_window] if windows else 1
        exact_run_flag = current_flag
        next_window = first_window + 1
        while next_window < windows and prelimiter_unsafe_flags[next_window] == current_flag:
            next_window += 1
        run_end_frame = min(exact_prefinal_frames, next_window * frames_per_window)
        exact_run_end_frame = run_end_frame
        if run_end_frame > frame_offset:
            sparse_frames = min(this_frames, run_end_frame - frame_offset)
            sparse_split = sparse_frames < this_frames
            this_frames = sparse_frames

        if (
            frames_per_window > 0
            and frame_offset < exact_prefinal_frames
            and (frame_offset % frames_per_window) == 0
            and frame_offset + this_frames < exact_prefinal_frames
            and this_frames > frames_per_window
            and (this_frames % frames_per_window) != 0
        ):
            aligned_frames = (this_frames // frames_per_window) * frames_per_window
            if aligned_frames > 0:
                sparse_split = True
                this_frames = aligned_frames
                exact_run_end_frame = frame_offset + this_frames

    if exact_use_final_flush and frame_offset >= exact_prefinal_frames:
        input_base_frame = exact_prefinal_frames
        input_frames = min(total_frames - input_base_frame, exact_final_flush_frames)
    elif frame_offset == 0 or exact_prefill_output:
        input_base_frame = 0
        if frame_offset != 0:
            input_base_frame = frame_offset
        input_frames = min(total_frames - input_base_frame, this_frames + limiter_lookahead_frames)
    else:
        input_base_frame = frame_offset + limiter_lookahead_frames - frames_per_window
        input_frames = min(total_frames - input_base_frame, this_frames + limiter_lookahead_frames)

    return ExactLimiterChunkPlan(
        this_frames=this_frames,
        exact_run_end_frame=exact_run_end_frame,
        exact_run_flag=exact_run_flag,
        input_base_frame=input_base_frame,
        input_frames=input_frames,
        sparse_split=sparse_split,
    )
