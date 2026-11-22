#ifndef AUDIO_CLOCK_MUX_H
#define AUDIO_CLOCK_MUX_H
#include "libavformat/avformat.h"
#include "audio_clock_plan.h"
#define CLOCK_IO_BUF_SIZE (1024 * 1024)
int copy_clock_stream(AVFormatContext *output, const AVStream *before);
int copy_clock_chapters_and_metadata(AVFormatContext *output, const AVFormatContext *input);
int copy_clock_structure(AVFormatContext *output, const AVFormatContext *input);
int clock_output_stream(const AVFormatContext *input, unsigned index);
int clock_aac_lc(const AVCodecParameters *parameters);
int clock_retime_packet(AVPacket *packet, AVStream *input, AVStream *output, ClockTrack *track);
int clock_movie_timescale(const AVFormatContext *input, const ClockPlan *plan);
const char *clock_mux_format(const AVFormatContext *input);
int clock_has_mov_text_btrt(const AVFormatContext *output);
int clock_video_timescale(const AVFormatContext *output);
int merge_clock_audio(char **arguments);
int mux_clock_audio(char **arguments);
#endif
