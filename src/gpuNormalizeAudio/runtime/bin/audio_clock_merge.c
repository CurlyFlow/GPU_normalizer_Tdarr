/* Preserve admitted encoded audio while replacing video/subtitle packets. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include "libavutil/intreadwrite.h"
#include "libavutil/mathematics.h"
#include "audio_clock_mux.h"
#include "audio_clock_plan.h"
#include "audio_clock_edits.h"
#include "audio_clock_io.h"

typedef struct MergeInput {
    AVFormatContext *format;
    AVIOContext *reader;
    AVPacket *packet;
    ClockIO io;
    struct stat identity;
    int map[CLOCK_STREAMS];
    int ended;
    uint64_t packets;
} MergeInput;

static int open_merge_input(MergeInput *input, const char *file)
{
    input->io.fd = open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (input->io.fd < 0 || fstat(input->io.fd, &input->identity) || !S_ISREG(input->identity.st_mode)
        || input->identity.st_nlink != 1 || input->identity.st_size <= 0 || input->identity.st_size > INT64_MAX / 8)
        return AVERROR(EINVAL);
    input->format = avformat_alloc_context(); input->packet = av_packet_alloc();
    if (!input->format || !input->packet) return AVERROR(ENOMEM);
    input->reader = avio_alloc_context(av_malloc(CLOCK_IO_BUF_SIZE), CLOCK_IO_BUF_SIZE, 0, &input->io, clock_read, NULL, clock_seek);
    if (!input->reader || !input->reader->buffer) return AVERROR(ENOMEM);
    input->format->pb = input->reader; input->format->flags |= AVFMT_FLAG_CUSTOM_IO;
    int result = avformat_open_input(&input->format, NULL, NULL, NULL);
    if (result < 0) return result;
    if (!input->format->nb_streams || input->format->nb_streams > CLOCK_STREAMS) return AVERROR(EINVAL);
    for (unsigned i = 0; i < CLOCK_STREAMS; i++) input->map[i] = -1;
    return 0;
}

static void close_merge_input(MergeInput *input)
{
    av_packet_free(&input->packet); avformat_close_input(&input->format); clock_free_io(&input->reader);
    if (input->io.fd >= 0) close(input->io.fd);
}

static int merge_structure(MergeInput *audio, MergeInput *video, AVFormatContext *output,
                           ClockPlan *plan, ClockTrack **tracks)
{
    int result = copy_clock_structure(output, video->format);
    if (result < 0) return result;
    unsigned ordinal = 0, source_at = 0;
    for (unsigned i = 0; i < video->format->nb_streams; i++) {
        int mapped = clock_output_stream(video->format, i);
        if (mapped < 0) continue;
        AVStream *after = output->streams[mapped];
        if (after->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) { video->map[i] = mapped; continue; }
        while (source_at < audio->format->nb_streams
               && audio->format->streams[source_at]->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) source_at++;
        if (source_at == audio->format->nb_streams || ordinal >= plan->count) return AVERROR(EINVAL);
        AVStream *before = audio->format->streams[source_at]; ClockTrack *track = &plan->tracks[ordinal++];
        const AVCodecParameters *a = before->codecpar, *b = after->codecpar;
        if (track->stream != (int)i || !clock_aac_lc(a) || !clock_aac_lc(b) || a->sample_rate != track->rate
            || a->sample_rate != b->sample_rate || av_channel_layout_compare(&a->ch_layout, &b->ch_layout)
            || a->extradata_size != b->extradata_size || memcmp(a->extradata, b->extradata, a->extradata_size))
            return AVERROR(ENOTSUP);
        if ((result = avcodec_parameters_copy(after->codecpar, a)) < 0) return result;
        after->codecpar->frame_size = 1024; after->time_base = before->time_base;
        after->disposition = before->disposition;
        av_dict_free(&after->metadata);
        if ((result = av_dict_copy(&after->metadata, before->metadata, 0)) < 0) return result;
        track->stream = mapped;
        tracks[mapped] = track; audio->map[source_at++] = mapped;
    }
    while (source_at < audio->format->nb_streams) {
        if (audio->format->streams[source_at++]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) return AVERROR(EINVAL);
    }
    return ordinal == plan->count ? 0 : AVERROR(EINVAL);
}

static int mux_structure(MergeInput *audio, MergeInput *video, AVFormatContext *output,
                         ClockPlan *plan, ClockTrack **tracks)
{
    int result;
    for (unsigned i = 0; i < video->format->nb_streams; i++) {
        if (clock_output_stream(video->format, i) < 0) continue;
        const AVStream *before = video->format->streams[i];
        if (before->codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
        if ((result = copy_clock_stream(output, before)) < 0) return result;
        video->map[i] = (int)output->nb_streams - 1;
    }
    unsigned ordinal = 0;
    for (unsigned i = 0; i < audio->format->nb_streams; i++) {
        const AVStream *before = audio->format->streams[i];
        if (before->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) return AVERROR(EINVAL);
        if (ordinal >= plan->count) return AVERROR(EINVAL);
        ClockTrack *track = &plan->tracks[ordinal++];
        if (track->stream != (int)i || !clock_aac_lc(before->codecpar)
            || before->codecpar->sample_rate != track->rate) return AVERROR(ENOTSUP);
        if ((result = copy_clock_stream(output, before)) < 0) return result;
        int mapped = (int)output->nb_streams - 1;
        track->stream = mapped;
        tracks[mapped] = track;
        audio->map[i] = mapped;
    }
    if (ordinal != plan->count) return AVERROR(EINVAL);
    for (unsigned i = 0; i < video->format->nb_streams; i++) {
        if (clock_output_stream(video->format, i) < 0) continue;
        const AVStream *before = video->format->streams[i];
        if (before->codecpar->codec_type == AVMEDIA_TYPE_VIDEO
            || before->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) continue;
        if ((result = copy_clock_stream(output, before)) < 0) return result;
        video->map[i] = (int)output->nb_streams - 1;
    }
    return copy_clock_chapters_and_metadata(output, video->format);
}

static int preserve_packet(AVPacket *packet, AVStream *stream, ClockTrack *track)
{
    if (stream->time_base.num != 1 || stream->time_base.den != track->rate) {
        fprintf(stderr, "audio-clock-merge: audio timebase=%d/%d duration=%lld rate=%d\n",
                stream->time_base.num, stream->time_base.den, (long long)packet->duration, track->rate);
        return AVERROR(EINVAL);
    }
    size_t bytes = 0;
    uint8_t *side = av_packet_get_side_data(packet, AV_PKT_DATA_SKIP_SAMPLES, &bytes);
    if (side && bytes != 10) return AVERROR(EINVAL);
    int64_t skip = side ? AV_RL32(side) : 0;
    if (!track->packets) {
        if ((skip != 0 && skip != 1024) || (__int128)packet->pts + skip != track->input_start) {
            fprintf(stderr, "audio-clock-merge: first audio PTS=%lld skip=%lld expected=%lld\n",
                    (long long)packet->pts, (long long)skip, (long long)track->input_start);
            return AVERROR(EINVAL);
        }
        track->priming = skip;
    } else if (skip) return AVERROR(EINVAL);
    /* MOV demux omits durations on CTTS paths. Carry the admitted STTS/TRUN
       duration, including the terminal partial packet, rather than guessing. */
    if (clock_packet_duration(track, &packet->duration)) return AVERROR(EINVAL);
    __int128 shift = (__int128)track->segments[0].pts - track->input_start;
    __int128 pts = packet->pts + shift, dts = packet->dts + shift;
    if (pts <= INT64_MIN || pts > INT64_MAX || dts <= INT64_MIN || dts > INT64_MAX) return AVERROR(EINVAL);
    packet->pts = (int64_t)pts; packet->dts = (int64_t)dts; track->packets++;
    return 0;
}

static int next_merge_packet(MergeInput *input, AVFormatContext *output, ClockTrack **tracks, int retime_audio)
{
    av_packet_unref(input->packet);
    int result;
    while ((result = av_read_frame(input->format, input->packet)) >= 0) {
        AVPacket *packet = input->packet;
        if (++input->packets > 100000000 || packet->stream_index < 0
            || (unsigned)packet->stream_index >= input->format->nb_streams) return AVERROR(EINVAL);
        int mapped = input->map[packet->stream_index];
        if (mapped < 0) { av_packet_unref(packet); continue; }
        if (packet->pts == AV_NOPTS_VALUE || packet->dts == AV_NOPTS_VALUE) return AVERROR(EINVAL);
        if (tracks) {
            AVStream *before = input->format->streams[packet->stream_index];
            result = retime_audio
                ? clock_retime_packet(packet, before, output->streams[mapped], tracks[mapped])
                : preserve_packet(packet, before, tracks[mapped]);
            if (result < 0) return result;
        }
        return 0;
    }
    if (result != AVERROR_EOF) return result;
    input->ended = 1; return 0;
}

static int write_merge_packets(MergeInput *audio, MergeInput *video, AVFormatContext *output,
                               ClockTrack **tracks, int retime_audio)
{
    int result = next_merge_packet(audio, output, tracks, retime_audio);
    if (result < 0 || (result = next_merge_packet(video, output, NULL, 0)) < 0) return result;
    while (!audio->ended || !video->ended) {
        MergeInput *input = audio->ended ? video : audio;
        if (!audio->ended && !video->ended
            && av_compare_ts(audio->packet->dts, audio->format->streams[audio->packet->stream_index]->time_base,
                             video->packet->dts, video->format->streams[video->packet->stream_index]->time_base) > 0) input = video;
        AVPacket *packet = input->packet; int index = packet->stream_index;
        AVStream *target = output->streams[input->map[index]];
        if (tracks[target->index] && (target->time_base.num != 1 || target->time_base.den != tracks[target->index]->rate))
            return AVERROR(EINVAL);
        av_packet_rescale_ts(packet, input->format->streams[index]->time_base, target->time_base);
        packet->stream_index = target->index; packet->pos = -1;
        if ((result = av_interleaved_write_frame(output, packet)) < 0
            || (result = next_merge_packet(input, output, input == audio ? tracks : NULL, input == audio ? retime_audio : 0)) < 0) return result;
    }
    return 0;
}

static int run_merge_or_mux(char **arguments, int retime_audio)
{
    MergeInput audio = { .io.fd = -1 }, video = { .io.fd = -1 };
    AVFormatContext *output = NULL; AVIOContext *writer = NULL; AVDictionary *options = NULL;
    ClockIO target = { .fd = -1 }; ClockPlan plan = { 0 }; ClockTrack *tracks[CLOCK_STREAMS] = { 0 };
    struct stat plan_before; int plan_fd = -1, result = AVERROR(EINVAL), timescale = 0, fragmented = 0;
    av_log_set_level(AV_LOG_WARNING);
    plan_fd = open(arguments[3], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (plan_fd < 0 || fstat(plan_fd, &plan_before) || !S_ISREG(plan_before.st_mode) || plan_before.st_nlink != 1
        || plan_before.st_uid != getuid() || (plan_before.st_mode & 077) || plan_before.st_size < 1
        || plan_before.st_size > 8 * 1024 * 1024 || load_clock_plan(plan_fd, &plan)) goto done;
    if ((result = open_merge_input(&audio, arguments[0])) < 0 || (result = open_merge_input(&video, arguments[1])) < 0) goto done;
    const char *mux_format = clock_mux_format(video.format);
    if ((result = avformat_alloc_output_context2(&output, NULL, mux_format, NULL)) < 0) goto done;
    if (!output) { result = AVERROR(ENOMEM); goto done; }
    if (!strcmp(mux_format, "mp4")) output->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;
    result = retime_audio
        ? mux_structure(&audio, &video, output, &plan, tracks)
        : merge_structure(&audio, &video, output, &plan, tracks);
    if (result < 0) goto done;
    timescale = clock_movie_timescale(output, &plan);
    if (timescale < 1) { result = AVERROR(ENOTSUP); goto done; }
    target.bound = (audio.identity.st_size + video.identity.st_size) * 2 + 67108864;
    target.fd = open(arguments[2], O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (target.fd < 0) { result = AVERROR(errno); goto done; }
    writer = avio_alloc_context(av_malloc(CLOCK_IO_BUF_SIZE), CLOCK_IO_BUF_SIZE, 1, &target, NULL, clock_write, clock_seek);
    if (!writer || !writer->buffer) { result = AVERROR(ENOMEM); goto done; }
    output->pb = writer; output->flags |= AVFMT_FLAG_CUSTOM_IO; output->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    av_dict_set(&options, "use_editlist", "1", 0); av_dict_set_int(&options, "movie_timescale", timescale, 0);
    if (clock_has_mov_text_btrt(output)) av_dict_set(&options, "write_btrt", "0", 0);
    int video_scale = clock_video_timescale(output);
    if (video_scale > 0) av_dict_set_int(&options, "video_track_timescale", video_scale, 0);
    for (unsigned i = 0; i < plan.count; i++) if (clock_requires_fragments(&plan.tracks[i])) fragmented = 1;
    if (fragmented) {
        av_dict_set(&options, "movflags", "+frag_keyframe+empty_moov+default_base_moof+delay_moov+separate_moof+use_metadata_tags", 0);
        av_dict_set(&options, "frag_duration", "500000", 0);
    } else {
        av_dict_set(&options, "movflags", "+use_metadata_tags", 0);
    }
    if ((result = avformat_write_header(output, &options)) < 0) goto done;
    if (av_dict_count(options)) { result = AVERROR(EINVAL); goto done; }
    if ((result = write_merge_packets(&audio, &video, output, tracks, retime_audio)) < 0) goto done;
    for (unsigned i = 0; i < plan.count; i++) {
        ClockTrack *track = &plan.tracks[i];
        if (!clock_packets_complete(track)) { result = AVERROR(EINVAL); goto done; }
    }
    if ((result = av_write_trailer(output)) < 0) goto done;
    avio_flush(writer);
    if (writer->error < 0) { result = writer->error; goto done; }
    if (preserve_clock_windows(target.fd, &plan, timescale, !retime_audio)) { result = AVERROR(ENOTSUP); goto done; }
    if (fsync(target.fd) || !clock_unchanged(audio.io.fd, &audio.identity) || !clock_unchanged(video.io.fd, &video.identity)
        || !clock_unchanged(plan_fd, &plan_before)) result = AVERROR(EIO);
done:
    if (result < 0) {
        char text[AV_ERROR_MAX_STRING_SIZE]; av_strerror(result, text, sizeof(text));
        fprintf(stderr, "%s: %s\n", retime_audio ? "audio-clock-mux-audio" : "audio-clock-merge", text);
    }
    av_dict_free(&options); avformat_free_context(output); clock_free_io(&writer); free_clock_plan(&plan);
    close_merge_input(&audio); close_merge_input(&video);
    if (target.fd >= 0) close(target.fd);
    if (plan_fd >= 0) close(plan_fd);
    return result < 0;
}

int merge_clock_audio(char **arguments) { return run_merge_or_mux(arguments, 0); }
int mux_clock_audio(char **arguments) { return run_merge_or_mux(arguments, 1); }
