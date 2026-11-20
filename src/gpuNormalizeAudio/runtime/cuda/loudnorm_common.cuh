extern "C" __device__ double db_to_amp_dev(double db) {
    return pow(10.0, db / 20.0);
}

#define LOUDNORM_EXACT_GENERIC_LIMITER 0

extern "C" __device__ double energy_to_loudness_dev(double energy) {
    if (energy <= 0.0) return -1.0 / 0.0;
    return 10.0 * log10(energy) - 0.691;
}

extern "C" __device__ double kweight_v0_rn_dev(double x, const double *a, double v1, double v2, double v3, double v4) {
    double out = x;
    out = __dsub_rn(out, __dmul_rn(a[1], v1));
    out = __dsub_rn(out, __dmul_rn(a[2], v2));
    out = __dsub_rn(out, __dmul_rn(a[3], v3));
    out = __dsub_rn(out, __dmul_rn(a[4], v4));
    return out;
}

extern "C" __device__ double kweight_y_rn_dev(const double *b, double v0, double v1, double v2, double v3, double v4) {
    double out = __dmul_rn(b[0], v0);
    out = __dadd_rn(out, __dmul_rn(b[1], v1));
    out = __dadd_rn(out, __dmul_rn(b[2], v2));
    out = __dadd_rn(out, __dmul_rn(b[3], v3));
    out = __dadd_rn(out, __dmul_rn(b[4], v4));
    return out;
}

extern "C" __device__ double hist_energy_dev(int i) {
    return pow(10.0, (((double)i / 10.0) - 69.95 + 0.691) / 10.0);
}

extern "C" __device__ int hist_index_from_energy_dev(double energy) {
    double loud = energy_to_loudness_dev(energy);
    int idx = (int)floor((loud + 70.0) * 10.0);
    if (idx < 0) idx = 0;
    if (idx > 999) idx = 999;
    return idx;
}

extern "C" __device__ int hist_index_from_boundaries_dev(double energy, const double *boundaries) {
    int lo = 0;
    int hi = 1000;
    while (hi - lo != 1) {
        int mid = (lo + hi) / 2;
        if (energy >= boundaries[mid]) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

extern "C" __device__ double gated_loudness_dev(unsigned int *hist) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * hist_energy_dev(i);
        count += hist[i];
    }
    if (count == 0) return -1.0 / 0.0;
    double rel = (total / (double)count) * 0.1;
    int start = hist_index_from_energy_dev(rel);
    if (rel > hist_energy_dev(start) && start < 999) start++;
    double gated = 0.0;
    unsigned int gated_count = 0;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * hist_energy_dev(i);
        gated_count += hist[i];
    }
    if (gated_count == 0) return -1.0 / 0.0;
    return energy_to_loudness_dev(gated / (double)gated_count);
}

extern "C" __device__ double gated_loudness_lut_dev(unsigned int *hist, const double *energies) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0) return -1.0 / 0.0;
    double rel = (total / (double)count) * 0.1;
    int start = hist_index_from_energy_dev(rel);
    if (rel > energies[start] && start < 999) start++;
    double gated = 0.0;
    unsigned int gated_count = 0;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * energies[i];
        gated_count += hist[i];
    }
    if (gated_count == 0) return -1.0 / 0.0;
    return energy_to_loudness_dev(gated / (double)gated_count);
}

extern "C" __device__ double gated_loudness_lut_boundaries_dev(unsigned int *hist, const double *energies, const double *boundaries) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0) return -1.0 / 0.0;
    double rel = (total / (double)count) * 0.1;
    int start;
    if (rel < boundaries[0]) {
        start = 0;
    } else {
        start = hist_index_from_boundaries_dev(rel, boundaries);
        if (rel > energies[start] && start < 999) start++;
    }
    double gated = 0.0;
    unsigned int gated_count = 0;
    for (int i = start; i < 1000; i++) {
        gated += (double)hist[i] * energies[i];
        gated_count += hist[i];
    }
    if (gated_count == 0) return -1.0 / 0.0;
    return energy_to_loudness_dev(gated / (double)gated_count);
}

extern "C" __device__ double relative_threshold_dev(unsigned int *hist) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * hist_energy_dev(i);
        count += hist[i];
    }
    if (count == 0) return -70.0;
    return energy_to_loudness_dev((total / (double)count) * 0.1);
}

extern "C" __device__ double relative_threshold_lut_dev(unsigned int *hist, const double *energies) {
    double total = 0.0;
    unsigned int count = 0;
    for (int i = 0; i < 1000; i++) {
        total += (double)hist[i] * energies[i];
        count += hist[i];
    }
    if (count == 0) return -70.0;
    return energy_to_loudness_dev((total / (double)count) * 0.1);
}

extern "C" __device__ double gaussian_filter_dev(double *delta, const double *weights, int index) {
    double result = 0.0;
    index = index - 10 > 0 ? index - 10 : index + 20;
    for (int i = 0; i < 21; i++) {
        int j = index + i;
        if (j >= 30) j -= 30;
        result = __dadd_rn(result, __dmul_rn(delta[j], weights[i]));
    }
    return result;
}

extern "C" __device__ double ring_sum30_dev(const double *ring, int count, int next_index) {
    double sum = 0.0;
    if (count <= 0) return 0.0;
    if (count < 30) {
        for (int i = 0; i < count; i++) sum += ring[i];
        return sum;
    }
    int index = next_index;
    for (int i = 0; i < 30; i++) {
        sum += ring[index];
        index++;
        if (index >= 30) index = 0;
    }
    return sum;
}
