## VR Controls

Hold a single controller grip, trigger, or hand pinch to move the loaded splat. When both hands are gripping, pulling the trigger, or pinching the object, you can scale and rotate it by moving the hands relative to each other. The midpoint between the hands is used as the pivot for these transformations.

Hand tracking is also supported through WebXR. This site uses `webxr="optionalFeatures: hand-tracking, multiview; requiredFeatures: layers"` on the scene. Make sure the browser requests the `hand-tracking` feature and allow hand tracking permissions in the Quest. Once inside VR mode, close your hands into fists ("grip close" gesture) with both hands to start manipulating the splat, similar to squeezing the controller grip.
When supported, the page requests the `multiview` feature to take advantage of single-pass stereo rendering, reducing GPU overhead. The renderer now calls `makeXRCompatible` before checking for the `OVR_multiview2`, `OVR_multiview`, `OCULUS_multiview`, or `WEBGL_multiview` WebGL extensions to ensure compatibility across browsers.

## Performance Tips

Rendering millions of splats can strain mobile GPUs. Adjust the render
resolution using the `pixelRatio` and `xrPixelRatio` properties on the
`gaussian_splatting` component.

## XR Frame Synthesis

This project includes an experimental `xr-frame-synthesis` component that reprojects the last rendered frame to synthesize additional frames between real renders. It now performs asynchronous reprojection using the captured depth buffer and predicted viewer motion so fake frames are warped in 3D space. Set `fakeFrames` to control how many synthetic frames are inserted for each real frame.
