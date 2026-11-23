#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "audio_clock_plan.h"

static int numbers(FILE *file, int64_t *values, unsigned count)
{
    char line[256], *cursor;
    if (!fgets(line, sizeof(line), file) || !strchr(line, '\n')) return -1;
    cursor = line;
    for (unsigned i = 0; i < count; i++) {
        char *end;
        if (!(*cursor >= '0' && *cursor <= '9') && *cursor != '-') return -1;
        errno = 0;
        values[i] = strtoll(cursor, &end, 10);
        if (errno || end == cursor || values[i] == INT64_MIN) return -1;
        if (*end != (i + 1 == count ? '\n' : ' ')) return -1;
        cursor = end + 1;
    }
    return *cursor ? -1 : 0;
}

int load_clock_plan(int fd, ClockPlan *plan)
{
    int copy = dup(fd);
    if (copy < 0) return -1;
    FILE *file = fdopen(copy, "r");
    if (!file) { close(copy); return -1; }
    char header[64];
    int result = -1, previous = -1;
    int64_t row[6], total = 0, duration_rows = 0;
    if (!fgets(header, sizeof(header), file) || strcmp(header, "audio-clock-plan.v1\n")
        || numbers(file, row, 1) || row[0] < 1 || row[0] > CLOCK_TRACKS) goto done;
    plan->count = (unsigned)row[0];
    for (unsigned i = 0; i < plan->count; i++) {
        ClockTrack *track = &plan->tracks[i];
        if (numbers(file, row, 6) || row[0] <= previous || row[0] >= CLOCK_STREAMS
            || row[1] < 8000 || row[1] > 192000 || row[2] <= 0 || row[2] % 1024
            || row[4] < 0 || row[4] > INT32_MAX || row[5] < 1
            || row[5] > CLOCK_SEGMENTS - total) goto done;
        track->stream = previous = (int)row[0]; track->rate = (int)row[1];
        track->samples = row[2]; track->input_start = row[3]; track->lead = row[4]; track->count = row[5];
        total += track->count;
        track->segments = calloc((size_t)track->count, sizeof(*track->segments));
        if (!track->segments) goto done;
        int64_t prior = -1, required_lead = 0;
        for (int64_t n = 0; n < track->count; n++) {
            if (numbers(file, row, 2) || row[0] <= prior || row[0] >= track->samples || row[0] % 1024) goto done;
            track->segments[n] = (ClockSegment){ row[0], row[1] }; prior = row[0];
            __int128 delta = (__int128)row[1] - track->segments[0].pts - row[0];
            if (delta < -INT32_MAX || delta > INT32_MAX
                || delta < -(__int128)(row[0] / 1024) * 512) goto done;
            if (-delta > required_lead) required_lead = (int64_t)-delta;
        }
        if (track->segments[0].sample || required_lead != track->lead) goto done;
        for (int64_t n = 0; n < track->count; n++) {
            __int128 composition = (__int128)track->segments[n].pts - track->segments[0].pts
                - track->segments[n].sample + track->lead;
            if (composition < 0 || composition > INT32_MAX) goto done;
        }
        {
            if (numbers(file, row, 1) || row[0] < 1 || row[0] > CLOCK_SEGMENTS - duration_rows) goto done;
            track->duration_count = row[0]; duration_rows += row[0];
            track->durations = calloc((size_t)row[0], sizeof(*track->durations));
            if (!track->durations) goto done;
            int64_t samples = 0;
            for (int64_t n = 0; n < track->duration_count; n++) {
                if (numbers(file, row, 2) || row[0] < 1 || row[0] > 10000000 - samples || row[1] < 1 || row[1] > 1024) goto done;
                track->durations[n] = (ClockDuration){ row[0], row[1] }; samples += row[0];
            }
            if (samples * INT64_C(1024) != track->samples && samples * INT64_C(1024) != track->samples + 1024) goto done;
        }
        if (numbers(file, row, 2) || row[1] < 1 || row[1] > INT32_MAX) goto done;
        track->end_num = row[0]; track->end_den = row[1];
    }
    if (fgetc(file) == EOF && !ferror(file)) result = 0;
done:
    fclose(file);
    return result;
}

int clock_packet_duration(ClockTrack *track, int64_t *duration)
{
    if (!track->duration_left) {
        if (track->packets) track->duration_active++;
        if (track->duration_active >= track->duration_count) return -1;
        track->duration_left = track->durations[track->duration_active].count;
    }
    *duration = track->durations[track->duration_active].duration;
    track->duration_left--;
    return 0;
}

int clock_packets_complete(const ClockTrack *track)
{
    return (__int128)track->packets * 1024 - track->priming == track->samples
        && !track->duration_left && track->duration_active + 1 == track->duration_count;
}

int clock_requires_fragments(const ClockTrack *track)
{
    /* A flat edit discards packets starting at or beyond its endpoint. Keep
       complete coded tails without inventing a source-clock discontinuity.
       A single segment's uniform output translation cancels on both sides. */
    __int128 last_start = (__int128)track->input_start + track->samples - 1024;
    return track->count > 1
        || last_start * track->end_den >= (__int128)track->end_num * track->rate;
}

void free_clock_plan(ClockPlan *plan)
{
    for (unsigned i = 0; i < plan->count; i++) {
        free(plan->tracks[i].segments); free(plan->tracks[i].durations);
    }
}

int retime_clock_packet(ClockTrack *track, int64_t pts, int64_t dts,
                       int64_t duration, int64_t skip, int64_t *out_pts, int64_t *out_dts)
{
    if (!track->packets) {
        __int128 priming = (__int128)track->input_start - pts;
        if ((priming != 0 && priming != 1024) || priming != skip) return -1;
        track->priming = (int64_t)priming;
    } else if (skip) return -1;
    __int128 sample = (__int128)track->packets * 1024 - track->priming;
    if (sample >= track->samples || sample + track->input_start != pts || pts != dts
        || duration < 1 || duration > 1024) return -1;
    while (track->active + 1 < (unsigned)track->count && sample >= track->segments[track->active + 1].sample) track->active++;
    ClockSegment segment = track->segments[track->active];
    __int128 presentation = sample + segment.pts - segment.sample;
    __int128 lead = (__int128)track->packets * 512;
    if (lead > track->lead) lead = track->lead;
    __int128 decode = sample + track->segments[0].pts - lead;
    if (presentation < decode || presentation - decode > INT32_MAX
        || presentation <= INT64_MIN || presentation > INT64_MAX
        || decode <= INT64_MIN || decode > INT64_MAX) return -1;
    *out_pts = (int64_t)presentation; *out_dts = (int64_t)decode;
    track->packets++;
    return 0;
}
