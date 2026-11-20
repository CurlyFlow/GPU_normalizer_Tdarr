#ifndef AUDIO_CLOCK_MUX_H
#define AUDIO_CLOCK_MUX_H
#include "libavformat/avformat.h"
#include "audio_clock_plan.h"
int copy_clock_structure(AVFormatContext *output, const AVFormatContext *input);
int clock_output_stream(const AVFormatContext *input, unsigned index);
int clock_aac_lc(const AVCodecParameters *parameters);
int clock_movie_timescale(const AVFormatContext *input, const ClockPlan *plan);
const char *clock_mux_format(const AVFormatContext *input);
int merge_clock_audio(char **arguments);
#endif
