## VR Controls

Hold a single controller grip, trigger, or hand pinch to move the loaded splat. When both hands are gripping, pulling the trigger, or pinching the object, you can scale and rotate it by moving the hands relative to each other. The midpoint between the hands is used as the pivot for these transformations.

Hand tracking is also supported through WebXR. This site uses `webxr="optionalFeatures: hand-tracking; requiredFeatures: layers, space-warp"` on the scene. Make sure the browser requests the `hand-tracking` feature and allow hand tracking permissions in the Quest. Once inside VR mode, close your hands into fists ("grip close" gesture) with both hands to start manipulating the splat, similar to squeezing the controller grip.

The `space-warp` option attempts to enable space warp on compatible browsers. When available, space warp can generate intermediate frames so the application can run at a lower frame rate while maintaining smooth visuals. The session's render state is updated when VR mode starts, enabling space warp. When supported, the code sets the frame rate to 45&nbsp;FPS and logs the initialization steps so it's easy to track if anything fails. The feature is requested as required so VR sessions fail clearly if unsupported. See the [space-warp extension documentation](https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#space-warp) for details.

## Performance Tips

Rendering millions of splats can strain mobile GPUs. Adjust the render
resolution using the `pixelRatio` and `xrPixelRatio` properties on the
`gaussian_splatting` component.
