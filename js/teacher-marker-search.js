const cropPosition = (center, size, cropSize) => Math.round(Math.max(0, Math.min(size - cropSize, center - cropSize / 2)));

function cropOffsets(size, cropSize) {
  const travel = size - cropSize;
  const steps = Math.ceil(travel / (cropSize * .75));
  return steps > 0 ? Array.from({ length: steps + 1 }, (_, index) => Math.round(travel * index / steps)) : [0];
}

function markerCenter(transform, dimensions, projection) {
  if (!transform || !dimensions) return null;
  const [width, height] = dimensions;
  const project = row => row[0] * width / 2 + row[1] * height / 2 + row[3];
  const depth = project(transform[2]);
  if (depth <= 0) return null;
  const x = projection[0][0] * project(transform[0]) / depth + projection[0][2];
  const y = projection[1][1] * project(transform[1]) / depth + projection[1][2];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function enableMotionRecovery(controller, now = () => performance.now()) {
  // These hooks belong to the bundled MindAR image tracker. Keep its pose
  // matcher and replace only the choice of which part of the frame to search.
  const { cropDetector: detector, inputWidth: width, inputHeight: height, projectionTransform } = controller;
  const cropSize = detector?.cropSize;
  if (typeof detector?._detect !== "function" || !projectionTransform || !(cropSize > 0 && cropSize <= Math.min(width, height))) return;
  const columns = cropOffsets(width, cropSize), rows = cropOffsets(height, cropSize);
  const tiles = columns.flatMap(x => rows.map(y => ({ x, y })));
  const centerX = cropPosition(width / 2, width, cropSize), centerY = cropPosition(height / 2, height, cropSize);
  if (!columns.includes(centerX) || !rows.includes(centerY)) tiles.push({ x: centerX, y: centerY });
  tiles.sort((a, b) => Math.hypot(a.x - centerX, a.y - centerY) - Math.hypot(b.x - centerX, b.y - centerY));

  let nextTile = 0, tryRecentPose = true, latest, previous;
  const onUpdate = controller.onUpdate;
  controller.onUpdate = update => {
    if (update.type === "updateMatrix" && update.worldMatrix) {
      const { targetIndex } = update;
      const state = controller.trackingStates[targetIndex];
      if (state?.isTracking) {
        const center = markerCenter(state.currentModelViewTransform, controller.markerDimensions[targetIndex], projectionTransform);
        if (center) {
          previous = latest?.targetIndex === targetIndex ? latest : null;
          latest = { ...center, targetIndex, time: now() };
          tryRecentPose = true;
        }
      }
    }
    onUpdate?.call(controller, update);
  };

  detector.detectMoving = input => {
    const age = latest ? now() - latest.time : Infinity;
    if (tryRecentPose && age < 220) {
      tryRecentPose = false;
      const interval = previous ? latest.time - previous.time : Infinity;
      const lead = interval >= 12 && interval <= 150 ? Math.min(age + 16, 75) / interval : 0;
      const limit = cropSize / 2;
      const predict = axis => latest[axis] + (lead ? Math.max(-limit, Math.min(limit, (latest[axis] - previous[axis]) * lead)) : 0);
      return detector._detect(input, cropPosition(predict("x"), width, cropSize), cropPosition(predict("y"), height, cropSize));
    }

    // Alternate recovery attempts with the normal sweep. Each pass still
    // searches one crop, and new markers can be found anywhere in the frame.
    tryRecentPose = true;
    const tile = tiles[nextTile];
    nextTile = (nextTile + 1) % tiles.length;
    return detector._detect(input, tile.x, tile.y);
  };
}
