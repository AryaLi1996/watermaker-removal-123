"""
The pretrained weights ProPainter needs, and getting them onto the disk.

Three files, about half a gigabyte between them, and none of them can ship
inside the app: they are far larger than the installer, they are licensed
separately, and most users of this app will never pick the method that needs
them. So they are fetched the first time someone does, into the ProPainter
checkout's own ``weights/`` directory — the same place its authors' script
puts them, so an existing manual install is found rather than duplicated.

A download that fails has to say why in a sentence a user can act on. "No
network" and "the release moved" are different problems with different fixes,
and a stack trace is neither.
"""
from __future__ import annotations

import os
import shutil
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

# Where the authors publish them. Pinned to a release tag rather than a branch:
# an inference script and its checkpoints are a matched pair, and floating one
# of them is how a model silently loads the wrong tensor shapes.
RELEASE_BASE = 'https://github.com/sczhou/ProPainter/releases/download/v0.1.0'


@dataclass(frozen=True)
class Weight:
    """One checkpoint file."""

    filename: str
    #: Roughly how big, in MB, for a progress line before the server answers.
    approx_mb: int

    @property
    def url(self) -> str:
        return f'{RELEASE_BASE}/{self.filename}'


WEIGHTS: tuple[Weight, ...] = (
    # The inpainting generator itself.
    Weight('ProPainter.pth', 150),
    # Fills the holes optical flow leaves inside the mask.
    Weight('recurrent_flow_completion.pth', 20),
    # RAFT, which estimates the flow in the first place.
    Weight('raft-things.pth', 20),
)

# How long a stalled connection is allowed to sit there. Generous: these are
# large files and a slow link is not a broken one, but a dead socket must not
# hold a job open forever.
DOWNLOAD_TIMEOUT_SECONDS = 60

CHUNK_BYTES = 1024 * 256


def weights_dir(home: str) -> str:
    """Where a ProPainter checkout keeps its checkpoints."""
    return os.path.join(home, 'weights')


def missing(home: str) -> list[Weight]:
    """The checkpoints that are not on disk yet, in download order."""
    directory = weights_dir(home)
    return [w for w in WEIGHTS
            if not os.path.isfile(os.path.join(directory, w.filename))]


def _download_one(
    weight: Weight, directory: str, on_progress: Callable[[float], None] | None,
) -> str:
    """
    Fetch one checkpoint, via a temporary name so an interrupted download is
    never mistaken for a complete one on the next run.
    """
    target = os.path.join(directory, weight.filename)
    partial = target + '.part'

    try:
        with urllib.request.urlopen(weight.url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            total = int(response.headers.get('Content-Length') or 0)
            done = 0
            with open(partial, 'wb') as out:
                while True:
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if on_progress and total > 0:
                        on_progress(done / total * 100)
    except urllib.error.HTTPError as exc:
        _discard(partial)
        raise IOError(
            f'Could not download {weight.filename}: the server answered '
            f'{exc.code}. The model release may have moved.'
        ) from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        _discard(partial)
        raise IOError(
            f'Could not download {weight.filename}: {exc}. '
            'Check the network connection and try again.'
        ) from exc

    os.replace(partial, target)
    return target


def _discard(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def ensure(
    home: str, on_progress: Callable[[str, float], None] | None = None,
) -> list[str]:
    """
    Make sure every checkpoint is present, downloading what is not, and return
    the paths of the files this call actually fetched.

    `on_progress` is called as ``(filename, percent)`` while each file
    downloads — a job that appears frozen for four minutes on its first run is
    a job the user kills.

    ``WATERMARK_PROPAINTER_WEIGHTS`` points at a directory of already-downloaded
    checkpoints; they are linked into place and nothing is fetched. That is
    both the offline install story and how a CI run gets the models without
    half a gigabyte of traffic per job.
    """
    directory = weights_dir(home)
    os.makedirs(directory, exist_ok=True)

    external = os.environ.get('WATERMARK_PROPAINTER_WEIGHTS')
    if external:
        _adopt_external(external, directory)

    fetched = []
    for weight in missing(home):
        def report(pct: float, name: str = weight.filename) -> None:
            if on_progress:
                on_progress(name, pct)
        fetched.append(_download_one(weight, directory, report))
    return fetched


def _adopt_external(source: str, directory: str) -> None:
    """
    Take checkpoints from a directory the user or CI prepared.

    Copied rather than symlinked: a Windows runner needs a privilege for
    symlinks that a normal account does not have, and the file is read once
    per job either way.
    """
    for weight in WEIGHTS:
        origin = os.path.join(source, weight.filename)
        target = os.path.join(directory, weight.filename)
        if os.path.isfile(origin) and not os.path.isfile(target):
            shutil.copyfile(origin, target)
