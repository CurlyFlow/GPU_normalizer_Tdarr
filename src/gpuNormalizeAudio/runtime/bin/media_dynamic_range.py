"""Positive dynamic-range descriptors, separate from playback admission.

Dolby Vision Profiles and Levels v1.2.92, tables 1 and 8: profile 7 / BL
compatibility 6 is UHD Blu-ray HDR; profile 8 / compatibility 1 is HDR10.
A compatibility flag alone is insufficient: require matching HEVC Main10
signal metadata and actual decoded base-layer samples before naming a fallback.
This is bounded naming evidence, not full-file or Dolby device certification.

When the container omits its configuration record, FFmpeg's
ff_dovi_guess_profile_hevc identifies profiles 7 and 8 from parsed RPU headers.
Require that exact header and the same independently decoded HDR base evidence.
"""


def decoded_hdr_base(video, frames):
    samples = [frame for frame in frames if frame.get('media_type') == 'video'
               and frame.get('stream_index') == video.get('index')]
    expected = {'color_transfer': 'smpte2084', 'color_primaries': 'bt2020',
                'color_space': 'bt2020nc', 'color_range': 'tv', 'pix_fmt': 'yuv420p10le'}
    return (video.get('codec_name') == 'hevc' and video.get('profile') == 'Main 10'
            and bool(samples) and all(video.get(key) == value for key, value in expected.items())
            and all(all(frame.get(key) == value for key, value in expected.items())
                    and frame.get('width') == video.get('width')
                    and frame.get('height') == video.get('height') for frame in samples))


def dynamic_range(video, frames):
    sides = list(video.get('side_data_list', []))
    for frame in frames:
        if frame.get('media_type') == 'video' and frame.get('stream_index') == video.get('index'):
            sides.extend(frame.get('side_data_list', []))
    dv = [side for side in sides if any(name in side.get('side_data_type', '').lower()
                                       for name in ('dovi', 'dolby vision'))]
    hdr_plus = any('2094-40' in side.get('side_data_type', '')
                   or 'HDR10+' in side.get('side_data_type', '') for side in sides)
    if dv:
        fields = ('dv_profile', 'dv_bl_signal_compatibility_id', 'bl_present_flag',
                  'rpu_present_flag', 'el_present_flag')
        configs = {tuple(side.get(key) for key in fields) for side in dv
                   if 'configuration record' in side.get('side_data_type', '').lower()}
        if len(configs) > 1 or any(None in config for config in configs):
            return ''
        hdr_config = configs in ({(7, 6, 1, 1, 1)}, {(8, 1, 1, 1, 0)})
        rpu_fields = ('vdr_rpu_profile', 'bl_video_full_range_flag', 'bl_bit_depth',
                      'vdr_bit_depth', 'el_spatial_resampling_filter_flag', 'disable_residual_flag')
        rpu_headers = {tuple(side.get(key) for key in rpu_fields) for side in dv if 'vdr_rpu_profile' in side}
        hdr_rpu = not configs and rpu_headers in ({(1, 0, 10, 12, 1, 0)}, {(1, 0, 10, 12, 0, 1)})
        if (hdr_config or hdr_rpu) and decoded_hdr_base(video, frames):
            return 'DV.HDR10Plus' if hdr_plus else 'DV.HDR10'
        return 'DV'
    transfer, primaries = video.get('color_transfer'), video.get('color_primaries')
    if transfer == 'smpte2084' and primaries == 'bt2020':
        return 'HDR10Plus' if hdr_plus else 'HDR10'
    if transfer == 'arib-std-b67' and primaries == 'bt2020':
        return 'HLG'
    if transfer in {'bt709', 'smpte170m', 'bt470bg', 'gamma22', 'gamma28', 'iec61966-2-1'}:
        return 'SDR'
    return ''
