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


def process_inpaint(frame: np.ndarray, mask: np.ndarray, radius: int = 3) -> np.ndarray:
    """
    TELEA inpainting: intelligently reconstructs the masked region by
    propagating texture inward from the boundary. Best for logos on
    textured backgrounds. Radius 3–7 px is recommended.
    """
    return cv2.inpaint(frame, mask, radius, cv2.INPAINT_TELEA)


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
) -> np.ndarray:
    """
    Dispatch to the correct removal engine based on config['method'].
    config keys: method, roi (x,y,w,h), radius, kernelSize, color, dx, dy
    """
    method = config.get('method', 'inpaint')
    roi = config['roi']
    x, y, w, h = roi['x'], roi['y'], roi['w'], roi['h']

    if method == 'inpaint':
        return process_inpaint(frame, mask, radius=config.get('radius', 3))
    elif method == 'blur':
        return process_blur(frame, x, y, w, h, kernel_size=config.get('kernelSize', 51))
    elif method == 'solidFill':
        color = tuple(config.get('color', [0, 0, 0]))
        return process_solid_fill(frame, x, y, w, h, color=color)
    elif method == 'cloneStamp':
        return process_clone_stamp(frame, x, y, w, h,
                                    dx=config.get('dx', 0),
                                    dy=config.get('dy', -50))
    else:
        raise ValueError(f"Unknown removal method: {method!r}")
