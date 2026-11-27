#ifndef AUDIO_CLOCK_PLAN_H
#define AUDIO_CLOCK_PLAN_H
#include <stdint.h>

#define CLOCK_TRACKS 128
#define CLOCK_STREAMS 256
#define CLOCK_SEGMENTS 100000

typedef struct ClockSegment { int64_t sample, pts; } ClockSegment;
typedef struct ClockDuration { int64_t count, duration; } ClockDuration;
typedef struct ClockTrack {
    int stream, rate;
    int64_t samples, input_start, lead, count;
    ClockSegment *segments;
    uint64_t packets;
    int64_t priming;
    unsigned active;
    ClockDuration *durations;
    int64_t duration_count, duration_active, duration_left;
    int64_t end_num, end_den;
} ClockTrack;
typedef struct ClockPlan { unsigned count; ClockTrack tracks[CLOCK_TRACKS]; } ClockPlan;

int load_clock_plan(int fd, ClockPlan *plan);
int clock_packet_duration(ClockTrack *track, int64_t *duration);
int clock_packets_complete(const ClockTrack *track);
int clock_requires_fragments(const ClockTrack *track);
void free_clock_plan(ClockPlan *plan);
int retime_clock_packet(ClockTrack *track, int64_t pts, int64_t dts,
                       int64_t duration, int64_t skip, int64_t *out_pts, int64_t *out_dts);
#endif
