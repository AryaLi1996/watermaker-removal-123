"""
Unit tests for backend/propainter_weights.py.

Nothing here touches the network: what is worth testing is the bookkeeping
around the download — what counts as already present, what a half-finished
file leaves behind, and whether a failure produces a sentence a user can act
on — and a test that fetched half a gigabyte from GitHub would test none of it.
"""
import os
import urllib.error

import pytest

import propainter_weights as weights


@pytest.fixture(autouse=True)
def no_external_weights(monkeypatch):
    monkeypatch.delenv('WATERMARK_PROPAINTER_WEIGHTS', raising=False)


def make_weights(home: str, *names: str) -> None:
    directory = weights.weights_dir(home)
    os.makedirs(directory, exist_ok=True)
    for name in names:
        with open(os.path.join(directory, name), 'wb') as handle:
            handle.write(b'weights')


def test_every_weight_has_a_release_url():
    for weight in weights.WEIGHTS:
        assert weight.url.startswith('https://')
        assert weight.url.endswith(weight.filename)


def test_a_fresh_install_is_missing_everything(tmp_path):
    assert len(weights.missing(str(tmp_path))) == len(weights.WEIGHTS)


def test_a_complete_install_is_missing_nothing(tmp_path):
    make_weights(str(tmp_path), *[w.filename for w in weights.WEIGHTS])
    assert weights.missing(str(tmp_path)) == []


def test_only_the_absent_files_are_fetched(tmp_path, monkeypatch):
    make_weights(str(tmp_path), weights.WEIGHTS[0].filename)
    fetched = []

    def fake_download(weight, directory, on_progress):
        fetched.append(weight.filename)
        path = os.path.join(directory, weight.filename)
        open(path, 'wb').close()
        return path

    monkeypatch.setattr(weights, '_download_one', fake_download)
    weights.ensure(str(tmp_path))
    assert fetched == [w.filename for w in weights.WEIGHTS[1:]]


def test_a_complete_install_downloads_nothing(tmp_path, monkeypatch):
    make_weights(str(tmp_path), *[w.filename for w in weights.WEIGHTS])
    monkeypatch.setattr(weights, '_download_one',
                        lambda *a, **k: pytest.fail('should not download'))
    assert weights.ensure(str(tmp_path)) == []


def test_prepared_weights_are_adopted_instead_of_downloaded(tmp_path, monkeypatch):
    """The offline install, and how CI gets the models without the traffic."""
    source = tmp_path / 'prepared'
    source.mkdir()
    for weight in weights.WEIGHTS:
        (source / weight.filename).write_bytes(b'prepared')

    home = str(tmp_path / 'ProPainter')
    monkeypatch.setenv('WATERMARK_PROPAINTER_WEIGHTS', str(source))
    monkeypatch.setattr(weights, '_download_one',
                        lambda *a, **k: pytest.fail('should not download'))

    assert weights.ensure(home) == []
    assert weights.missing(home) == []


def test_progress_is_reported_while_a_file_downloads(tmp_path, monkeypatch):
    seen = []

    def fake_download(weight, directory, on_progress):
        on_progress(50.0)
        path = os.path.join(directory, weight.filename)
        open(path, 'wb').close()
        return path

    monkeypatch.setattr(weights, '_download_one', fake_download)
    weights.ensure(str(tmp_path), on_progress=lambda name, pct: seen.append((name, pct)))

    assert seen and seen[0][1] == 50.0
    assert seen[0][0] in {w.filename for w in weights.WEIGHTS}


class _FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload
        self.headers = {'Content-Length': str(len(payload))}
        self._offset = 0

    def read(self, size):
        chunk = self._payload[self._offset:self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_a_download_writes_the_file_and_reports_as_it_goes(tmp_path, monkeypatch):
    payload = b'x' * (weights.CHUNK_BYTES * 2)
    monkeypatch.setattr(weights.urllib.request, 'urlopen',
                        lambda url, timeout=None: _FakeResponse(payload))

    seen = []
    path = weights._download_one(weights.WEIGHTS[0], str(tmp_path), seen.append)

    assert open(path, 'rb').read() == payload
    assert seen and seen[-1] == 100.0


def test_an_interrupted_download_leaves_nothing_behind(tmp_path, monkeypatch):
    """A half-written file must never be mistaken for a complete one."""
    def explode(url, timeout=None):
        raise urllib.error.URLError('connection reset')

    monkeypatch.setattr(weights.urllib.request, 'urlopen', explode)
    with pytest.raises(IOError):
        weights._download_one(weights.WEIGHTS[0], str(tmp_path), None)

    assert os.listdir(tmp_path) == []


def test_a_network_failure_says_to_check_the_network(tmp_path, monkeypatch):
    monkeypatch.setattr(weights.urllib.request, 'urlopen',
                        lambda url, timeout=None: (_ for _ in ()).throw(
                            urllib.error.URLError('no route to host')))
    with pytest.raises(IOError) as exc:
        weights._download_one(weights.WEIGHTS[0], str(tmp_path), None)
    assert 'network' in str(exc.value).lower()


def test_a_missing_release_says_the_release_moved(tmp_path, monkeypatch):
    """A 404 is not a network problem, and telling the user it is wastes an hour."""
    def not_found(url, timeout=None):
        raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)

    monkeypatch.setattr(weights.urllib.request, 'urlopen', not_found)
    with pytest.raises(IOError) as exc:
        weights._download_one(weights.WEIGHTS[0], str(tmp_path), None)
    message = str(exc.value)
    assert '404' in message and 'moved' in message
