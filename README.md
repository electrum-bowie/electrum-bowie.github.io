## VR Controls

Hold a single controller grip, trigger, or hand pinch to move the loaded splat. When both hands are gripping, pulling the trigger, or pinching the object, you can scale it and rotate it around either the vertical (Y) axis or the axis defined by the line between your hands. The component chooses the axis that best matches how you twist the controllers, using the midpoint between the hands as the pivot.

Hand tracking is also supported through WebXR. This site uses `webxr="optionalFeatures: hand-tracking, multiview; requiredFeatures: layers"` on the scene. Make sure the browser requests the `hand-tracking` feature and allow hand tracking permissions in the Quest. Once inside VR mode, close your hands into fists ("grip close" gesture) with both hands to start manipulating the splat, similar to squeezing the controller grip.
When supported, the page requests the `multiview` feature to take advantage of single-pass stereo rendering, reducing GPU overhead. The renderer now calls `makeXRCompatible` before checking for the `OVR_multiview2`, `OVR_multiview`, `OCULUS_multiview`, or `WEBGL_multiview` WebGL extensions to ensure compatibility across browsers. **Make sure your scene enables multiview by setting `renderer="multiviewStereo: true"`; otherwise the component will log "Multiview not supported" even if your browser supports the feature.**

## Performance Tips

Rendering millions of splats can strain mobile GPUs. Adjust the render
resolution using the `pixelRatio` and `xrPixelRatio` properties on the
`gaussian_splatting` component.
Depth sorting now triggers automatically when the splat or camera moves or rotates more than `0.001` units.
