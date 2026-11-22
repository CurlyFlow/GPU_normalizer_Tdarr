extern "C" __device__ double source_window_range_sum_dev(
    const double *window_sums,
    const double *source_channel_sums,
    unsigned int start,
    unsigned int count,
    unsigned int channels,
    unsigned int windows,
    unsigned int source_faithful_stereo
) {
    if (start >= windows || count == 0U) return 0.0;
    unsigned int end = start + count;
    if (end > windows || end < start) end = windows;
    if (source_faithful_stereo && channels == 2U && source_channel_sums) {
        double total = 0.0;
        for (unsigned int c = 0; c < 2U; c++) {
            for (unsigned int w = start; w < end; w++) {
                total += source_channel_sums[((unsigned long long)w * 2ULL) + c];
            }
        }
        return total;
    }
    double total = 0.0;
    for (unsigned int w = start; w < end; w++) total += window_sums[w];
    return total;
}
