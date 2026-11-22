/* Bit-exact multi-channel AAC-LC encoder built from Jellyfin FFmpeg 7.1.2. */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libswresample/swresample.h"
#include "libavutil/channel_layout.h"
#include "libavutil/dict.h"
#include "libavutil/opt.h"
#include "libavutil/samplefmt.h"

static int64_t parse_bitrate(const char *raw) {
    if (!raw || !*raw) return -1;
    char *end = NULL;
    errno = 0;
    int64_t val = strtoll(raw, &end, 10);
    if (errno || end == raw || val <= 0) return -1;
    if (*end == 'k' || *end == 'K') {
        if (end[1] != '\0') return -1;
        return val * 1000LL;
    }
    if (*end == 'm' || *end == 'M') {
        if (end[1] != '\0') return -1;
        return val * 1000000LL;
    }
    if (*end != '\0') return -1;
    return val;
}

static int read_full(int fd, uint8_t *buf, size_t max_bytes, size_t *out_bytes) {
    size_t got = 0;
    while (got < max_bytes) {
        ssize_t n = read(fd, buf + got, max_bytes - got);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) break;
        got += (size_t)n;
    }
    *out_bytes = got;
    return 0;
}

static int drain_encoder(AVCodecContext *enc, AVFormatContext *ofmt, AVStream *ost, AVPacket *pkt) {
    int ret;
    while ((ret = avcodec_receive_packet(enc, pkt)) >= 0) {
        pkt->stream_index = ost->index;
        av_packet_rescale_ts(pkt, enc->time_base, ost->time_base);
        ret = av_interleaved_write_frame(ofmt, pkt);
        av_packet_unref(pkt);
        if (ret < 0) return ret;
    }
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    return ret;
}

static int send_pcm_frame(AVCodecContext *enc, AVFormatContext *ofmt, AVStream *ost,
                          AVFrame *frame, AVPacket *pkt, int64_t *next_pts, int nb_samples) {
    frame->nb_samples = nb_samples;
    frame->pts = *next_pts;
    *next_pts += nb_samples;
    int ret = avcodec_send_frame(enc, frame);
    if (ret < 0) return ret;
    return drain_encoder(enc, ofmt, ost, pkt);
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "-version")) {
        printf("aac-encode-mt.v1 libavformat=%u libavcodec=%u libswresample=%u libavutil=%u\n",
               avformat_version(), avcodec_version(), swresample_version(), avutil_version());
        return 0;
    }

    const char *in_fmt_str = "f32le";
    const char *out_fmt_str = NULL;
    const char *out_path = NULL;
    const char *in_path = "-";
    const char *ch_layout_str = NULL;
    int in_rate = 96000;
    int out_rate = 0;
    int channels = 6;
    int64_t bitrate = 192000;
    int movie_timescale = 0;
    int threads = 1;
    int bitexact = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-f") && i + 1 < argc) in_fmt_str = argv[++i];
        else if (!strcmp(argv[i], "-of") && i + 1 < argc) out_fmt_str = argv[++i];
        else if (!strcmp(argv[i], "-i") && i + 1 < argc) in_path = argv[++i];
        else if (!strcmp(argv[i], "-o") && i + 1 < argc) out_path = argv[++i];
        else if (!strcmp(argv[i], "-ar") && i + 1 < argc) in_rate = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-out_ar") && i + 1 < argc) out_rate = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-ac") && i + 1 < argc) channels = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-channel_layout") && i + 1 < argc) ch_layout_str = argv[++i];
        else if (!strcmp(argv[i], "-b") && i + 1 < argc) bitrate = parse_bitrate(argv[++i]);
        else if (!strcmp(argv[i], "-movie_timescale") && i + 1 < argc) movie_timescale = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-threads") && i + 1 < argc) threads = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-bitexact")) bitexact = 1;
        else {
            fprintf(stderr, "aac_encode_mt: unknown arg %s\n", argv[i]);
            return 2;
        }
    }
    if (!out_path || in_rate <= 0 || channels <= 0 || channels > 16 || bitrate <= 0) {
        fprintf(stderr, "aac_encode_mt: invalid args\n");
        return 2;
    }
    if (out_rate <= 0) out_rate = in_rate;

    enum AVSampleFormat in_fmt;
    int bytes_per_sample;
    if (!strcmp(in_fmt_str, "f32le")) { in_fmt = AV_SAMPLE_FMT_FLT; bytes_per_sample = 4; }
    else if (!strcmp(in_fmt_str, "f64le")) { in_fmt = AV_SAMPLE_FMT_DBL; bytes_per_sample = 8; }
    else { fprintf(stderr, "aac_encode_mt: unsupported input format %s\n", in_fmt_str); return 2; }

    av_log_set_level(AV_LOG_ERROR);

    int in_fd = STDIN_FILENO;
    if (strcmp(in_path, "-") != 0 && strcmp(in_path, "pipe:0") != 0) {
        in_fd = open(in_path, O_RDONLY);
        if (in_fd < 0) { perror("aac_encode_mt open input"); return 1; }
    }

    const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!codec) { fprintf(stderr, "aac_encode_mt: AAC encoder not found\n"); return 1; }

    AVFormatContext *ofmt = NULL;
    if (avformat_alloc_output_context2(&ofmt, NULL, out_fmt_str, out_path) < 0 || !ofmt) {
        fprintf(stderr, "aac_encode_mt: failed to alloc output context\n");
        return 1;
    }

    AVStream *ost = avformat_new_stream(ofmt, NULL);
    AVCodecContext *enc = avcodec_alloc_context3(codec);
    if (!ost || !enc) return 1;

    AVChannelLayout ch_layout = {0};
    if (ch_layout_str && *ch_layout_str) {
        if (av_channel_layout_from_string(&ch_layout, ch_layout_str) < 0 || ch_layout.nb_channels != channels) {
            fprintf(stderr, "aac_encode_mt: invalid channel_layout %s for %d channels\n", ch_layout_str, channels);
            return 2;
        }
    } else {
        av_channel_layout_default(&ch_layout, channels);
    }
    if (av_channel_layout_copy(&enc->ch_layout, &ch_layout) < 0) return 1;

    enc->sample_rate = out_rate;
    enc->sample_fmt = AV_SAMPLE_FMT_FLTP;
    enc->bit_rate = bitrate;
    enc->time_base = (AVRational){1, out_rate};
    if (threads > 1)
        av_opt_set_int(enc->priv_data, "aac_mt_threads", threads, 0);
    if (ofmt->oformat->flags & AVFMT_GLOBALHEADER)
        enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (bitexact) {
        enc->flags |= AV_CODEC_FLAG_BITEXACT;
        ofmt->flags |= AVFMT_FLAG_BITEXACT;
    }

    if (avcodec_open2(enc, codec, NULL) < 0) {
        fprintf(stderr, "aac_encode_mt: avcodec_open2 failed\n");
        return 1;
    }
    if (avcodec_parameters_from_context(ost->codecpar, enc) < 0) return 1;
    ost->time_base = enc->time_base;

    if (!(ofmt->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&ofmt->pb, out_path, AVIO_FLAG_WRITE) < 0) {
            fprintf(stderr, "aac_encode_mt: avio_open failed for %s\n", out_path);
            return 1;
        }
    }

    AVDictionary *mux_opts = NULL;
    if (movie_timescale > 0) av_dict_set_int(&mux_opts, "movie_timescale", movie_timescale, 0);
    if (avformat_write_header(ofmt, &mux_opts) < 0) {
        fprintf(stderr, "aac_encode_mt: avformat_write_header failed\n");
        return 1;
    }
    av_dict_free(&mux_opts);

    SwrContext *swr = NULL;
    if (swr_alloc_set_opts2(&swr, &ch_layout, AV_SAMPLE_FMT_FLTP, out_rate,
                            &ch_layout, in_fmt, in_rate, 0, NULL) < 0 || !swr) {
        fprintf(stderr, "aac_encode_mt: swr_alloc failed\n");
        return 1;
    }
    if (swr_init(swr) < 0) {
        fprintf(stderr, "aac_encode_mt: swr_init failed\n");
        return 1;
    }

    const int frame_size = enc->frame_size > 0 ? enc->frame_size : 1024;
    const size_t stride = (size_t)channels * (size_t)bytes_per_sample;
    const int read_frames = 4096;
    const size_t read_buf_bytes = (size_t)read_frames * stride;
    uint8_t *in_buf = malloc(read_buf_bytes);

    AVFrame *frame = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    if (!in_buf || !frame || !pkt) return 1;

    frame->format = AV_SAMPLE_FMT_FLTP;
    frame->sample_rate = out_rate;
    frame->nb_samples = frame_size;
    av_channel_layout_copy(&frame->ch_layout, &ch_layout);
    if (av_frame_get_buffer(frame, 32) < 0) return 1;

    const int fifo_cap = 32768;
    float *fifo[16] = {0};
    for (int c = 0; c < channels; c++) {
        fifo[c] = av_malloc((size_t)fifo_cap * sizeof(float));
        if (!fifo[c]) return 1;
    }
    int fifo_len = 0;
    int64_t next_pts = 0;
    size_t carry = 0;

    int rc = 0;
    while (1) {
        size_t got = 0;
        if (read_full(in_fd, in_buf + carry, read_buf_bytes - carry, &got) < 0) {
            fprintf(stderr, "aac_encode_mt: read error\n");
            rc = 1; break;
        }
        size_t total = carry + got;
        int nb_in = (int)(total / stride);
        carry = total % stride;

        if (nb_in > 0) {
            int max_out = swr_get_out_samples(swr, nb_in);
            if (fifo_len + max_out > fifo_cap) {
                fprintf(stderr, "aac_encode_mt: fifo overflow\n");
                rc = 1; break;
            }
            uint8_t *out_ptrs[16];
            for (int c = 0; c < channels; c++) out_ptrs[c] = (uint8_t *)(fifo[c] + fifo_len);
            const uint8_t *in_ptrs[1] = { in_buf };
            int conv = swr_convert(swr, out_ptrs, max_out, in_ptrs, nb_in);
            if (conv < 0) { rc = 1; break; }
            fifo_len += conv;

            int consumed = 0;
            while (fifo_len - consumed >= frame_size) {
                if (av_frame_make_writable(frame) < 0) { rc = 1; break; }
                for (int c = 0; c < channels; c++) {
                    memcpy(frame->extended_data[c], fifo[c] + consumed, (size_t)frame_size * sizeof(float));
                }
                if (send_pcm_frame(enc, ofmt, ost, frame, pkt, &next_pts, frame_size) < 0) { rc = 1; break; }
                consumed += frame_size;
            }
            if (rc) break;
            if (consumed > 0) {
                fifo_len -= consumed;
                if (fifo_len > 0) {
                    for (int c = 0; c < channels; c++) {
                        memmove(fifo[c], fifo[c] + consumed, (size_t)fifo_len * sizeof(float));
                    }
                }
            }
        }
        if (carry > 0 && nb_in > 0) {
            memmove(in_buf, in_buf + (size_t)nb_in * stride, carry);
        }
        if (got == 0) break;
    }

    if (!rc) {
        while (1) {
            int max_out = fifo_cap - fifo_len;
            uint8_t *out_ptrs[16];
            for (int c = 0; c < channels; c++) out_ptrs[c] = (uint8_t *)(fifo[c] + fifo_len);
            int conv = swr_convert(swr, out_ptrs, max_out, NULL, 0);
            if (conv <= 0) break;
            fifo_len += conv;
            int consumed = 0;
            while (fifo_len - consumed >= frame_size) {
                if (av_frame_make_writable(frame) < 0) { rc = 1; break; }
                for (int c = 0; c < channels; c++) {
                    memcpy(frame->extended_data[c], fifo[c] + consumed, (size_t)frame_size * sizeof(float));
                }
                if (send_pcm_frame(enc, ofmt, ost, frame, pkt, &next_pts, frame_size) < 0) { rc = 1; break; }
                consumed += frame_size;
            }
            if (rc) break;
            if (consumed > 0) {
                fifo_len -= consumed;
                if (fifo_len > 0) {
                    for (int c = 0; c < channels; c++) {
                        memmove(fifo[c], fifo[c] + consumed, (size_t)fifo_len * sizeof(float));
                    }
                }
            }
        }
    }
    if (!rc && fifo_len > 0) {
        if (av_frame_make_writable(frame) < 0) rc = 1;
        else {
            for (int c = 0; c < channels; c++) {
                memcpy(frame->extended_data[c], fifo[c], (size_t)fifo_len * sizeof(float));
            }
            if (send_pcm_frame(enc, ofmt, ost, frame, pkt, &next_pts, fifo_len) < 0) rc = 1;
        }
    }
    if (!rc) {
        if (avcodec_send_frame(enc, NULL) < 0 || drain_encoder(enc, ofmt, ost, pkt) < 0) rc = 1;
    }
    if (!rc) {
        if (av_write_trailer(ofmt) < 0) rc = 1;
    }

    for (int c = 0; c < channels; c++) av_free(fifo[c]);
    free(in_buf);
    av_packet_free(&pkt);
    av_frame_free(&frame);
    swr_free(&swr);
    avcodec_free_context(&enc);
    if (!(ofmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&ofmt->pb);
    avformat_free_context(ofmt);
    av_channel_layout_uninit(&ch_layout);
    if (in_fd != STDIN_FILENO) close(in_fd);
    return rc;
}
