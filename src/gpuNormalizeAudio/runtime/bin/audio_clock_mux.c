/* Packet-copy transport only. No decoder, encoder, filter or audio arithmetic. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "libavformat/avformat.h"
#include "libavcodec/avcodec.h"
#include "libavutil/intreadwrite.h"
#include "libavutil/mathematics.h"
#include "audio_clock_plan.h"
#include "audio_clock_edits.h"
#include "audio_clock_io.h"
#include "audio_clock_mux.h"

int clock_output_stream(const AVFormatContext *input, unsigned index)
{
    if (index >= input->nb_streams) return -1;
    int output = 0;
    for (unsigned i = 0; i <= index; i++) {
        const AVCodecParameters *parameters = input->streams[i]->codecpar;
        int chapter = input->nb_chapters && parameters->codec_type == AVMEDIA_TYPE_DATA
            && parameters->codec_id == AV_CODEC_ID_BIN_DATA && parameters->codec_tag == MKTAG('t', 'e', 'x', 't');
        if (i == index) return chapter ? -1 : output;
        if (!chapter) output++;
    }
    return -1;
}

int copy_clock_stream(AVFormatContext *output, const AVStream *before)
{
    int result;
    AVStream *after = avformat_new_stream(output, NULL);
    if (!after) return AVERROR(ENOMEM);
    if ((result = avcodec_parameters_copy(after->codecpar, before->codecpar)) < 0) return result;
    if (clock_aac_lc(before->codecpar)) {
        if (before->codecpar->frame_size && before->codecpar->frame_size != 1024) return AVERROR(ENOTSUP);
        after->codecpar->frame_size = 1024;
    }
    after->codecpar->codec_tag = before->codecpar->codec_tag;
    after->time_base = before->time_base; after->sample_aspect_ratio = before->sample_aspect_ratio;
    if (!after->codecpar->sample_aspect_ratio.num && before->sample_aspect_ratio.num) {
        after->codecpar->sample_aspect_ratio = before->sample_aspect_ratio;
    }
    after->avg_frame_rate = before->avg_frame_rate; after->disposition = before->disposition;
    if (before->disposition & AV_DISPOSITION_ATTACHED_PIC) return AVERROR(ENOTSUP);
    return av_dict_copy(&after->metadata, before->metadata, 0);
}

int copy_clock_chapters_and_metadata(AVFormatContext *output, const AVFormatContext *input)
{
    int result;
    if (input->nb_chapters > 100000) return AVERROR(EINVAL);
    if (input->nb_chapters) {
        output->chapters = av_calloc(input->nb_chapters, sizeof(*output->chapters));
        if (!output->chapters) return AVERROR(ENOMEM);
        for (unsigned i = 0; i < input->nb_chapters; i++) {
            const AVChapter *before = input->chapters[i];
            AVChapter *after = av_mallocz(sizeof(*after));
            if (!after) return AVERROR(ENOMEM);
            output->chapters[output->nb_chapters++] = after;
            after->id = before->id; after->time_base = before->time_base;
            after->start = before->start; after->end = before->end;
            if ((result = av_dict_copy(&after->metadata, before->metadata, 0)) < 0) return result;
        }
    }
    return av_dict_copy(&output->metadata, input->metadata, 0);
}

int copy_clock_structure(AVFormatContext *output, const AVFormatContext *input)
{
    int result;
    for (unsigned i = 0; i < input->nb_streams; i++) {
        /* MOV regenerates its text carrier from the complete chapter table. */
        if (clock_output_stream(input, i) < 0) continue;
        if ((result = copy_clock_stream(output, input->streams[i])) < 0) return result;
    }
    return copy_clock_chapters_and_metadata(output, input);
}

int clock_retime_packet(AVPacket *packet, AVStream *input, AVStream *output, ClockTrack *track)
{
    if (input->time_base.num != 1 || input->time_base.den != track->rate
        || output->time_base.num != 1 || output->time_base.den != track->rate) return AVERROR(EINVAL);
    size_t size = 0;
    uint8_t *side = av_packet_get_side_data(packet, AV_PKT_DATA_SKIP_SAMPLES, &size);
    if (side && size != 10) return AVERROR(EINVAL);
    int64_t skip = side ? AV_RL32(side) : 0;
    int64_t pts, dts;
    if (clock_packet_duration(track, &packet->duration)) return AVERROR(EINVAL);
    if (retime_clock_packet(track, packet->pts, packet->dts, packet->duration, skip, &pts, &dts)) return AVERROR(EINVAL);
    packet->pts = pts; packet->dts = dts;
    return 0;
}

int clock_aac_lc(const AVCodecParameters *parameters)
{
    if (parameters->codec_id != AV_CODEC_ID_AAC || parameters->extradata_size < 2) return 0;
    const uint8_t *data = parameters->extradata;
    if ((data[0] >> 3) != 2) return 0;
    unsigned frequency = ((data[0] & 7) << 1) | (data[1] >> 7);
    unsigned flag_byte = frequency == 15 ? 4 : 1;
    return parameters->extradata_size > (int)flag_byte && !(data[flag_byte] & 4);
}

int clock_movie_timescale(const AVFormatContext *input, const ClockPlan *plan)
{
    int64_t scale = 1;
    for (unsigned i = 0; i < input->nb_streams + input->nb_chapters; i++) {
        AVRational base = i < input->nb_streams ? input->streams[i]->time_base
            : input->chapters[i - input->nb_streams]->time_base;
        if (base.num <= 0 || base.den <= 0) return -1;
        __int128 next = (__int128)(scale / av_gcd(scale, base.den)) * base.den;
        if (next > INT32_MAX) return -1;
        scale = (int64_t)next;
    }
    for (unsigned i = 0; i < plan->count; i++) {
        int64_t denominator = plan->tracks[i].end_den;
        __int128 next = (__int128)(scale / av_gcd(scale, denominator)) * denominator;
        if (next > INT32_MAX) return -1;
        scale = (int64_t)next;
    }
    return (int)scale;
}

const char *clock_mux_format(const AVFormatContext *input)
{
    const AVDictionaryEntry *brand = av_dict_get(input->metadata, "major_brand", NULL, 0);
    /* QuickTime's video vendor field becomes reserved zero bytes in MP4. */
    return brand && !strcmp(brand->value, "qt  ") ? "mov" : "mp4";
}

int clock_has_mov_text_btrt(const AVFormatContext *output)
{
    for (unsigned i = 0; i < output->nb_streams; i++) {
        const AVCodecParameters *p = output->streams[i]->codecpar;
        if (p->codec_id == AV_CODEC_ID_MOV_TEXT && p->extradata_size >= 20
            && AV_RB32(p->extradata + p->extradata_size - 20) == 20
            && !memcmp(p->extradata + p->extradata_size - 16, "btrt", 4)) return 1;
    }
    return 0;
}

int clock_video_timescale(const AVFormatContext *output)
{
    int scale = 0;
    for (unsigned i = 0; i < output->nb_streams; i++) {
        const AVStream *st = output->streams[i];
        if (st->codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
        if (st->time_base.num != 1 || st->time_base.den <= 0 || st->time_base.den >= 10000) return 0;
        if (scale && scale != st->time_base.den) return 0;
        scale = st->time_base.den;
    }
    return scale;
}

int main(int argc, char **argv)
{
    void *iterator = NULL;
    const AVCodec *codec;
    while ((codec = av_codec_iterate(&iterator))) {
        if (av_codec_is_decoder(codec) || av_codec_is_encoder(codec)) return 2;
    }
    if (argc == 2 && !strcmp(argv[1], "-version")) {
        printf("audio-clock-mux.v1 libavformat=%u libavcodec=%u libavutil=%u decoders=0 encoders=0\n",
               avformat_version(), avcodec_version(), avutil_version());
        return 0;
    }
    if (avformat_version() != LIBAVFORMAT_VERSION_INT
        || avcodec_version() != LIBAVCODEC_VERSION_INT || avutil_version() != LIBAVUTIL_VERSION_INT) return 2;
    if (argc == 6 && !strcmp(argv[1], "--preserve-audio")) return merge_clock_audio(argv + 2);
    if (argc == 6 && !strcmp(argv[1], "--mux-audio")) return mux_clock_audio(argv + 2);
    if (argc != 4) return 2;
    AVFormatContext *input = NULL, *output = NULL;
    AVIOContext *reader = NULL, *writer = NULL;
    AVPacket *packet = NULL;
    AVDictionary *options = NULL;
    ClockPlan plan = { 0 };
    ClockTrack *tracks[CLOCK_STREAMS] = { 0 };
    int stream_map[CLOCK_STREAMS];
    ClockIO source = { .fd = -1 }, target = { .fd = -1 };
    struct stat original, plan_before;
    int plan_fd = -1, result = AVERROR(EINVAL), fragmented = 0;
    uint64_t packets = 0;
    av_log_set_level(AV_LOG_WARNING);
    plan_fd = open(argv[3], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (plan_fd < 0 || fstat(plan_fd, &plan_before) || !S_ISREG(plan_before.st_mode)
        || plan_before.st_nlink != 1 || plan_before.st_uid != getuid() || (plan_before.st_mode & 077)
        || plan_before.st_size < 1 || plan_before.st_size > 8 * 1024 * 1024 || load_clock_plan(plan_fd, &plan)) goto done;
    source.fd = open(argv[1], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (source.fd < 0 || fstat(source.fd, &original) || !S_ISREG(original.st_mode)
        || original.st_nlink != 1 || original.st_size <= 0 || original.st_size > INT64_MAX / 4) goto done;
    target.bound = original.st_size * 2 + 64 * INT64_C(1024) * 1024;
    input = avformat_alloc_context();
    if (!input) { result = AVERROR(ENOMEM); goto done; }
    reader = avio_alloc_context(av_malloc(CLOCK_IO_BUF_SIZE), CLOCK_IO_BUF_SIZE, 0, &source, clock_read, NULL, clock_seek);
    if (!reader || !reader->buffer) { result = AVERROR(ENOMEM); goto done; }
    input->pb = reader; input->flags |= AVFMT_FLAG_CUSTOM_IO;
    if ((result = avformat_open_input(&input, NULL, NULL, NULL)) < 0) goto done;
    if (!input->nb_streams || input->nb_streams > CLOCK_STREAMS) { result = AVERROR(EINVAL); goto done; }
    for (unsigned i = 0; i < input->nb_streams; i++) stream_map[i] = clock_output_stream(input, i);
    for (unsigned i = 0; i < plan.count; i++) {
        ClockTrack *track = &plan.tracks[i];
        if ((unsigned)track->stream >= input->nb_streams) { result = AVERROR(EINVAL); goto done; }
        const AVCodecParameters *parameters = input->streams[track->stream]->codecpar;
        if (parameters->codec_type != AVMEDIA_TYPE_AUDIO || !clock_aac_lc(parameters) || parameters->sample_rate != track->rate) {
            result = AVERROR(ENOTSUP); goto done;
        }
        tracks[track->stream] = track;
        track->stream = stream_map[track->stream];
        if (track->stream < 0) { result = AVERROR(EINVAL); goto done; }
        if (clock_requires_fragments(track)) fragmented = 1;
    }
    if ((result = avformat_alloc_output_context2(&output, NULL, clock_mux_format(input), NULL)) < 0) goto done;
    if (!output) { result = AVERROR(ENOMEM); goto done; }
    if ((result = copy_clock_structure(output, input)) < 0) goto done;
    output->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED; output->flags |= AVFMT_FLAG_CUSTOM_IO;
    target.fd = open(argv[2], O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (target.fd < 0) { result = AVERROR(errno); goto done; }
    writer = avio_alloc_context(av_malloc(CLOCK_IO_BUF_SIZE), CLOCK_IO_BUF_SIZE, 1, &target, NULL, clock_write, clock_seek);
    if (!writer || !writer->buffer) { result = AVERROR(ENOMEM); goto done; }
    output->pb = writer;
    av_dict_set(&options, "use_editlist", "1", 0);
    if (clock_has_mov_text_btrt(output)) av_dict_set(&options, "write_btrt", "0", 0);
    int video_scale = clock_video_timescale(output);
    if (video_scale > 0) av_dict_set_int(&options, "video_track_timescale", video_scale, 0);
    int timescale = clock_movie_timescale(input, &plan);
    if (timescale < 1) { result = AVERROR(ENOTSUP); goto done; }
    av_dict_set_int(&options, "movie_timescale", timescale, 0);
    // Starts alone need normal edits. Fragments preserve actual discontinuities
    // or coded packets excluded by the admitted presentation endpoint.
    if (fragmented) {
        /* One traf per moof makes the muxer's 1/1/1 TFRA coordinates exact. */
        av_dict_set(&options, "movflags", "+frag_keyframe+empty_moov+default_base_moof+delay_moov+separate_moof", 0);
        av_dict_set(&options, "frag_duration", "500000", 0);
    }
    if ((result = avformat_write_header(output, &options)) < 0) goto done;
    if (av_dict_count(options)) { result = AVERROR(EINVAL); goto done; }
    packet = av_packet_alloc();
    if (!packet) { result = AVERROR(ENOMEM); goto done; }
    while ((result = av_read_frame(input, packet)) >= 0) {
        if (++packets > 10000000 || packet->stream_index < 0 || (unsigned)packet->stream_index >= input->nb_streams) {
            result = AVERROR(EINVAL); goto done;
        }
        int index = packet->stream_index;
        int mapped = stream_map[index];
        if (mapped < 0) { av_packet_unref(packet); continue; }
        if (packet->pts == AV_NOPTS_VALUE || packet->dts == AV_NOPTS_VALUE) { result = AVERROR(EINVAL); goto done; }
        AVStream *before = input->streams[index], *after = output->streams[mapped];
        if (tracks[index] && (result = clock_retime_packet(packet, before, after, tracks[index])) < 0) goto done;
        av_packet_rescale_ts(packet, before->time_base, after->time_base);
        packet->stream_index = mapped;
        packet->pos = -1;
        /* Payload and skip/discard remain untouched; duration is admitted STTS. */
        result = av_interleaved_write_frame(output, packet);
        av_packet_unref(packet);
        if (result < 0) goto done;
    }
    if (result != AVERROR_EOF || !packets) goto done;
    for (unsigned i = 0; i < plan.count; i++) {
        ClockTrack *track = &plan.tracks[i];
        if (!clock_packets_complete(track)) { result = AVERROR(EINVAL); goto done; }
    }
    if ((result = av_write_trailer(output)) < 0) goto done;
    avio_flush(writer);
    if (writer->error < 0) { result = writer->error; goto done; }
    if (preserve_clock_windows(target.fd, &plan, timescale, 0)) { result = AVERROR(ENOTSUP); goto done; }
    result = fsync(target.fd) || !clock_unchanged(source.fd, &original) || !clock_unchanged(plan_fd, &plan_before)
        ? AVERROR(EIO) : 0;
done:
    if (result < 0) {
        char message[AV_ERROR_MAX_STRING_SIZE]; av_strerror(result, message, sizeof(message));
        fprintf(stderr, "audio-clock-mux: %s\n", message);
    }
    av_dict_free(&options); av_packet_free(&packet); avformat_close_input(&input); avformat_free_context(output);
    clock_free_io(&reader); clock_free_io(&writer); free_clock_plan(&plan);
    if (source.fd >= 0) close(source.fd);
    if (target.fd >= 0) close(target.fd);
    if (plan_fd >= 0) close(plan_fd);
    return result < 0;
}
