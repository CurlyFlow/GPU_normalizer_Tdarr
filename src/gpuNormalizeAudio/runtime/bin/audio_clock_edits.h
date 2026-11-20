#ifndef AUDIO_CLOCK_EDITS_H
#define AUDIO_CLOCK_EDITS_H
#include "audio_clock_plan.h"
int preserve_clock_windows(int fd, const ClockPlan *plan, int movie_scale, int preservation);
#endif
