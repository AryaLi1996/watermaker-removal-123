"""
OpenCV image processing engines.
All functions are pure (no I/O). Frame arrays are numpy uint8 BGR images.
"""
import cv2
import numpy as np


def create_mask(width: int, height: int, x: int, y: int, w: int, h: int) -> np.ndarray:
    """
    Return a binary uint8 mask of shape (height, width).
    The ROI rectangle is white (255); everything else is black (0).
    Generated once and reused for every frame to avoid repeated allocation.
    """
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.rectangle(mask, (x, y), (x + w, y + h), 255, thickness=-1)
    return mask


def clamp_roi(
    frame_width: int,
    frame_height: int,
    x: int,
    y: int,
    w: int,
    h: int,
) -> tuple[int, int, int, int]:
    """
    Clip an ROI rectangle to the frame. The UI works in scaled canvas pixels,
    so rounding on the way back to video pixels can push the box a pixel or two
    past the edge; without clipping that yields an empty numpy slice and an
    OpenCV error deep in a worker.

    Raises ValueError only when nothing of the ROI overlaps the frame, which
    means the caller sent a genuinely bad rectangle.
    """
    nx = max(0, min(x, frame_width))
    ny = max(0, min(y, frame_height))
    nw = min(w + min(0, x), frame_width - nx)
    nh = min(h + min(0, y), frame_height - ny)

    if nw <= 0 or nh <= 0:
        raise ValueError(
            f"Selection ({x},{y},{w}x{h}) lies outside the "
            f"{frame_width}x{frame_height} frame."
        )
    return nx, ny, nw, nh


def clamp_clone_offset(
    frame_width: int,
    frame_height: int,
    x: int,
    y: int,
    w: int,
    h: int,
    dx: int,
    dy: int,
) -> tuple[int, int]:
    """
    Shift a clone-stamp offset so the source region stays inside the frame.

    The user asked to copy nearby pixels; nudging the source back in-frame is
    more useful than failing the whole job because the default offset happens
    to point off the top edge.
    """
    sx = max(0, min(x + dx, frame_width - w))
    sy = max(0, min(y + dy, frame_height - h))
    return sx - x, sy - y


# Extra pixels kept around the ROI when inpainting a crop of the frame.
# TELEA fills a masked pixel from known pixels no further than `radius` away,
# so anything beyond radius + 1 of the selection cannot influence the result.
# The few pixels on top are slack against rounding inside OpenCV.
INPAINT_MARGIN = 8


def process_inpaint(
    frame: np.ndarray,
    mask: np.ndarray,
    radius: int = 3,
    roi: tuple[int, int, int, int] | None = None,
) -> np.ndarray:
    """
    TELEA inpainting: intelligently reconstructs the masked region by
    propagating texture inward from the boundary. Best for logos on
    textured backgrounds. Radius 3–7 px is recommended.

    Only the neighbourhood of the selection is passed to OpenCV, never the
    whole frame. Part of TELEA's cost follows the image it is handed rather
    than the area being filled, so a small mark on a large frame was paying
    for the frame on every frame: measured at 3x faster for a 90x40 selection
    on 1080p, and a few percent for a selection large enough to dominate the
    cost by itself. It is never slower — the crop is at most the frame.

    The margin covers every pixel the algorithm could read, so the result is
    the same image inpainting the whole frame produced.

    `roi` is the already-clamped selection; without it the bounding box of the
    mask is used, which is the same rectangle.
    """
    if roi is None:
        x, y, w, h = cv2.boundingRect(mask)
        if w == 0 or h == 0:
            return frame.copy()  # nothing masked, nothing to reconstruct
    else:
        x, y, w, h = roi

    height, width = frame.shape[:2]
    margin = int(radius) + INPAINT_MARGIN
    x0, y0 = max(0, x - margin), max(0, y - margin)
    x1, y1 = min(width, x + w + margin), min(height, y + h + margin)

    # OpenCV needs contiguous buffers; a slice of the frame is not one.
    patch = np.ascontiguousarray(frame[y0:y1, x0:x1])
    patch_mask = np.ascontiguousarray(mask[y0:y1, x0:x1])

    result = frame.copy()
    result[y0:y1, x0:x1] = cv2.inpaint(patch, patch_mask, radius, cv2.INPAINT_TELEA)
    return result


def process_blur(frame: np.ndarray, x: int, y: int, w: int, h: int, kernel_size: int = 51) -> np.ndarray:
    """
    Gaussian-blur the ROI in-place. `kernel_size` must be an odd positive integer.
    Returns the modified frame (copy).
    """
    result = frame.copy()
    if kernel_size % 2 == 0:
        kernel_size += 1  # ensure odd
    roi = result[y : y + h, x : x + w]
    blurred = cv2.GaussianBlur(roi, (kernel_size, kernel_size), 0)
    result[y : y + h, x : x + w] = blurred
    return result


def process_solid_fill(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    color: tuple[int, int, int] = (0, 0, 0),
) -> np.ndarray:
    """
    Paint a solid rectangle over the ROI.
    `color` is an (R, G, B) tuple; OpenCV uses BGR internally so we swap.
    """
    result = frame.copy()
    bgr = (color[2], color[1], color[0])
    cv2.rectangle(result, (x, y), (x + w, y + h), bgr, thickness=-1)
    return result


def process_clone_stamp(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    dx: int,
    dy: int,
) -> np.ndarray:
    """
    Copy a nearby region (offset by dx, dy) over the watermark ROI.
    Validates that the source region stays within frame bounds.
    """
    height, width = frame.shape[:2]
    sx, sy = x + dx, y + dy

    # Clamp source to frame bounds
    if sx < 0 or sy < 0 or sx + w > width or sy + h > height:
        raise ValueError(
            f"Clone stamp source region ({sx},{sy},{w},{h}) is outside "
            f"the frame bounds ({width}x{height})."
        )

    result = frame.copy()
    result[y : y + h, x : x + w] = frame[sy : sy + h, sx : sx + w]
    return result


def apply_removal(
    frame: np.ndarray,
    mask: np.ndarray,
    config: dict,
    neighbor_at=None,
    on_degraded=None,
) -> np.ndarray:
    """
    Dispatch to the correct removal engine based on config['method'].
    config keys: method, roi (x,y,w,h), radius, kernelSize, color, dx, dy,
    temporalQuality.

    `neighbor_at` is how the temporal engine reaches the frames around this
    one: called with a signed frame offset, it returns that frame or None.
    Every other engine works from this frame alone and ignores it.

    `on_degraded` is how it reports back that a failure forced this frame onto
    the single-frame fill. Only the temporal engine can degrade this way; the
    others either work or raise.
    """
    method = config.get('method', 'inpaint')
    roi = config['roi']
    height, width = frame.shape[:2]
    x, y, w, h = clamp_roi(width, height, roi['x'], roi['y'], roi['w'], roi['h'])

    if method == 'inpaint':
        return process_inpaint(frame, mask, radius=config.get('radius', 3),
                               roi=(x, y, w, h))
    elif method == 'blur':
        return process_blur(frame, x, y, w, h, kernel_size=config.get('kernelSize', 51))
    elif method == 'solidFill':
        color = tuple(config.get('color', [0, 0, 0]))
        return process_solid_fill(frame, x, y, w, h, color=color)
    elif method == 'temporal':
        # Imported on use, not at module scope: temporal_core imports this
        # module for its fallback fill, and the engines above have no need of
        # the optical-flow machinery it brings with it.
        from temporal_core import DEFAULT_QUALITY, process_temporal  # noqa: PLC0415
        return process_temporal(
            frame, mask, (x, y, w, h),
            neighbor_at if neighbor_at is not None else lambda _offset: None,
            quality=config.get('temporalQuality', DEFAULT_QUALITY),
            fallback_radius=config.get('radius', 3),
            on_degraded=on_degraded,
        )
    elif method == 'cloneStamp':
        dx, dy = clamp_clone_offset(width, height, x, y, w, h,
                                    dx=config.get('dx', 0),
                                    dy=config.get('dy', -50))
        return process_clone_stamp(frame, x, y, w, h, dx=dx, dy=dy)
    else:
        raise ValueError(f"Unknown removal method: {method!r}")
