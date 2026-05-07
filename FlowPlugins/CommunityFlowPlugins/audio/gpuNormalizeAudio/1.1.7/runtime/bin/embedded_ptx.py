from __future__ import annotations


EMBEDDED_PTX = r'''
.version 6.4
.target sm_61
.address_size 64

.visible .entry window_stats_kernel(
    .param .u64 input,
    .param .u64 sums,
    .param .u64 peaks,
    .param .u32 n,
    .param .u32 window_size,
    .param .u32 window_offset,
    .param .u32 channels
)
{
    .reg .pred %p<8>;
    .reg .b32 %r<28>;
    .reg .b64 %rd<14>;
    .reg .f32 %f<12>;

    ld.param.u64 %rd1, [input];
    ld.param.u64 %rd2, [sums];
    ld.param.u64 %rd3, [peaks];
    ld.param.u32 %r1, [n];
    ld.param.u32 %r2, [window_size];
    ld.param.u32 %r20, [window_offset];
    ld.param.u32 %r22, [channels];

    mov.u32 %r3, %ctaid.x;
    mov.u32 %r4, %tid.x;
    mov.u32 %r5, %ntid.x;
    mul.lo.u32 %r6, %r3, %r2;
    add.u32 %r7, %r6, %r2;
    min.u32 %r7, %r7, %r1;
    add.u32 %r8, %r6, %r4;
    add.u32 %r21, %r3, %r20;
    mov.f32 %f1, 0f00000000;
    mov.f32 %f2, 0f00000000;

STATS_LOOP:
    setp.ge.u32 %p1, %r8, %r7;
    @%p1 bra STATS_DONE;
    mul.wide.u32 %rd4, %r8, 4;
    add.u64 %rd5, %rd1, %rd4;
    ld.global.f32 %f3, [%rd5];
    abs.f32 %f4, %f3;
    mov.f32 %f6, 0f3F800000;
    rem.u32 %r23, %r8, %r22;
    setp.eq.u32 %p2, %r22, 6;
    @!%p2 bra WEIGHT_DONE;
    setp.eq.u32 %p3, %r23, 3;
    @%p3 mov.f32 %f6, 0f00000000;
    setp.lt.u32 %p4, %r23, 4;
    @%p4 bra WEIGHT_DONE;
    mov.f32 %f6, 0f3FB47AE1; // ~1.41 surround weight
WEIGHT_DONE:
    mul.rn.f32 %f7, %f3, %f3;
    fma.rn.f32 %f1, %f7, %f6, %f1;
    max.f32 %f2, %f2, %f4;
    add.u32 %r8, %r8, %r5;
    bra STATS_LOOP;

STATS_DONE:
    mul.wide.u32 %rd6, %r21, 4;
    add.u64 %rd7, %rd2, %rd6;
    add.u64 %rd8, %rd3, %rd6;
    atom.global.add.f32 %f5, [%rd7], %f1;
    mov.b32 %r9, %f2;
    atom.global.max.u32 %r10, [%rd8], %r9;
    ret;
}

.visible .entry gain_plan_kernel(
    .param .u64 sums,
    .param .u64 peaks,
    .param .u64 counts,
    .param .u64 raw_gains,
    .param .u32 windows,
    .param .f32 target_rms,
    .param .f32 global_rms,
    .param .f32 ceiling,
    .param .f32 max_gain,
    .param .f32 dynamic_strength
)
{
    .reg .pred %p<8>;
    .reg .b32 %r<24>;
    .reg .b64 %rd<18>;
    .reg .f32 %f<28>;

    ld.param.u64 %rd1, [sums];
    ld.param.u64 %rd2, [peaks];
    ld.param.u64 %rd3, [counts];
    ld.param.u64 %rd4, [raw_gains];
    ld.param.u32 %r1, [windows];
    ld.param.f32 %f1, [target_rms];
    ld.param.f32 %f2, [global_rms];
    ld.param.f32 %f3, [ceiling];
    ld.param.f32 %f4, [max_gain];
    ld.param.f32 %f5, [dynamic_strength];

    mov.u32 %r2, %tid.x;
    mov.u32 %r3, %ctaid.x;
    mov.u32 %r4, %ntid.x;
    mov.u32 %r5, %nctaid.x;
    mad.lo.u32 %r6, %r3, %r4, %r2;
    mul.lo.u32 %r7, %r4, %r5;

GAIN_LOOP:
    setp.ge.u32 %p1, %r6, %r1;
    @%p1 bra GAIN_DONE;
    setp.ge.u32 %p2, %r6, 29;
    @%p2 bra HAVE_START;
    mov.u32 %r8, 0;
    bra START_DONE;
HAVE_START:
    sub.u32 %r8, %r6, 29;
START_DONE:
    mov.u32 %r9, %r8;
    mov.f32 %f6, 0f00000000;
    mov.u32 %r10, 0;
    mov.f32 %f7, 0f00000000;
SHORT_LOOP:
    setp.gt.u32 %p3, %r9, %r6;
    @%p3 bra SHORT_DONE;
    mul.wide.u32 %rd5, %r9, 4;
    add.u64 %rd6, %rd1, %rd5;
    add.u64 %rd7, %rd2, %rd5;
    add.u64 %rd8, %rd3, %rd5;
    ld.global.f32 %f8, [%rd6];
    ld.global.u32 %r11, [%rd8];
    ld.global.u32 %r12, [%rd7];
    add.rn.f32 %f6, %f6, %f8;
    add.u32 %r10, %r10, %r11;
    mov.b32 %f9, %r12;
    max.f32 %f7, %f7, %f9;
    add.u32 %r9, %r9, 1;
    bra SHORT_LOOP;

SHORT_DONE:
    cvt.rn.f32.u32 %f10, %r10;
    max.f32 %f10, %f10, 0f3F800000;
    div.rn.f32 %f11, %f6, %f10;
    max.f32 %f11, %f11, 0f2EDBE6FF; // ~1e-10
    sqrt.rn.f32 %f12, %f11;
    max.f32 %f13, %f2, 0f322BCC77; // ~1e-8
    div.rn.f32 %f14, %f1, %f12;
    div.rn.f32 %f15, %f1, %f13;
    sub.rn.f32 %f16, %f14, %f15;
    fma.rn.f32 %f17, %f5, %f16, %f15;
    min.f32 %f17, %f17, %f4;
    setp.gt.f32 %p4, %f7, 0f3089705F; // ~1e-9
    @!%p4 bra STORE_GAIN;
    div.rn.f32 %f18, %f3, %f7;
    min.f32 %f17, %f17, %f18;
STORE_GAIN:
    max.f32 %f17, %f17, 0f00000000;
    mul.wide.u32 %rd9, %r6, 4;
    add.u64 %rd10, %rd4, %rd9;
    st.global.f32 [%rd10], %f17;
    add.u32 %r6, %r6, %r7;
    bra GAIN_LOOP;

GAIN_DONE:
    ret;
}

.visible .entry smooth_gain_kernel(
    .param .u64 raw_gains,
    .param .u64 smooth_gains,
    .param .u64 weights,
    .param .u32 windows
)
{
    .reg .pred %p<5>;
    .reg .b32 %r<18>;
    .reg .b64 %rd<18>;
    .reg .f32 %f<8>;

    ld.param.u64 %rd1, [raw_gains];
    ld.param.u64 %rd2, [smooth_gains];
    ld.param.u64 %rd3, [weights];
    ld.param.u32 %r1, [windows];

    mov.u32 %r2, %tid.x;
    mov.u32 %r3, %ctaid.x;
    mov.u32 %r4, %ntid.x;
    mov.u32 %r5, %nctaid.x;
    mad.lo.u32 %r6, %r3, %r4, %r2;
    mul.lo.u32 %r7, %r4, %r5;

SMOOTH_LOOP:
    setp.ge.u32 %p1, %r6, %r1;
    @%p1 bra SMOOTH_DONE;
    mov.u32 %r8, 0;
    mov.f32 %f1, 0f00000000;
TAP_LOOP:
    setp.ge.u32 %p2, %r8, 21;
    @%p2 bra STORE_SMOOTH;
    add.u32 %r9, %r6, %r8;
    setp.ge.u32 %p3, %r9, 10;
    @%p3 bra SUB_OK;
    mov.u32 %r9, 0;
    bra HAVE_INDEX;
SUB_OK:
    sub.u32 %r9, %r9, 10;
    setp.lt.u32 %p4, %r9, %r1;
    @%p4 bra HAVE_INDEX;
    sub.u32 %r9, %r1, 1;
HAVE_INDEX:
    mul.wide.u32 %rd4, %r9, 4;
    add.u64 %rd5, %rd1, %rd4;
    mul.wide.u32 %rd6, %r8, 4;
    add.u64 %rd7, %rd3, %rd6;
    ld.global.f32 %f2, [%rd5];
    ld.global.f32 %f3, [%rd7];
    fma.rn.f32 %f1, %f2, %f3, %f1;
    add.u32 %r8, %r8, 1;
    bra TAP_LOOP;
STORE_SMOOTH:
    mul.wide.u32 %rd8, %r6, 4;
    add.u64 %rd9, %rd2, %rd8;
    st.global.f32 [%rd9], %f1;
    add.u32 %r6, %r6, %r7;
    bra SMOOTH_LOOP;

SMOOTH_DONE:
    ret;
}

.visible .entry apply_plan_kernel(
    .param .u64 input,
    .param .u64 output,
    .param .u64 gains,
    .param .u32 n,
    .param .u32 window_size,
    .param .u32 windows,
    .param .u32 sample_offset,
    .param .f32 ceiling
)
{
    .reg .pred %p<4>;
    .reg .b32 %r<24>;
    .reg .b64 %rd<16>;
    .reg .f32 %f<16>;

    ld.param.u64 %rd1, [input];
    ld.param.u64 %rd2, [output];
    ld.param.u64 %rd3, [gains];
    ld.param.u32 %r1, [n];
    ld.param.u32 %r2, [window_size];
    ld.param.u32 %r3, [windows];
    ld.param.u32 %r18, [sample_offset];
    ld.param.f32 %f1, [ceiling];

    mov.u32 %r4, %tid.x;
    mov.u32 %r5, %ctaid.x;
    mov.u32 %r6, %ntid.x;
    mov.u32 %r7, %nctaid.x;
    mad.lo.u32 %r8, %r5, %r6, %r4;
    mul.lo.u32 %r9, %r6, %r7;

APPLY_LOOP:
    setp.ge.u32 %p1, %r8, %r1;
    @%p1 bra APPLY_DONE;
    add.u32 %r19, %r8, %r18;
    div.u32 %r10, %r19, %r2;
    rem.u32 %r11, %r19, %r2;
    add.u32 %r12, %r10, 1;
    setp.ge.u32 %p2, %r12, %r3;
    @!%p2 bra NEXT_OK;
    sub.u32 %r12, %r3, 1;
NEXT_OK:
    mul.wide.u32 %rd4, %r10, 4;
    add.u64 %rd5, %rd3, %rd4;
    mul.wide.u32 %rd6, %r12, 4;
    add.u64 %rd7, %rd3, %rd6;
    ld.global.f32 %f2, [%rd5];
    ld.global.f32 %f3, [%rd7];
    cvt.rn.f32.u32 %f4, %r11;
    cvt.rn.f32.u32 %f5, %r2;
    div.rn.f32 %f6, %f4, %f5;
    sub.rn.f32 %f7, %f3, %f2;
    fma.rn.f32 %f8, %f7, %f6, %f2;
    mul.wide.u32 %rd8, %r8, 4;
    add.u64 %rd9, %rd1, %rd8;
    add.u64 %rd10, %rd2, %rd8;
    ld.global.f32 %f9, [%rd9];
    mul.rn.f32 %f10, %f9, %f8;
    neg.f32 %f11, %f1;
    max.f32 %f12, %f10, %f11;
    min.f32 %f13, %f12, %f1;
    st.global.f32 [%rd10], %f13;
    add.u32 %r8, %r8, %r9;
    bra APPLY_LOOP;

APPLY_DONE:
    ret;
}
'''
