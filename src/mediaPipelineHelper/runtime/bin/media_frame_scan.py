"""Diagnostic full-decode evidence; not a decoder capability certificate."""

import hashlib
import json
from contextlib import closing
from xml.etree.ElementTree import XMLPullParser

from media_scan_process import evidence_chunks, validate_probe_diagnostics


class FrameEvidence:
    def __init__(self, stream):
        self.stream = stream
        self.audio_layout = None
        self.count = 0
        self.sides = {}
        self.parser = XMLPullParser(events=('start', 'end'))
        self.root = None
        self.frames = None
        self.finished = False
        self.pending_bytes = 0
        self.digest = hashlib.sha256()

    def feed(self, data):
        self.pending_bytes += len(data)
        if self.pending_bytes > 4 * 1024 * 1024:
            raise ValueError('Frame XML exceeds the per-frame evidence bound')
        self.digest.update(data)
        self.parser.feed(data)
        for event, element in self.parser.read_events():
            if event == 'start':
                if self.root is None:
                    if element.tag != 'ffprobe':
                        raise ValueError('Unexpected frame evidence root')
                    self.root = element
                if element.tag == 'frames':
                    self.frames = element
                continue
            if element.tag == 'frame':
                self.add_frame(element)
                self.pending_bytes = 0
                if self.frames is None:
                    raise ValueError('Frame outside the frames collection')
                self.frames.remove(element)
            elif element.tag == 'ffprobe':
                self.finished = True

    def add_frame(self, element):
        frame = element.attrib
        media_type = self.stream['codec_type']
        if frame.get('media_type') != media_type or int(frame.get('stream_index', -1)) != self.stream['index']:
            raise ValueError('Unexpected decoded stream')
        if media_type == 'audio':
            layout = frame.get('channel_layout')
            if (int(frame.get('channels', 0)) != self.stream.get('channels')
                    or int(frame.get('nb_samples', 0)) <= 0):
                raise ValueError('Missing decoded audio channel evidence')
            expected = self.stream.get('channel_layout')
            if ((expected and expected not in ('unknown', 'unspecified') and expected != layout)
                    or (self.audio_layout is not None and self.audio_layout != layout)):
                raise ValueError('Decoded channel layout changes or contradicts stream metadata')
            self.audio_layout = layout
            self.count += 1
            return
        for key in ('width', 'height', 'color_transfer', 'color_primaries', 'color_space', 'pix_fmt'):
            expected = self.stream.get(key)
            if expected is None or str(expected) in ('unknown', 'unspecified', 'reserved'):
                continue
            if frame.get(key) != str(expected):
                raise ValueError(f'Decoded {key} changes or contradicts stream metadata')
        interlaced = frame.get('interlaced_frame')
        expected_interlaced = self.stream.get('field_order') in ('tt', 'bb', 'tb', 'bt')
        if interlaced not in ('0', '1') or (interlaced == '1') != expected_interlaced:
            raise ValueError('Decoded field order contradicts stream metadata')
        for side in element.findall('./side_data_list/side_data'):
            # Keep attributes needed for classification, never large nested RPU payloads.
            fields = ('side_data_type', 'dv_profile', 'dv_bl_signal_compatibility_id',
                      'bl_present_flag', 'rpu_present_flag', 'el_present_flag')
            values = [(name, value) for name, value in side.attrib.items() if name in fields]
            if side.get('type'):
                values.append(('side_data_type', side.get('type')))
            values.extend((item.get('key'), item.get('value')) for item in side.findall('side_datum')
                          if item.get('key') in fields)
            raw = {}
            for name, value in values:
                if value is None or (name in raw and raw[name] != value):
                    raise ValueError('Missing or contradictory decoded side-data field')
                raw[name] = value
            attributes = {name: (value if name == 'side_data_type' else int(value))
                          for name, value in raw.items()}
            if not attributes.get('side_data_type'):
                raise ValueError('Unnamed decoded side data')
            key = json.dumps(attributes, sort_keys=True)
            if len(key) > 16384 or (key not in self.sides and len(self.sides) >= 256):
                raise ValueError('Decoded side-data diversity exceeds the evidence bound')
            self.sides[key] = attributes
        self.count += 1

    def finish(self):
        self.parser.close()
        if not self.finished or not self.count:
            raise ValueError('Incomplete or empty full-frame scan')
        return {'decodedFrames': self.count, 'frameEvidenceSha256': self.digest.hexdigest(),
                'decodedFieldOrder': (self.stream.get('field_order')
                    if self.stream.get('field_order') in ('tt', 'bb', 'tb', 'bt') else 'progressive')
                    if self.stream['codec_type'] == 'video' else None,
                'channel_layout': self.audio_layout,
                'side_data_list': list(self.sides.values()),
                'coverage': 'all decoded frames through clean EOF',
                'negativeDynamicHdrCertified': False}


def scan_frames(file, stream, ffprobe='ffprobe', timeout=14400, *, probe_streams=()):
    """Read every frame of one video or audio stream through clean EOF.

    Absence of reported metadata is not proof that this decoder understands all
    dynamic-HDR payloads. The publication owner must certify that separately.
    """
    evidence = FrameEvidence(stream)
    command = [ffprobe, '-v', 'warning', '-threads', '1', '-select_streams', str(stream['index']),
               '-show_frames', '-show_entries',
               'frame=media_type,stream_index,width,height,pix_fmt,color_space,color_primaries,color_transfer,interlaced_frame,channels,channel_layout,nb_samples:frame_side_data',
               '-of', 'xml', str(file)]
    declaration_tail = b''
    diagnostics = bytearray()
    with closing(evidence_chunks(file, command, timeout, diagnostics=diagnostics)) as chunks:
        for chunk in chunks:
            if b'<!' in declaration_tail + chunk:
                raise ValueError('Unexpected XML declaration in frame evidence')
            declaration_tail = chunk[-1:]
            evidence.feed(chunk)
    validate_probe_diagnostics(diagnostics, probe_streams)
    return evidence.finish()
