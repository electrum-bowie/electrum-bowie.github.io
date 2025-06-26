## VR Controls

Hold a single controller grip, trigger, or hand pinch to move the loaded splat. When both hands are gripping, pulling the trigger, or pinching the object, you can scale and rotate it by moving the hands relative to each other. The midpoint between the hands is used as the pivot for these transformations.

Hand tracking is also supported through WebXR. This site uses `webxr="optionalFeatures: hand-tracking"` on the scene. Make sure the browser requests the `hand-tracking` feature and allow hand tracking permissions in the Quest. Once inside VR mode, close your hands into fists ("grip close" gesture) with both hands to start manipulating the splat, similar to squeezing the controller grip.

### Sorting Threshold

`gaussian_splatting` only re-sorts splats when the camera direction or scale changes
by more than `sortThreshold` (default `0.01`). Increase this value if VR head jitter
causes unnecessary updates.
