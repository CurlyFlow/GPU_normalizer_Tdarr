from sync_apply_session import close_paired_sync_apply_states, close_sync_apply_state, open_sync_apply_state
from sync_apply_step import run_sync_apply_step


def run_sync_apply(ctx, result):
    state = open_sync_apply_state(ctx, result)
    try:
        while run_sync_apply_step(ctx, result, state):
            pass
    finally:
        close_sync_apply_state(ctx, result, state)


def run_paired_sync_apply(primary_ctx, primary_result, partner_ctx, partner_result):
    primary_state = open_sync_apply_state(primary_ctx, primary_result, force_prefetch=True)
    try:
        partner_state = open_sync_apply_state(partner_ctx, partner_result, force_prefetch=True)
    except BaseException:
        close_sync_apply_state(primary_ctx, primary_result, primary_state)
        raise
    try:
        while primary_state.active or partner_state.active:
            candidates = []
            if primary_state.active:
                primary_progress = primary_state.done_bytes / float(primary_ctx.cfg.input_shape.nbytes) if primary_ctx.cfg.input_shape.nbytes else 1.0
                candidates.append((primary_progress, primary_ctx, primary_result, primary_state))
            if partner_state.active:
                partner_progress = partner_state.done_bytes / float(partner_ctx.cfg.input_shape.nbytes) if partner_ctx.cfg.input_shape.nbytes else 1.0
                candidates.append((partner_progress, partner_ctx, partner_result, partner_state))
            if not candidates:
                break
            _, ctx, result, state = min(candidates, key=lambda item: item[0])
            if not run_sync_apply_step(ctx, result, state):
                break
    finally:
        close_paired_sync_apply_states(primary_ctx, primary_result, primary_state, partner_ctx, partner_result, partner_state)
