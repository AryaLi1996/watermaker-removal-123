"""
Local filesystem paths, in the forms Windows actually accepts.

Everything here is a no-op away from Windows: macOS and Linux hand this
process a path it can open, and the whole file exists because Windows does
not always do the same. The case that matters is a path at or past MAX_PATH,
which every Win32 call refuses unless it is written in the extended-length
form — the file is there, `os.path.isfile` says it is not, and the user is
told their video has been moved, renamed or deleted.

Writing that form is not just a matter of prepending the prefix: the prefix
also turns off the normalisation everything else relies on, so a path
spelled with forward slashes (the renderer builds the output path that way)
or carrying a `..` has to be squared up first or it reaches the filesystem
verbatim.

The transformations are written against `ntpath` rather than `os.path` so the
Windows behaviour can be tested on the machine the tests actually run on.
"""
from __future__ import annotations

import ntpath
import os

# Windows' classic path ceiling, counted with the terminating NUL — so 259
# characters is the longest path the plain Win32 calls will take.
WINDOWS_MAX_PATH = 260

# What tells Win32 to hand the path to the filesystem unexamined: no MAX_PATH,
# no normalisation, and no interpretation of `.` or `..`.
EXTENDED_PREFIX = '\\\\?\\'
# The same, for a UNC share: `\\server\share` becomes `\\?\UNC\server\share`.
EXTENDED_UNC_PREFIX = EXTENDED_PREFIX + 'UNC'


def is_extended(path: str) -> bool:
    """Whether `path` is already written in the extended-length form."""
    return path.startswith(EXTENDED_PREFIX)


def windows_long_path(path: str) -> str:
    """
    `path` in the form Windows will open regardless of its length.

    Applied only past MAX_PATH, because the prefix is not free: it turns off
    the normalisation the rest of the system assumes, so a path carrying it
    has to be exactly right. Below the ceiling the plain spelling works and is
    what the user, the logs and the error messages should see.

    `path` must already be absolute — a relative one has no meaning here, and
    resolving it against this process's working directory would invent one.
    """
    if is_extended(path) or len(path) < WINDOWS_MAX_PATH:
        return path
    # The prefix suppresses normalisation, so it has to be done first:
    # forward slashes and `..` reach the filesystem verbatim otherwise.
    normalised = ntpath.normpath(path)
    if normalised.startswith('\\\\'):
        # A UNC path keeps one leading backslash after the UNC marker.
        return EXTENDED_UNC_PREFIX + normalised[1:]
    return EXTENDED_PREFIX + normalised


def openable(path: str) -> str:
    """
    The spelling to hand the filesystem, ffmpeg, or OpenCV.

    Off Windows this is the path itself: POSIX has no length ceiling worth
    working around and no second spelling to choose between.
    """
    if os.name != 'nt':
        return path
    return windows_long_path(path)


def displayable(path: str) -> str:
    r"""
    The spelling to show a person, or to hand back to the file manager.

    `\\?\D:\clips\out.mp4` is a correct path and an alarming thing to read in
    a "saved to" line, so the prefix comes off again on the way out.
    """
    if path.startswith(EXTENDED_UNC_PREFIX + '\\'):
        return '\\' + path[len(EXTENDED_UNC_PREFIX):]
    if is_extended(path):
        return path[len(EXTENDED_PREFIX):]
    return path
