"""
Unit tests for backend/cloud_fill.py — what crosses the wire, and what is
believed about what comes back.

No network here: the format is pure functions over arrays and bytes, which is
why it is separable from the request at all. The point of testing it this way
is that a client and a service can disagree about the format without either
being obviously wrong, so the format gets its own test.
"""
import base64
import json

import cv2
import numpy as np
import pytest

import cloud_fill


def _mark(width: int = 60, height: int = 40) -> np.ndarray:
    """A mark that sits well inside its selection, as a real one does."""
    mark = np.zeros((height, width), np.uint8)
    mark[12:20, 18:44] = 1
    mark[24:28, 22:38] = 1
    return mark


def test_a_selection_with_no_mark_has_nothing_to_send():
    assert cloud_fill.parcel_for(np.zeros((20, 20), np.uint8)) is None


def test_the_parcel_covers_the_mark():
    mark = _mark()
    parcel = cloud_fill.parcel_for(mark)
    x, y, w, h = parcel.box
    assert parcel.mask.shape == (h, w)
    # every marked pixel of the selection is inside the parcel, and the
    # parcel's own mask agrees about which ones they are
    assert np.array_equal(parcel.mask, (mark[y:y + h, x:x + w] > 0).astype(np.uint8))
    assert parcel.mask.sum() == mark.sum()


def test_the_parcel_carries_clean_picture_around_the_mark():
    """
    A crop flush against the mark leaves the filler less to reason from. This
    is worth little — measured, the difference is 0.004 against -0.017 on a
    scale where the untouched input is 0.866 — but it is not nothing, and the
    margin is cheap.
    """
    mark = _mark()
    parcel = cloud_fill.parcel_for(mark)
    x, y, w, h = parcel.box
    ys, xs = np.nonzero(mark)
    assert x < xs.min() and y < ys.min()
    assert x + w > xs.max() + 1 and y + h > ys.max() + 1


def test_the_parcel_stays_inside_the_selection():
    """A mark against the edge is ordinary: a logo in a corner."""
    mark = np.zeros((30, 30), np.uint8)
    mark[:4, :4] = 1
    x, y, w, h = cloud_fill.parcel_for(mark).box
    assert x == 0 and y == 0
    assert x + w <= 30 and y + h <= 30


def _picture(height: int = 40, width: int = 60) -> np.ndarray:
    """
    Something with the structure a frame has. Not noise: the patches are
    encoded lossily, and noise is the one thing that cannot survive that — it
    would be testing the codec's worst case rather than ours.
    """
    rng = np.random.default_rng(4)
    patch = np.zeros((height, width, 3), np.uint8)
    patch[..., 0] = np.linspace(30, 220, width, dtype=np.float32)[None, :]
    patch[..., 1] = np.linspace(200, 40, height, dtype=np.float32)[:, None]
    for _ in range(8):
        cv2.circle(patch, (int(rng.integers(0, width)), int(rng.integers(0, height))),
                   int(rng.integers(3, 9)),
                   tuple(int(v) for v in rng.integers(30, 220, 3)), -1)
    return patch


def test_a_patch_survives_the_round_trip():
    patch = _picture()
    back = cloud_fill.decode_patch(cloud_fill.encode_patch(patch), patch.shape[:2])
    assert back.shape == patch.shape
    # lossy on purpose; this is about the format, not the fidelity
    assert np.abs(back.astype(int) - patch.astype(int)).mean() < 6


def test_the_mask_survives_the_round_trip_exactly():
    """A mask that loses a pixel leaves a mark behind, so it is not lossy."""
    mask = _mark()
    raw = base64.b64decode(cloud_fill.encode_mask(mask))
    back = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert np.array_equal((back > 127).astype(np.uint8), mask)


def test_a_request_says_what_the_service_expects():
    parcel = cloud_fill.parcel_for(_mark())
    x, y, w, h = parcel.box
    patches = [np.full((h, w, 3), v, np.uint8) for v in (30, 60, 90)]
    payload = json.loads(cloud_fill.request_body(parcel, patches))
    assert set(payload) == {'mask_png', 'frames_webp'}
    assert len(payload['frames_webp']) == 3
    for blob in payload['frames_webp']:
        base64.b64decode(blob, validate=True)


def test_a_reply_of_the_wrong_length_is_refused():
    parcel = cloud_fill.parcel_for(_mark())
    x, y, w, h = parcel.box
    body = json.dumps({'frames_webp': [
        cloud_fill.encode_patch(np.zeros((h, w, 3), np.uint8))]}).encode()
    with pytest.raises(ValueError, match='asked for 2'):
        cloud_fill.read_reply(body, parcel, 2)


def test_a_reply_of_the_wrong_size_is_refused():
    """
    Silently accepting it would paste a differently-sized patch into the
    frame, or resize it, and either would be a corruption no one asked for.
    """
    parcel = cloud_fill.parcel_for(_mark())
    body = json.dumps({'frames_webp': [
        cloud_fill.encode_patch(np.zeros((8, 8, 3), np.uint8))]}).encode()
    with pytest.raises(ValueError, match='where'):
        cloud_fill.read_reply(body, parcel, 1)


def test_a_reply_that_is_not_a_list_is_refused():
    parcel = cloud_fill.parcel_for(_mark())
    with pytest.raises(ValueError, match='list of frames'):
        cloud_fill.read_reply(json.dumps({'frames_webp': 'no'}).encode(), parcel, 1)


def test_a_good_reply_comes_back_as_patches():
    parcel = cloud_fill.parcel_for(_mark())
    x, y, w, h = parcel.box
    sent = [np.full((h, w, 3), 77, np.uint8) for _ in range(2)]
    body = json.dumps({'frames_webp': [cloud_fill.encode_patch(p) for p in sent]}).encode()
    back = cloud_fill.read_reply(body, parcel, 2)
    assert len(back) == 2
    assert all(p.shape == (h, w, 3) for p in back)


def test_a_clip_is_split_into_requests_that_cover_it_once():
    spans = list(cloud_fill.batches(1000, size=240))
    assert spans[0][0] == 0 and spans[-1][1] == 1000
    assert all(b == spans[i + 1][0] for i, (_, b) in enumerate(spans[:-1]))
    assert all(hi - lo <= 240 for lo, hi in spans)


# ─── Where the pixels may go ────────────────────────────────────────────────

def test_a_plain_http_endpoint_is_refused():
    """
    What the user agreed to was one named service over a link nobody else can
    read. Settling for less is the one failure they cannot see happening.
    """
    with pytest.raises(ValueError, match='https'):
        cloud_fill.check_endpoint('http://fill.example.com/inpaint')


def test_https_is_what_the_service_is_reached_over():
    cloud_fill.check_endpoint('https://fill.example.com/inpaint')


def test_a_stub_on_this_machine_needs_no_certificate():
    """Only loopback, and only so a test does not need one."""
    cloud_fill.check_endpoint('http://127.0.0.1:8080/inpaint')
    cloud_fill.check_endpoint('http://localhost:8080/inpaint')


def test_anything_else_is_refused():
    for url in ('ftp://host/x', 'file:///etc/passwd', 'x://y', ''):
        with pytest.raises(ValueError):
            cloud_fill.check_endpoint(url)


# ─── Asking the service ─────────────────────────────────────────────────────

def _parcel_and_patches(count: int = 3):
    mark = np.zeros((40, 60), np.uint8)
    mark[12:22, 18:40] = 1
    parcel = cloud_fill.parcel_for(mark)
    rng = np.random.default_rng(5)
    patches = [rng.integers(0, 255, (parcel.box[3], parcel.box[2], 3), dtype=np.uint8)
               for _ in range(count)]
    return parcel, patches


def test_fill_asks_once_per_batch_and_keeps_the_order():
    parcel, patches = _parcel_and_patches(5)
    asked = []

    def transport(url, body, token, timeout):
        asked.append(json.loads(body.decode())['frames_webp'])
        sent = [cloud_fill.decode_patch(b, (parcel.box[3], parcel.box[2]))
                for b in asked[-1]]
        # Answer with a frame the caller can tell apart from what it sent.
        # Spaced well apart because the wire format is lossy: the point is
        # which frame came back where, not that a level survived exactly.
        return json.dumps({'frames_webp': [
            cloud_fill.encode_patch(np.full_like(p, 20 + 50 * i))
            for i, p in enumerate(sent)
        ]}).encode()

    filled = cloud_fill.fill(parcel, patches, 'https://x/inpaint',
                             transport=transport)
    assert len(asked) == 1, 'five frames is one batch'
    assert len(filled) == 5
    assert [round(float(f.mean()) / 50) for f in filled] == [0, 1, 2, 3, 4]


def test_fill_splits_a_long_clip_into_batches():
    parcel, patches = _parcel_and_patches(cloud_fill.FRAMES_PER_REQUEST + 2)
    sizes = []

    def transport(url, body, token, timeout):
        sent = json.loads(body.decode())['frames_webp']
        sizes.append(len(sent))
        return json.dumps({'frames_webp': sent}).encode()

    cloud_fill.fill(parcel, patches, 'https://x/inpaint', transport=transport)
    assert sizes == [cloud_fill.FRAMES_PER_REQUEST, 2]


def test_fill_carries_the_token_where_there_is_one():
    parcel, patches = _parcel_and_patches(1)
    seen = {}

    def transport(url, body, token, timeout):
        seen['token'] = token
        return json.dumps({'frames_webp': json.loads(body.decode())['frames_webp']}).encode()

    cloud_fill.fill(parcel, patches, 'https://x/inpaint', token='abc',
                    transport=transport)
    assert seen['token'] == 'abc'


def test_fill_does_not_hand_back_something_half_right():
    """
    The caller's job is to fall back and say so, and it can only do that if a
    short or malformed answer raises rather than being quietly accepted.
    """
    parcel, patches = _parcel_and_patches(3)

    def short(url, body, token, timeout):
        sent = json.loads(body.decode())['frames_webp']
        return json.dumps({'frames_webp': sent[:1]}).encode()

    with pytest.raises(ValueError, match='asked for 3'):
        cloud_fill.fill(parcel, patches, 'https://x/inpaint', transport=short)
