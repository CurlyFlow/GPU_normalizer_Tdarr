#ifndef AUDIO_CLOCK_IO_H
#define AUDIO_CLOCK_IO_H
#include <errno.h>
#include <stdint.h>
#include <sys/stat.h>
#include <unistd.h>
#include "libavformat/avio.h"
#include "libavutil/error.h"
#include "libavutil/mem.h"

typedef struct ClockIO { int fd; int64_t bound; } ClockIO;

static int clock_read(void *opaque, uint8_t *buffer, int size)
{
    ClockIO *file = opaque;
    ssize_t count;
    do { count = read(file->fd, buffer, size); } while (count < 0 && errno == EINTR);
    return count > 0 ? (int)count : count == 0 ? AVERROR_EOF : AVERROR(errno);
}

static int clock_write(void *opaque, const uint8_t *buffer, int size)
{
    ClockIO *file = opaque;
    off_t position = lseek(file->fd, 0, SEEK_CUR);
    if (position < 0 || size > file->bound - position) return AVERROR(EFBIG);
    for (int written = 0; written < size;) {
        ssize_t count = write(file->fd, buffer + written, size - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return AVERROR(count < 0 ? errno : EIO);
        written += (int)count;
    }
    return size;
}

static int64_t clock_seek(void *opaque, int64_t offset, int whence)
{
    ClockIO *file = opaque;
    struct stat info;
    if (whence == AVSEEK_SIZE) return fstat(file->fd, &info) ? AVERROR(errno) : info.st_size;
    off_t result = lseek(file->fd, offset, whence & ~AVSEEK_FORCE);
    return result < 0 ? AVERROR(errno) : result;
}

static void clock_free_io(AVIOContext **context)
{
    if (*context) av_freep(&(*context)->buffer);
    avio_context_free(context);
}

static int clock_unchanged(int fd, const struct stat *before)
{
    struct stat after;
    return !fstat(fd, &after) && before->st_dev == after.st_dev && before->st_ino == after.st_ino
        && before->st_size == after.st_size && before->st_mode == after.st_mode
        && before->st_nlink == after.st_nlink && before->st_mtim.tv_sec == after.st_mtim.tv_sec
        && before->st_mtim.tv_nsec == after.st_mtim.tv_nsec && before->st_ctim.tv_sec == after.st_ctim.tv_sec
        && before->st_ctim.tv_nsec == after.st_ctim.tv_nsec;
}
#endif
