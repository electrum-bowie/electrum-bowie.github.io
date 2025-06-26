## VR Controls

Hold a single controller grip, trigger, or hand pinch to move the loaded splat. When both hands are gripping, pulling the trigger, or pinching the object, you can scale and rotate it by moving the hands relative to each other. The midpoint between the hands is used as the pivot for these transformations.

Hand tracking is also supported through WebXR. This site uses `webxr="optionalFeatures: hand-tracking"` on the scene. Make sure the browser requests the `hand-tracking` feature and allow hand tracking permissions in the Quest. Once inside VR mode, close your hands into fists ("grip close" gesture) with both hands to start manipulating the splat, similar to squeezing the controller grip.

## Performance Tips

Rendering millions of splats can strain mobile GPUs. The viewer now
includes an optional dynamic pixel ratio feature that automatically lowers
render resolution when frame rate drops. It targets 60&nbsp;fps by default.
Use the `autoPixelRatio` and `targetFps` properties on the
`gaussian_splatting` component to adjust or disable this behaviour.
