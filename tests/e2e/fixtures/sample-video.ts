/**
 * A real file for a spec to hand back from the mocked file dialog.
 *
 * These specs run against the stand-in backend, which never opens the video,
 * so for a long time any string would do and `/fake/clip.mp4` was the string.
 * The main process now checks that the file a job names is still there and
 * still readable before it spawns anything — a path like that one is exactly
 * what the check exists to refuse — so the dialog has to return something
 * real. The repository's own sample is the obvious candidate: it is what the
 * specs that do run the real pipeline already use.
 */
import fs from 'fs';
import path from 'path';

export const SAMPLE_VIDEO = path.join(__dirname, '..', '..', '..', 'sample', 'samplevideo.mp4');

if (!fs.existsSync(SAMPLE_VIDEO)) {
  throw new Error(`The sample video is missing from the checkout: ${SAMPLE_VIDEO}`);
}
