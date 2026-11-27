from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SourceExactKernelVariant:
    kind: str
    attr: str
    symbol: str
    label: str
    label_suffix: str

    def runtime_label(self, base_label):
        if self.kind == 'fast':
            return f'{base_label}-fast' if base_label == 'source-exact-precompute' else base_label
        return f'{base_label}-{self.label_suffix}'


SOURCE_EXACT_FAST = SourceExactKernelVariant(
    kind='fast',
    attr='source_exact_sums_fn',
    symbol='source_stereo_exact_sums_f64_kernel',
    label='source-stereo-exact-sums',
    label_suffix='fast',
)

SOURCE_EXACT_SPLIT_VARIANTS = (
    SourceExactKernelVariant(
        kind='split',
        attr='source_exact_split_sums_fn',
        symbol='source_stereo_exact_sums_split_f64_kernel',
        label='source-stereo-exact-sums-split',
        label_suffix='split',
    ),
    SourceExactKernelVariant(
        kind='split_unroll4',
        attr='source_exact_split_unroll4_sums_fn',
        symbol='source_stereo_exact_sums_split_unroll4_f64_kernel',
        label='source-stereo-exact-sums-split-unroll4',
        label_suffix='split-unroll4',
    ),
    SourceExactKernelVariant(
        kind='split_pointer',
        attr='source_exact_split_pointer_sums_fn',
        symbol='source_stereo_exact_sums_split_pointer_f64_kernel',
        label='source-stereo-exact-sums-split-pointer',
        label_suffix='split-pointer',
    ),
    SourceExactKernelVariant(
        kind='split_readonly',
        attr='source_exact_split_readonly_sums_fn',
        symbol='source_stereo_exact_sums_split_readonly_f64_kernel',
        label='source-stereo-exact-sums-split-readonly',
        label_suffix='split-readonly',
    ),
)

SOURCE_EXACT_SPLIT_BY_KIND = {variant.kind: variant for variant in SOURCE_EXACT_SPLIT_VARIANTS}


def selected_source_exact_kernel_variant(cfg):
    if not getattr(cfg.exact, 'source_exact_split_sums', False):
        return SOURCE_EXACT_FAST
    if getattr(cfg.exact, 'source_exact_split_unroll4', False):
        return SOURCE_EXACT_SPLIT_BY_KIND['split_unroll4']
    if getattr(cfg.exact, 'source_exact_split_pointer_walk', False):
        return SOURCE_EXACT_SPLIT_BY_KIND['split_pointer']
    if getattr(cfg.exact, 'source_exact_split_readonly_loads', False):
        return SOURCE_EXACT_SPLIT_BY_KIND['split_readonly']
    return SOURCE_EXACT_SPLIT_BY_KIND['split']


def source_exact_load_variants(cfg):
    variants = [SOURCE_EXACT_FAST]
    if not getattr(cfg.exact, 'source_exact_split_sums', False):
        return tuple(variants)
    variants.append(SOURCE_EXACT_SPLIT_BY_KIND['split'])
    if getattr(cfg.exact, 'source_exact_split_unroll4', False):
        variants.append(SOURCE_EXACT_SPLIT_BY_KIND['split_unroll4'])
    if getattr(cfg.exact, 'source_exact_split_pointer_walk', False):
        variants.append(SOURCE_EXACT_SPLIT_BY_KIND['split_pointer'])
    if getattr(cfg.exact, 'source_exact_split_readonly_loads', False):
        variants.append(SOURCE_EXACT_SPLIT_BY_KIND['split_readonly'])
    return tuple(variants)
