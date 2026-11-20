const cropPosition = (center, size, cropSize) => Math.round(Math.max(0, Math.min(size - cropSize, center - cropSize / 2)));
const STALE_POSE_MS = 150;
const RECOVER_NEARBY_MS = 650;

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

  let nextTile = 0, sweepPass = 0, tryRecentPose = true, latest, previous;
  // The match worker tries candidates in order and returns after the first
  // verified match. Keep all candidates eligible when switching lessons.
  const workerMatch = controller._workerMatch;
  if (typeof workerMatch === "function") {
    controller._workerMatch = (points, indexes) => {
      const recent = latest?.targetIndex;
      if (recent === undefined || indexes[0] === recent || !indexes.includes(recent)) {
        return workerMatch.call(controller, points, indexes);
      }
      return workerMatch.call(controller, points, [recent, ...indexes.filter(index => index !== recent)]);
    };
  }

  const livePoses = new Map();
  const onUpdate = controller.onUpdate;
  function expireStalePoses() {
    if (!livePoses.size) return;
    const time = now();
    for (const [targetIndex, pose] of livePoses) {
      if (!pose.missed || time - pose.lastSeen < STALE_POSE_MS) continue;
      livePoses.delete(targetIndex);
      onUpdate?.call(controller, { type: "updateMatrix", targetIndex, worldMatrix: null });
    }
  }

  controller.onUpdate = update => {
    if (update.type !== "updateMatrix") {
      onUpdate?.call(controller, update);
      return;
    }
    const { targetIndex, worldMatrix } = update;
    if (!worldMatrix) {
      livePoses.delete(targetIndex);
      onUpdate?.call(controller, update);
      return;
    }
    const state = controller.trackingStates[targetIndex];
    const pose = livePoses.get(targetIndex);
    // MindAR repeats its old matrix during missed frames. A repeated stale
    // matrix should neither move the model nor renew its tracking badge.
    if (!state?.isTracking) {
      if (pose) pose.missed = true;
      expireStalePoses();
      return;
    }

    const time = now();
    if (pose) {
      pose.lastSeen = time;
      pose.missed = false;
    } else livePoses.set(targetIndex, { lastSeen: time, missed: false });
    const center = markerCenter(state.currentModelViewTransform, controller.markerDimensions[targetIndex], projectionTransform);
    if (center) {
      previous = latest?.targetIndex === targetIndex ? latest : null;
      latest = { ...center, targetIndex, time };
      tryRecentPose = true;
    }
    onUpdate?.call(controller, update);
  };

  detector.detectMoving = input => {
    const age = latest ? now() - latest.time : Infinity;
    if (tryRecentPose && age < RECOVER_NEARBY_MS) {
      tryRecentPose = false;
      const interval = previous ? latest.time - previous.time : Infinity;
      const lead = age < 180 && interval >= 12 && interval <= 150 ? Math.min(age + 16, 75) / interval : 0;
      const limit = cropSize / 2;
      const predict = axis => latest[axis] + (lead ? Math.max(-limit, Math.min(limit, (latest[axis] - previous[axis]) * lead)) : 0);
      return detector._detect(input, cropPosition(predict("x"), width, cropSize), cropPosition(predict("y"), height, cropSize));
    }

    // Alternate recovery attempts with the normal sweep. Each pass still
    // searches one crop, and new markers can be found anywhere in the frame.
    tryRecentPose = true;
    // Return to the center during a sweep so a marker held up to the camera
    // does not have to wait for every edge tile to be checked.
    sweepPass = (sweepPass + 1) % 4;
    if (sweepPass === 0 && nextTile !== 0) return detector._detect(input, centerX, centerY);
    const tile = tiles[nextTile];
    nextTile = (nextTile + 1) % tiles.length;
    return detector._detect(input, tile.x, tile.y);
  };

  return expireStalePoses;
}
