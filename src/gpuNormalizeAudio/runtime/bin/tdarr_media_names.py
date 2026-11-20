"""Plugin-owned single-release naming from actual media facts, dry-run by default.

Run only before publishing to an importer-watched directory, with exclusive
ownership of the release directory. This does not convert or validate playback.
"""

import argparse
from contextlib import closing, contextmanager
import errno
import fcntl
import json
import hashlib
import os
from pathlib import Path
import re
import stat

from media_frame_scan import scan_frames
from media_dynamic_range import dynamic_range
from media_nal_evidence import scan_hevc
from media_scan_process import evidence_chunks, validate_probe_diagnostics
from media_package_transaction import identity

VIDEO = {".mkv", ".mp4", ".m4v", ".avi", ".ts", ".m2ts"}
SIDECAR = {".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx", ".nfo", ".jpg", ".png"}
RESOLUTION = re.compile(r"(?<![A-Za-z0-9])(?:\d{3,5}[pi]|4K)(?![A-Za-z0-9])", re.I)
SOURCE = re.compile(r"(?<![A-Za-z0-9])(?:WEB-DL|WEBRip|WEB|BluRay|BDRip|BRRip|HDTV)(?![A-Za-z0-9])", re.I)
PROVENANCE = re.compile(r"(?<![A-Za-z0-9])(?:AMZN|AMAZON|DSNP|HMAX|ATVP?|NF|NETFLIX|ARD|CANADA)(?![A-Za-z0-9])", re.I)
LANGUAGE_LIST = re.compile(r"\[(?:DE|EN|TR|FR|JA|IT|ES|NL|RU|PT|PL)(?:[-+,](?:DE|EN|TR|FR|JA|IT|ES|NL|RU|PT|PL))+\]", re.I)
TECHNICAL = re.compile(
    r"(?<![A-Za-z0-9])(?:Dolby[ ._-]?Vision|HDR10(?:\+|Plus)?|HDR|SDR|HLG|PQ|DoVi|DV"
    r"|P[578](?=[ ._-])|UHD|4K|MULTi|German|Deutsch|English|GER|DEU|ENG|DL"
    r"|H[ ._-]?26[45]|[xh]26[45]|HEVC|AVC|AV1"
    r"|(?:DDP?\+?|E[ ._-]?AC[ ._-]?3|AC[ ._-]?3|AAC|DTS(?:[ ._-]?HD[ ._-]?MA)?"
    r"|TrueHD|FLAC|Opus|ALAC|MP3)(?:[ ._-]?[12567][ .][01])?"
    r"|Atmos|(?:8|10|12)bits?|[12567][ .][01])(?=$|[ ._\[\]-])", re.I,
)


def video_resolution(video):
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    # Cropped cinemascope still belongs to its original horizontal raster class.
    if width <= 0 or height <= 0:
        raise ValueError("Missing video dimensions")
    resolution = next((raster for raster, widths, max_width in (
        (2160, {3840, 4096}, 4096), (1080, {1920, 2048}, 2048),
        (720, {1280}, 1280), (576, set(), 1024), (480, set(), 854),
    ) if (width in widths and height <= raster) or (height == raster and width <= max_width)), None)
    # No new acceptance thresholds: an unclassified raster keeps its measured height.
    return resolution if resolution is not None else height


def primary_video(probe):
    """Naming follows the default presentation, then container order like players.

    This selects a label, never a stream mapping or a claim about DV layer pairing.
    All video tracks remain in the processed media.
    """
    videos = [s for s in probe.get("streams", []) if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")]
    if not videos:
        raise ValueError("No video presentation is available for naming")
    return next((s for s in videos if s.get('disposition', {}).get('default')), videos[0])


def facts(probe):
    video = primary_video(probe)
    resolution = video_resolution(video)
    field = video.get("field_order", "unknown")
    suffix = "i" if field in {"tt", "bb", "tb", "bt"} else ("p" if field == 'progressive' else '')
    dynamic = dynamic_range(video, probe.get('frames', []))
    codec = {"hevc": "H265", "h264": "H264", "av1": "AV1"}.get(video.get("codec_name"))
    if codec is None:
        codec = re.sub(r'[^A-Za-z0-9]', '', video.get('codec_name', '')).upper()
    return {"resolution": f"{resolution}{suffix}", "dynamicRange": dynamic,
            "videoCodec": codec, **audio_facts(probe)}


def audio_facts(probe):
    audio = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio:
        raise ValueError("No audio streams")
    aliases = {"ger": "German", "deu": "German", "de": "German",
               "eng": "English", "en": "English"}
    languages = []
    for stream in audio:
        tag = stream.get("tags", {}).get("language", "und").lower()
        if tag not in aliases:
            aliases[tag] = tag.upper() if re.fullmatch(r'[a-z]{2,3}', tag) else 'UND'
        if aliases[tag] not in languages:
            languages.append(aliases[tag])
    language = "German.DL" if set(languages) == {"German", "English"} else '.'.join(languages)
    preferred = [s for s in audio if aliases[s.get('tags', {}).get('language', 'und').lower()] == languages[0]]
    if "German" in languages:
        preferred = [s for s in audio if aliases[s["tags"]["language"].lower()] == "German"]
    chosen = max(preferred, key=lambda s: (s.get("channels", 0), int(s.get("bit_rate", 0))))
    audio_codec = {"aac": "AAC", "ac3": "AC3", "eac3": "EAC3",
                    "truehd": "TrueHD", "dts": "DTS", "flac": "FLAC", "opus": "Opus",
                    "alac": "ALAC", "mp3": "MP3"}.get(chosen.get("codec_name"))
    layout = {"mono": (1, "1.0"), "stereo": (2, "2.0"),
              "5.1": (6, "5.1"), "5.1(side)": (6, "5.1"),
              "7.1": (8, "7.1")}.get(chosen.get("channel_layout"))
    if not audio_codec:
        audio_codec = re.sub(r'[^A-Za-z0-9]', '', chosen.get('codec_name', '')).upper()
    channels = layout[1] if layout and layout[0] == chosen.get('channels') else f"{chosen.get('channels', 0)}ch"
    return {"language": language, "audio": f"{audio_codec}{channels}"}


def corrected_stem(stem, actual):
    matches = list(RESOLUTION.finditer(stem))
    if matches:
        marker = matches[0]
        prefix, tail = stem[:marker.start()], RESOLUTION.sub('', stem[marker.end():])
    else:
        # A resolution label is optional provenance, never media admission.
        # Only a year/episode gives a safe title boundary. Otherwise preserve
        # the complete unfamiliar title instead of guessing where it ends.
        identity = list(re.finditer(r'(?i)(?<![A-Za-z0-9])(?:S\d+E\d+(?:E\d+)*|(?:19|20)\d{2})(?![A-Za-z0-9])', stem))
        boundary = identity[-1].end() if identity else len(stem)
        prefix, tail = stem[:boundary], stem[boundary:]
    # Only strip language/source-adjacent metadata, never arbitrary title words.
    prefix = re.sub(r"(?i)[ ._-](?:German|Deutsch|English|GER|DEU|ENG)[ ._-]+DL"
                    r"(?:[ ._-]+(?:HDR10(?:\+|Plus)?|HDR|SDR|HLG|DV|DoVi))*[ ._-]*$", ".", prefix)
    episode = re.search(r'(?i)(?<![A-Za-z0-9])S\d+E\d+(?:E\d+)*', prefix)
    episode_words = bool(episode and re.search(r'(?i)(?<![A-Za-z0-9])(?:German|Deutsch|English|HDR|SDR)(?![A-Za-z0-9])', prefix[episode.end():])
                         and not re.search(r'(?i)(?:German|Deutsch|English)[ ._-]+DL|(?:EAC3|DDP|AAC|DTS|H26[45])', prefix[episode.end():]))
    if not episode_words:
        prefix = re.sub(r"(?i)(?:[ ._-](?:German|Deutsch|English|MULTi|DL|UHD|4K))+(?:[ ._-])*$", ".", prefix)
    group = re.search(r"-([A-Za-z0-9]+)(?:-xpost)?$", tail, re.I)
    if group and (TECHNICAL.fullmatch(group.group(1)) or group.group(1).lower() == 'xpost'):
        group = None
    # A release-group suffix is optional naming provenance, not media admission.
    body = tail[:group.start()] if group else tail
    # A movie's explicit year bounds its title. Move only a completely known
    # metadata suffix across the resolution; episode-title text is not moved.
    years = list(re.finditer(r"(?<!\w)(?:19|20)\d{2}(?!\w)", prefix))
    if years and not re.search(r"(?i)(?<!\w)S\d+E\d+", prefix):
        boundary = years[-1].end()
        metadata = prefix[boundary:]
        unknown = TECHNICAL.sub("", PROVENANCE.sub("", SOURCE.sub("", LANGUAGE_LIST.sub("", metadata))))
        if not unknown.strip(" ._-[]"):
            body = metadata + "." + body
            prefix = prefix[:boundary]
    body = LANGUAGE_LIST.sub("", body)
    sources = []
    def preserve_source(match):
        sources.append(match.group(0))
        return f"@SOURCE{len(sources) - 1}@"
    body = SOURCE.sub(preserve_source, body)
    for value in actual.values():
        if value:
            body = re.sub(r'(?<!\w)' + re.escape(value) + r'(?!\w)', '', body, flags=re.I)
    body = TECHNICAL.sub("", body)
    # Preserve unfamiliar provenance text; only recognized technical tokens are replaced.
    for index, source in enumerate(sources):
        body = body.replace(f"@SOURCE{index}@", source)
    body = re.sub(r"[ ._]+", ".", body).strip(".-[] ")
    identity = list(re.finditer(r"(?i)(?<!\w)(?:S\d+E\d+(?:E\d+)*|(?:19|20)\d{2})(?!\w)", prefix))
    protected_end = identity[-1].end() if identity else 0
    known_metadata = not TECHNICAL.sub("", prefix[protected_end:]).strip(" ._-[]")
    explicit_language_pair = re.search(r"(?i)(?<!\w)(?:German|Deutsch|English)[ ._-]+DL(?!\w)", prefix[protected_end:])
    if identity and not episode_words and (known_metadata or explicit_language_pair or not re.search(r"(?i)(?<!\w)S\d+E\d+", prefix)):
        metadata = TECHNICAL.sub("", prefix[protected_end:])
        metadata = re.sub(r"[ ._]+", ".", metadata).strip(".-[] ")
        prefix = prefix[:protected_end] + ("." + metadata if metadata else "")
    # Unfamiliar episode/title words are preserved, not an admission failure.
    parts = [prefix.rstrip(". _"), actual["resolution"], body,
             actual["language"], actual["audio"], actual["dynamicRange"], actual["videoCodec"]]
    result = ".".join(p for p in parts if p) + (group.group(0) if group else '')
    if len(os.fsencode(result)) > 240:
        raise ValueError("Corrected name is too long")
    return result


@contextmanager
def package_lock(parent):
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


FILE_IDENTITY_FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')


def path_metadata(path):
    info = path.lstat()
    return tuple(getattr(info, field) for field in FILE_IDENTITY_FIELDS)


def path_identity(path):
    fields = FILE_IDENTITY_FIELDS
    item = path.lstat()
    metadata = tuple(getattr(item, field) for field in fields)
    digest = None
    if stat.S_ISREG(item.st_mode):
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as handle:
            before = os.fstat(handle.fileno())
            if before.st_nlink != 1 or tuple(getattr(before, field) for field in fields) != metadata:
                raise ValueError('Package file changed before content fingerprinting')
            content = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                content.update(chunk)
            after = os.fstat(handle.fileno())
            if tuple(getattr(after, field) for field in fields) != metadata:
                raise ValueError('Package file changed during content fingerprinting')
            digest = content.hexdigest()
        current = path.lstat()
        if tuple(getattr(current, field) for field in fields) != metadata:
            raise ValueError('Package file identity changed after content fingerprinting')
    return (*metadata, digest)


def package_identity(parent):
    return {str(path): path_identity(path) for path in [parent, *parent.iterdir()]}


def read_probe_json(file, ffprobe, arguments, streams=None, *, naming=False):
    command = [ffprobe, '-v', 'warning', *arguments, '-of', 'json', str(file)]
    encoded = bytearray()
    diagnostics = bytearray()
    with closing(evidence_chunks(file, command, 60, diagnostics=diagnostics)) as chunks:
        for chunk in chunks:
            encoded.extend(chunk)
            if len(encoded) > 4 * 1024 * 1024:
                raise ValueError('Stream metadata exceeds evidence bound')
    metadata = json.loads(encoded)
    if not naming:
        validate_probe_diagnostics(diagnostics, metadata['streams'] if streams is None else streams)
    return metadata


def probe_naming_facts(file, ffprobe="ffprobe"):
    """Bounded stream/decoded-sample facts, separate from publication byte proof."""
    metadata = read_probe_json(file, ffprobe, ['-show_streams', '-show_format'], naming=True)
    video = primary_video(metadata)
    try:
        sampled = read_probe_json(file, ffprobe, ['-select_streams', str(video['index']),
            '-read_intervals', '%+#64', '-show_frames', '-show_entries',
            'frame=media_type,stream_index,interlaced_frame,top_field_first,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer:frame_side_data'], metadata['streams'], naming=True)
    except (ValueError, TimeoutError):
        sampled = {}  # Optional naming enrichment; do not reject readable media.
    frames = sampled.get('frames', [])
    if frames and video.get('field_order') in (None, '', 'unknown'):
        field = frames[0].get('interlaced_frame')
        if field in (0, 1):
            video['field_order'] = 'progressive' if field == 0 else (
                'tt' if frames[0].get('top_field_first') == 1 else 'bb')
    metadata['frames'] = frames
    return facts(metadata)


def inspect_naming_media(file, ffprobe="ffprobe", ffmpeg="ffmpeg"):
    """Name the already processed output; do not repeat full-media decoding."""
    file = Path(file).absolute()
    if file.resolve(strict=True) != file or not file.is_file():
        raise ValueError('Finished media must be a canonical regular file')
    before = path_identity(file)
    values = probe_naming_facts(file, ffprobe)
    if path_identity(file) != before:
        raise ValueError('Finished media changed during naming inspection')
    return {'facts': values, 'finishedIdentity': before,
            'namingInspection': {'coverage': 'stream metadata and at most 64 video packets',
                                 'fullDecode': False, 'negativeDynamicHdrCertified': False}}


def inspect_finished_media(file, ffprobe="ffprobe", ffmpeg="ffmpeg"):
    """Explicit diagnostic full inspection, separate from terminal naming."""
    file = Path(file).absolute()
    if file.resolve(strict=True) != file or not file.is_file():
        raise ValueError('Finished media must be a canonical regular file')
    before = path_identity(file)
    metadata = read_probe_json(file, ffprobe, ['-show_streams', '-show_format'])
    audio_evidence = {}
    for stream in metadata['streams']:
        if stream.get('codec_type') == 'audio':
            decoded = scan_frames(file, stream, ffprobe, probe_streams=metadata['streams'])
            audio_evidence[str(stream['index'])] = decoded
            if decoded.get('channel_layout'):
                stream['channel_layout'] = decoded['channel_layout']
    videos = [stream for stream in metadata['streams'] if stream.get('codec_type') == 'video'
              and not stream.get('disposition', {}).get('attached_pic')]
    if len(videos) != 1:
        raise ValueError('Exactly one non-cover video stream is required')
    video = videos[0]
    video_resolution(video)
    frame_evidence = scan_frames(file, video, ffprobe, probe_streams=metadata['streams'])
    if video.get('field_order') in (None, '', 'unknown'):
        if frame_evidence.get('decodedFieldOrder') != 'progressive':
            raise ValueError('Unknown container field order lacks complete progressive frame evidence')
        video['field_order'] = 'progressive'
    metadata['frames'] = [{'media_type': 'video', 'stream_index': video['index'],
                           'side_data_list': frame_evidence['side_data_list']}]
    bitstream_evidence = None
    if video.get('codec_name') == 'hevc':
        bitstream_evidence = scan_hevc(file, video, ffmpeg)
        sides = frame_evidence['side_data_list']
        decoded_dv = any(any(name in side.get('side_data_type', '').lower()
                            for name in ('dovi', 'dolby vision')) for side in sides)
        decoded_plus = any('2094-40' in side.get('side_data_type', '')
                           or 'HDR10+' in side.get('side_data_type', '') for side in sides)
        if (decoded_dv != bool(bitstream_evidence['dolbyVisionRpuCarriers'])
                or decoded_plus != bool(bitstream_evidence['hdr10PlusCarriers'])):
            raise ValueError('Decoded dynamic HDR and bitstream carriers disagree')
        if facts(metadata)['dynamicRange'] == 'DV' and not decoded_dv:
            raise ValueError('Dolby Vision configuration lacks decoded RPU evidence')
    if path_identity(file) != before:
        raise ValueError('Finished media changed across evidence scans')
    return {'facts': facts(metadata), 'finishedIdentity': before, 'frameEvidence': frame_evidence,
            'audioEvidence': audio_evidence, 'bitstreamEvidence': bitstream_evidence,
            'containerEvidence': {'format': metadata.get('format', {}).get('format_name'),
                                  'brand': metadata.get('format', {}).get('tags', {}).get('major_brand'),
                                  'videoCodec': video.get('codec_name'),
                                  'pixelFormat': video.get('pix_fmt')}}


def process(file, root, apply=False, ffprobe="ffprobe", ffmpeg="ffmpeg", companions=()):
    if apply:
        raise ValueError("Apply is disabled until scheduler ownership and crash recovery are integrated")
    file, root = Path(file).absolute(), Path(root).resolve(strict=True)
    parent = file.parent
    if file.resolve(strict=True) != file or parent.resolve(strict=True) != parent:
        raise ValueError("Symlinks/non-canonical paths are not supported")
    if parent.parent != root:
        raise ValueError("Only direct single-release subdirectories of the staging root are allowed")
    with package_lock(parent):
        entries = list(parent.iterdir())
        initial = package_identity(parent)
        if set(initial) != {str(parent), *(str(entry) for entry in entries)}:
            raise ValueError('Release inventory changed before media evidence scans')
        for entry in entries:
            identity(entry)
        media = [x for x in entries if x.suffix.lower() in VIDEO]
        companions = [Path(entry) for entry in companions]
        if (file not in media or set(media) != {file, *companions}
                or len(media) != len(companions) + 1
                or any(entry.parent != parent for entry in companions)):
            raise ValueError("Release media need explicit finished/skipped companion evidence")
        evidence = inspect_naming_media(file, ffprobe, ffmpeg)
        if package_identity(parent) != initial:
            raise ValueError('Release package changed across media evidence scans')
        actual = evidence['facts']
        stem = corrected_stem(file.stem, actual)
        directory_name = corrected_stem(parent.name, actual)
        destination = root / directory_name
        renames = []
        for entry in entries:
            if entry == file:
                new_name = stem + file.suffix
            elif entry.is_dir():
                new_name = entry.name
            elif entry.name.startswith(file.stem + ".") and entry.suffix.lower() in SIDECAR:
                new_name = stem + entry.name[len(file.stem):]
            else:
                new_name = entry.name
            if entry.name != new_name:
                target = parent / new_name
                if target.exists() or target.is_symlink():
                    raise FileExistsError(errno.EEXIST, "Target exists", str(target))
                renames.append((entry, target))
        if destination != parent and (destination.exists() or destination.is_symlink()):
            raise FileExistsError(errno.EEXIST, "Directory target exists", str(destination))
        result = {"apply": apply, "facts": actual, "source": str(file),
                  **evidence,
                   "packageIdentity": initial,
                   "companionMedia": [str(entry) for entry in companions],
                  "publicationReady": False,
                  "pendingGates": ["decoder dynamic-HDR capability/negative-evidence certification", "scheduler package ownership",
                                   "durable package transaction", "Move/Notify integration"],
                  "target": str(destination / (stem + file.suffix)),
                  "renames": [[str(a), str(b)] for a, b in renames]}
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--staging-root", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    print(json.dumps(process(args.file, args.staging_root, args.apply, args.ffprobe, args.ffmpeg), indent=2))


if __name__ == "__main__":
    main()
