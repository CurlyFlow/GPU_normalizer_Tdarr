// af_loudnorm FIRST_FRAME shorter than 3000ms: no dynamic controller/limiter.
// Each channel retains ebur128's serial IIR and summation order.
extern "C" __global__ void short_source_filter_f64_kernel(
    const double *input, double *energy, double *peak, unsigned int frames,
    unsigned int channels, unsigned int rate, const double *b, const double *a) {
    const unsigned int c = blockIdx.x * blockDim.x + threadIdx.x;
    if (c >= channels) return;
    double v1 = 0.0, v2 = 0.0, v3 = 0.0, v4 = 0.0, maximum = 0.0;
    const unsigned int step = (rate + 5) / 10;
    unsigned int boundary = step * 4;
    for (unsigned int f = 0; f < frames; f++) {
        const unsigned long long index = (unsigned long long)f * channels + c;
        const double x = input[index];
        const double absolute = fabs(x);
        if (absolute > maximum) maximum = absolute;
        const double v0 = kweight_v0_rn_dev(x, a, v1, v2, v3, v4);
        const double y = kweight_y_rn_dev(b, v0, v1, v2, v3, v4);
        energy[index] = __dmul_rn(y, y);
        v4 = v3; v3 = v2; v2 = v1; v1 = v0;
        if (f + 1 == boundary || f + 1 == frames) {
            // ebur128_filter_double flushes only at the source call boundary.
            if (fabs(v1) < 2.2250738585072014e-308) v1 = 0.0;
            if (fabs(v2) < 2.2250738585072014e-308) v2 = 0.0;
            if (fabs(v3) < 2.2250738585072014e-308) v3 = 0.0;
            if (fabs(v4) < 2.2250738585072014e-308) v4 = 0.0;
            boundary += step;
        }
    }
    peak[c] = maximum;
}

extern "C" __global__ void short_source_gain_f64_kernel(
    const double *energy, const double *peak, double *gain, unsigned int frames,
    unsigned int channels, unsigned int rate, const double *hist_energies,
    const double *hist_boundaries, double target_i, double ceiling) {
    if (blockIdx.x || threadIdx.x) return;
    unsigned int hist[1000];
    for (int i = 0; i < 1000; i++) hist[i] = 0;
    const unsigned int step = (rate + 5) / 10, block = step * 4;
    for (unsigned int end = block; end <= frames; end += step) {
        double sum = 0.0;
        for (unsigned int c = 0; c < channels; c++) {
            // Default ff_ebur128 channel map used by Tdarr's af_loudnorm.
            if (c >= 6 || (channels >= 6 && c == 3)) continue;
            double channel_sum = 0.0;
            for (unsigned int f = end - block; f < end; f++)
                channel_sum = __dadd_rn(channel_sum, energy[(unsigned long long)f * channels + c]);
            if ((channels == 4 && c >= 2) || (channels == 5 && c >= 3) || (channels >= 6 && c >= 4))
                channel_sum = __dmul_rn(channel_sum, 1.41);
            sum = __dadd_rn(sum, channel_sum);
        }
        sum /= (double)block;
        if (sum >= hist_boundaries[0]) hist[hist_index_from_boundaries_dev(sum, hist_boundaries)]++;
    }
    const double global = gated_loudness_lut_boundaries_dev(hist, hist_energies, hist_boundaries);
    double maximum = 0.0;
    for (unsigned int c = 0; c < channels; c++) if (peak[c] > maximum) maximum = peak[c];
    const double offset = db_to_amp_dev(target_i - global);
    gain[0] = __dmul_rn(maximum, offset) < ceiling ? offset : ceiling / maximum;
}

extern "C" __global__ void short_source_apply_f64_kernel(
    const double *input, double *output, const double *gain, unsigned int samples) {
    const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < samples) output[i] = __dmul_rn(input[i], gain[0]);
}
