"""Plugin Annex-B metadata inventory, independent of decoder reporting.

This inventories HEVC metadata carriers; it does not validate an RPU or certify
Dolby Vision base-layer compatibility. Unknown carriers reject the inventory.
"""

import hashlib
import re
from contextlib import closing

from media_scan_process import evidence_chunks


START = re.compile(b'\x00\x00\x01')
X265_UUID = bytes.fromhex('2ca2de09b51747dbbb55a4fe7fc2fc4e')


def scan_hevc(file, video, ffmpeg='ffmpeg', timeout=14400):
    if video.get('codec_name') != 'hevc':
        raise ValueError('This bitstream evidence owner supports HEVC only')
    evidence = HevcEvidence()
    command = [ffmpeg, '-nostdin', '-v', 'warning', '-i', str(file),
               '-map', f"0:{int(video['index'])}", '-c:v', 'copy',
               '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', 'pipe:1']
    with closing(evidence_chunks(file, command, timeout)) as chunks:
        for chunk in chunks:
            evidence.feed(chunk)
    return evidence.finish()


def rbsp(data):
    output = bytearray()
    zeros = 0
    index = 0
    while index < len(data):
        value = data[index]
        if zeros >= 2 and value == 3:
            if index + 1 == len(data) or data[index + 1] > 3:
                raise ValueError('Invalid emulation prevention byte')
            zeros = 0
            index += 1
            continue
        output.append(value)
        zeros = zeros + 1 if value == 0 else 0
        index += 1
    return bytes(output)


class HevcEvidence:
    def __init__(self):
        self.buffer = bytearray()
        self.started = False
        self.finished = False
        self.digest = hashlib.sha256()
        self.nals = 0
        self.slices = 0
        self.rpus = 0
        self.hdr10plus = 0
        self.types = set()

    def feed(self, data):
        if self.finished:
            raise ValueError('Evidence already finalized')
        self.digest.update(data)
        self.buffer.extend(data)
        while True:
            marker = START.search(self.buffer)
            if marker is None:
                break
            prefix = bytes(self.buffer[:marker.start()]).rstrip(b'\x00')
            if self.started:
                self.add_nal(prefix)
            elif prefix:
                raise ValueError('Data before Annex-B start code')
            self.started = True
            del self.buffer[:marker.end()]
        if len(self.buffer) > 64 * 1024 * 1024:
            raise ValueError('NAL exceeds evidence bound')

    def add_nal(self, data):
        if len(data) < 2 or data[0] & 128 or not data[1] & 7:
            raise ValueError('Invalid HEVC NAL header')
        kind = (data[0] >> 1) & 63
        layer = ((data[0] & 1) << 5) | (data[1] >> 3)
        if layer:
            raise ValueError('Multilayer HEVC requires a separate compatibility proof')
        if kind not in {*range(10), *range(16, 22), *range(32, 41), 62}:
            raise ValueError('Unknown HEVC metadata carrier')
        self.types.add(kind)
        self.nals += 1
        if kind < 32:
            self.slices += 1
        elif kind == 62:
            if len(data) < 3:
                raise ValueError('Empty Dolby Vision RPU carrier')
            self.rpus += 1
        elif kind in (39, 40):
            self.sei(rbsp(data[2:]))

    def sei(self, data):
        offset = 0
        while offset < len(data):
            if data[offset:] == b'\x80':
                return
            values = []
            for _ in range(2):
                value = 0
                while offset < len(data) and data[offset] == 255:
                    value += 255
                    offset += 1
                if offset >= len(data):
                    raise ValueError('Truncated SEI header')
                values.append(value + data[offset])
                offset += 1
            kind, size = values
            if offset + size >= len(data):
                raise ValueError('Truncated SEI payload or trailing bits')
            payload = data[offset:offset + size]
            offset += size
            if kind == 4:
                # ITU-T T.35 / SMPTE ST 2094-40 identifier, not payload validity.
                if not payload.startswith(bytes.fromhex('b5003c000104')) or len(payload) < 7:
                    raise ValueError('Unknown registered user-data metadata')
                self.hdr10plus += 1
            elif kind == 5:
                if not payload.startswith(X265_UUID + b'x265 '):
                    raise ValueError('Unknown unregistered user-data metadata')
            # H.265 / FFmpeg SEI_TYPE_TIME_CODE (136) is timing metadata,
            # not an HDR carrier. Preserve it in the byte inventory unchanged.
            elif kind not in (0, 1, 6, 129, 132, 136, 137, 144):
                raise ValueError('Unsupported SEI metadata semantics')
        raise ValueError('Missing SEI trailing bits')

    def finish(self):
        if self.finished or not self.started:
            raise ValueError('Missing or already finalized Annex-B evidence')
        self.add_nal(bytes(self.buffer).rstrip(b'\x00'))
        self.buffer.clear()
        self.finished = True
        if not self.slices or not {32, 33, 34}.issubset(self.types):
            raise ValueError('Incomplete HEVC parameter-set or picture inventory')
        return {'nalUnits': self.nals, 'sliceUnits': self.slices,
                'dolbyVisionRpuCarriers': self.rpus,
                'hdr10PlusCarriers': self.hdr10plus,
                'annexBSha256': self.digest.hexdigest(),
                'negativeDynamicHdrCertified': False}
