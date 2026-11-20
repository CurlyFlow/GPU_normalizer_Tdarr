/* Keep admitted skip counts and rational presentation endpoints in MOV edits.
 * No packet/sample bytes or timestamps are changed here. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "audio_clock_edits.h"

typedef struct Box { int64_t start, end; } Box;

static int bytes(int fd, int64_t at, uint8_t *data, unsigned count, int write)
{
    for (unsigned done = 0; done < count;) {
        ssize_t result = write ? pwrite(fd, data + done, count - done, at + done)
            : pread(fd, data + done, count - done, at + done);
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) return -1;
        done += (unsigned)result;
    }
    return 0;
}

static int integer(int fd, Box box, int64_t at, unsigned width, int64_t *value, int write)
{
    uint8_t data[8];
    if (at < box.start || at > box.end - width || (width != 4 && width != 8)) return -1;
    if (write) {
        if (*value < 0 || (width == 4 && *value > UINT32_MAX)) return -1;
        uint64_t n = (uint64_t)*value;
        for (unsigned i = width; i; i--) { data[i - 1] = n & 255; n >>= 8; }
    }
    if (bytes(fd, at, data, width, write)) return -1;
    if (!write) {
        uint64_t n = 0;
        for (unsigned i = 0; i < width; i++) n = n * 256 + data[i];
        if (n > INT64_MAX) return -1;
        *value = (int64_t)n;
    }
    return 0;
}

static int next_box(int fd, Box parent, int64_t *at, char type[4], Box *result)
{
    if (*at == parent.end) return 0;
    uint8_t header[8];
    int64_t size, width = 8;
    if (*at < parent.start || *at > parent.end - 8 || bytes(fd, *at, header, 8, 0)
        || integer(fd, parent, *at, 4, &size, 0)) return -1;
    memcpy(type, header + 4, 4);
    if (size == 1) { width = 16; if (integer(fd, parent, *at + 8, 8, &size, 0)) return -1; }
    else if (!size) size = parent.end - *at;
    if (size < width || size > parent.end - *at) return -1;
    *result = (Box){ *at + width, *at + size }; *at += size;
    return 1;
}

static int one_box(int fd, Box parent, const char *name, Box *result)
{
    int found = 0, status;
    int64_t at = parent.start;
    char type[4]; Box current;
    unsigned count = 0;
    while ((status = next_box(fd, parent, &at, type, &current)) > 0) {
        if (++count > 1000000) return -1;
        if (!memcmp(type, name, 4)) { if (found++) return -1; *result = current; }
    }
    return status < 0 || found != 1 ? -1 : 0;
}

static int patch_edit(int fd, Box track, const ClockTrack *clock, int scale)
{
    Box edts, edit;
    if (one_box(fd, track, "edts", &edts) || one_box(fd, edts, "elst", &edit)) return -1;
    int64_t full, count, delay, media, duration, rate;
    if (integer(fd, edit, edit.start, 4, &full, 0) || (full != 0 && full != 0x01000000)
        || integer(fd, edit, edit.start + 4, 4, &count, 0) || count != 2) return -1;
    unsigned width = full ? 8 : 4, row = 2 * width + 4;
    int64_t first = edit.start + 8, second = first + row;
    if (second + row != edit.end || integer(fd, edit, first, width, &delay, 0)
        || integer(fd, edit, second, width, &duration, 0)
        || integer(fd, edit, second + width, width, &media, 0) || media != 0
        || integer(fd, edit, first + 2 * width, 4, &rate, 0) || rate != 65536
        || integer(fd, edit, second + 2 * width, 4, &rate, 0) || rate != 65536) return -1;
    uint8_t empty[8];
    if (bytes(fd, first + width, empty, width, 0)) return -1;
    for (unsigned i = 0; i < width; i++) if (empty[i] != 255) return -1;
    __int128 expected = ((__int128)clock->segments[0].pts - clock->priming) * scale;
    __int128 skip = (__int128)clock->priming * scale;
    if (expected % clock->rate || skip % clock->rate || expected / clock->rate != delay) return -1;
    if (duration && duration <= skip / clock->rate) return -1;
    delay += (int64_t)(skip / clock->rate); media = clock->priming;
    if (duration) duration -= (int64_t)(skip / clock->rate);
    return integer(fd, edit, first, width, &delay, 1)
        || integer(fd, edit, second, width, &duration, 1)
        || integer(fd, edit, second + width, width, &media, 1) ? -1 : 0;
}

static int header_duration(int fd, Box header, int track, int64_t *at, unsigned *width)
{
    int64_t full;
    if (integer(fd, header, header.start, 4, &full, 0) || (full >> 24) > 1) return -1;
    *width = (full >> 24) ? 8 : 4;
    *at = header.start + (track ? (*width == 8 ? 28 : 20) : (*width == 8 ? 24 : 16));
    return 0;
}

static int patch_window(int fd, Box track, Box header, const ClockTrack *clock, int scale, int preservation)
{
    Box edts, edit;
    int64_t full, count, delay = 0, media, rate;
    if (one_box(fd, track, "edts", &edts) || one_box(fd, edts, "elst", &edit)
        || integer(fd, edit, edit.start, 4, &full, 0) || (full != 0 && full != 0x01000000)
        || integer(fd, edit, edit.start + 4, 4, &count, 0) || count < 1 || count > 2) return -1;
    unsigned width = full ? 8 : 4, row = 2 * width + 4;
    int64_t first = edit.start + 8, last = first + (count - 1) * row;
    if (last + row != edit.end || integer(fd, edit, last + width, width, &media, 0)
        || media != clock->priming || integer(fd, edit, last + 2 * width, 4, &rate, 0) || rate != 65536) return -1;
    if (count == 2) {
        uint8_t empty[8];
        if (integer(fd, edit, first, width, &delay, 0) || !delay
            || bytes(fd, first + width, empty, width, 0)
            || integer(fd, edit, first + 2 * width, 4, &rate, 0) || rate != 65536) return -1;
        for (unsigned i = 0; i < width; i++) if (empty[i] != 255) return -1;
    }
    const ClockSegment *tail = &clock->segments[preservation ? 0 : clock->count - 1];
    __int128 shift = (__int128)tail->pts - (preservation ? 0 : tail->sample) - clock->input_start;
    if (scale % clock->end_den || scale % clock->rate) return -1;
    __int128 endpoint = (__int128)clock->end_num * (scale / clock->end_den) + shift * (scale / clock->rate);
    if (endpoint <= delay || endpoint > INT64_MAX) return -1;
    int64_t duration = (int64_t)endpoint - delay, at; unsigned header_width;
    if (integer(fd, edit, last, width, &duration, 1) || header_duration(fd, header, 1, &at, &header_width)) return -1;
    duration = (int64_t)endpoint;
    return integer(fd, header, at, header_width, &duration, 1);
}

int preserve_clock_windows(int fd, const ClockPlan *plan, int movie_scale, int preservation)
{
    struct stat info;
    Box movie;
    if (fstat(fd, &info) || one_box(fd, (Box){ 0, info.st_size }, "moov", &movie)) return -1;
    uint8_t matched[CLOCK_TRACKS] = { 0 };
    unsigned total = 0, boxes = 0;
    int64_t at = movie.start, maximum = 0;
    char type[4]; Box track;
    int status;
    while ((status = next_box(fd, movie, &at, type, &track)) > 0) {
        if (++boxes > 1000000) return -1;
        if (memcmp(type, "trak", 4)) continue;
        Box header; int64_t full, id;
        if (one_box(fd, track, "tkhd", &header) || integer(fd, header, header.start, 4, &full, 0)
            || (full >> 24) > 1 || integer(fd, header, header.start + ((full >> 24) ? 20 : 12), 4, &id, 0)) return -1;
        for (unsigned i = 0; i < plan->count; i++) {
            const ClockTrack *clock = &plan->tracks[i];
            if (id != clock->stream + 1) continue;
            if (matched[i]++) return -1;
            if ((clock->priming && clock->segments[0].pts > 0
                 && patch_edit(fd, track, clock, movie_scale))
                || patch_window(fd, track, header, clock, movie_scale, preservation)) return -1;
            total++;
        }
        int64_t duration_at, duration; unsigned width;
        if (header_duration(fd, header, 1, &duration_at, &width)
            || integer(fd, header, duration_at, width, &duration, 0)) return -1;
        if (duration > maximum) maximum = duration;
    }
    if (status < 0 || total != plan->count) return -1;
    Box header; int64_t duration_at, duration; unsigned width;
    if (one_box(fd, movie, "mvhd", &header) || header_duration(fd, header, 0, &duration_at, &width)
        || integer(fd, header, duration_at, width, &duration, 0)) return -1;
    /* Fragmented movies retain their unknown overall duration; finite tracks
       still carry the exact admitted edit endpoint. */
    return duration ? integer(fd, header, duration_at, width, &maximum, 1) : 0;
}
