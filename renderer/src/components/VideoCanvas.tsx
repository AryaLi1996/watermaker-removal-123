/**
 * VideoCanvas — Konva.js stage that renders the preview frame and an
 * interactive drag-resizable ROI bounding box.
 *
 * All coordinates exposed via onROIChange are in canvas pixels.
 * The parent is responsible for normalizing to video pixels.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect, Transformer } from 'react-konva';
import useImage from 'use-image';
import type Konva from 'konva';

interface VideoCanvasProps {
  /** file:// URL or absolute path to the preview PNG */
  previewSrc: string;
  containerWidth: number;
  containerHeight: number;
  onScaleChange: (scale: number) => void;
  onROIChange: (roi: { x: number; y: number; w: number; h: number }) => void;
}

const INITIAL_BOX_RATIO = 0.2; // default box is 20% of canvas width/height

export default function VideoCanvas({
  previewSrc,
  containerWidth,
  containerHeight,
  onScaleChange,
  onROIChange,
}: VideoCanvasProps) {
  const [image] = useImage(previewSrc);

  // Calculated stage dimensions & scale factor
  const [stageW, setStageW] = useState(containerWidth);
  const [stageH, setStageH] = useState(containerHeight);
  // ROI rect state (canvas pixels)
  const [rect, setRect] = useState({ x: 0, y: 0, width: 200, height: 100 });
  const [initialized, setInitialized] = useState(false);

  const rectRef = useRef<Konva.Rect>(null);
  const trRef = useRef<Konva.Transformer>(null);

  // Recalculate stage size & scale when image or container changes
  useEffect(() => {
    if (!image) return;

    const scaleX = containerWidth / image.width;
    const scaleY = containerHeight / image.height;
    const s = Math.min(scaleX, scaleY);

    const sw = Math.round(image.width * s);
    const sh = Math.round(image.height * s);

    setStageW(sw);
    setStageH(sh);
    onScaleChange(s);

    if (!initialized) {
      // Place default box at bottom-right, sized to 20% of frame
      const bw = Math.round(sw * INITIAL_BOX_RATIO);
      const bh = Math.round(sh * INITIAL_BOX_RATIO * 0.6);
      const bx = sw - bw - 16;
      const by = sh - bh - 16;
      const initial = { x: bx, y: by, width: bw, height: bh };
      setRect(initial);
      onROIChange({ x: initial.x, y: initial.y, w: initial.width, h: initial.height });
      setInitialized(true);
    }
  }, [image, containerWidth, containerHeight]);

  // Attach transformer to rect on mount
  useEffect(() => {
    if (rectRef.current && trRef.current) {
      trRef.current.nodes([rectRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [image]);

  const emitROI = useCallback((node: Konva.Rect) => {
    // Normalize scale back to 1 and store real pixel dimensions on the node.
    // Without this, Konva keeps accumulated scaleX/Y and on the next render
    // it multiplies again, causing the box to auto-resize.
    const newW = Math.round(node.width() * node.scaleX());
    const newH = Math.round(node.height() * node.scaleY());
    node.scaleX(1);
    node.scaleY(1);
    node.width(newW);
    node.height(newH);
    const r = { x: Math.round(node.x()), y: Math.round(node.y()), w: newW, h: newH };
    setRect({ x: r.x, y: r.y, width: r.w, height: r.h });
    onROIChange(r);
  }, [onROIChange]);

  return (
    <div style={{ background: '#000', display: 'inline-block' }}>
      <Stage width={stageW} height={stageH}>
        <Layer>
          {image && (
            <KonvaImage image={image} width={stageW} height={stageH} />
          )}

          {/* Dark overlay outside selected region */}
          {image && (
            <>
              {/* Top */}
              <Rect x={0} y={0} width={stageW} height={rect.y} fill="rgba(0,0,0,0.35)" listening={false} />
              {/* Bottom */}
              <Rect x={0} y={rect.y + rect.height} width={stageW} height={stageH - rect.y - rect.height} fill="rgba(0,0,0,0.35)" listening={false} />
              {/* Left */}
              <Rect x={0} y={rect.y} width={rect.x} height={rect.height} fill="rgba(0,0,0,0.35)" listening={false} />
              {/* Right */}
              <Rect x={rect.x + rect.width} y={rect.y} width={stageW - rect.x - rect.width} height={rect.height} fill="rgba(0,0,0,0.35)" listening={false} />
            </>
          )}

          {/* ROI selection rect */}
          {image && (
            <Rect
              ref={rectRef}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              stroke="#ffffff"
              strokeWidth={2}
              shadowColor="rgba(0,0,0,0.8)"
              shadowBlur={6}
              draggable
              onDragEnd={(e) => emitROI(e.target as Konva.Rect)}
              onTransformEnd={(e) => emitROI(e.target as Konva.Rect)}
              dragBoundFunc={(pos) => ({
                x: Math.max(0, Math.min(pos.x, stageW - rect.width)),
                y: Math.max(0, Math.min(pos.y, stageH - rect.height)),
              })}
            />
          )}

          {image && (
            <Transformer
              ref={trRef}
              enabledAnchors={[
                'top-left', 'top-center', 'top-right',
                'middle-left', 'middle-right',
                'bottom-left', 'bottom-center', 'bottom-right',
              ]}
              rotateEnabled={false}
              borderStroke="#ffffff"
              borderStrokeWidth={1}
              anchorFill="#ffffff"
              anchorStroke="#ffffff"
              anchorSize={8}
              anchorCornerRadius={1}
              keepRatio={false}
              boundBoxFunc={(_, newBox) => {
                const b = {
                  ...newBox,
                  width: Math.max(20, newBox.width),
                  height: Math.max(20, newBox.height),
                };
                // Clamp to stage boundaries
                if (b.x < 0) { b.width += b.x; b.x = 0; }
                if (b.y < 0) { b.height += b.y; b.y = 0; }
                if (b.x + b.width > stageW) b.width = stageW - b.x;
                if (b.y + b.height > stageH) b.height = stageH - b.y;
                return b;
              }}
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}
