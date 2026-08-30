/**
 * VideoCanvas — Konva.js stage that renders the preview frame and an
 * interactive drag-resizable ROI bounding box.
 *
 * All coordinates exposed via onROIChange are in canvas pixels.
 * The parent is responsible for normalizing to video pixels.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect, Transformer } from 'react-konva';
import useImage from 'use-image';
import type Konva from 'konva';

interface VideoCanvasProps {
  /** URL of the preview PNG, as built by `mediaUrl` */
  previewSrc: string;
  containerWidth: number;
  containerHeight: number;
  onScaleChange: (scale: number) => void;
  onROIChange: (roi: { x: number; y: number; w: number; h: number }) => void;
}

const INITIAL_BOX_RATIO = 0.2; // default box is 20% of canvas width/height
const MIN_BOX = 20;

export default function VideoCanvas({
  previewSrc,
  containerWidth,
  containerHeight,
  onScaleChange,
  onROIChange,
}: VideoCanvasProps) {
  const [image] = useImage(previewSrc);

  // Stage dimensions and scale are derived from the image and the container —
  // no state, so a resize can never leave them stale.
  const { stageW, stageH, scale } = useMemo(() => {
    if (!image) return { stageW: containerWidth, stageH: containerHeight, scale: 1 };
    const s = Math.min(containerWidth / image.width, containerHeight / image.height);
    return {
      stageW: Math.round(image.width * s),
      stageH: Math.round(image.height * s),
      scale: s,
    };
  }, [image, containerWidth, containerHeight]);

  // The user's box, in canvas pixels. Null until they move or resize it, so the
  // default box below follows the stage while it is untouched.
  const [userRect, setUserRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // Default box: 20% of the frame, tucked into the bottom-right corner where
  // watermarks usually sit.
  const rect = useMemo(() => {
    if (userRect) return userRect;
    const width = Math.max(MIN_BOX, Math.round(stageW * INITIAL_BOX_RATIO));
    const height = Math.max(MIN_BOX, Math.round(stageH * INITIAL_BOX_RATIO * 0.6));
    return { x: Math.max(0, stageW - width - 16), y: Math.max(0, stageH - height - 16), width, height };
  }, [userRect, stageW, stageH]);

  const rectRef = useRef<Konva.Rect>(null);
  const trRef = useRef<Konva.Transformer>(null);

  // Report the current scale and ROI up to the parent whenever they change.
  useEffect(() => {
    if (!image) return;
    onScaleChange(scale);
  }, [image, scale, onScaleChange]);

  useEffect(() => {
    if (!image) return;
    onROIChange({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
  }, [image, rect, onROIChange]);

  // Attach the transformer to the rect once the image (and so the rect) exists
  useEffect(() => {
    if (rectRef.current && trRef.current) {
      trRef.current.nodes([rectRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [image]);

  const commitRect = useCallback((node: Konva.Rect) => {
    // Normalize scale back to 1 and store real pixel dimensions on the node.
    // Without this, Konva keeps accumulated scaleX/Y and on the next render
    // it multiplies again, causing the box to auto-resize.
    const width = Math.round(node.width() * node.scaleX());
    const height = Math.round(node.height() * node.scaleY());
    node.scaleX(1);
    node.scaleY(1);
    node.width(width);
    node.height(height);
    setUserRect({ x: Math.round(node.x()), y: Math.round(node.y()), width, height });
  }, []);

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
              onDragEnd={(e) => commitRect(e.target as Konva.Rect)}
              onTransformEnd={(e) => commitRect(e.target as Konva.Rect)}
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
                  width: Math.max(MIN_BOX, newBox.width),
                  height: Math.max(MIN_BOX, newBox.height),
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
