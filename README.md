## VR Controls

Hold a single controller grip, trigger, or hand pinch to move the loaded splat. When both hands are gripping, pulling the trigger, or pinching the object, you can scale it and rotate it around either the vertical (Y) axis or the axis defined by the line between your hands. The component chooses the axis that best matches how you twist the controllers, using the midpoint between the hands as the pivot.

## Desktop Controls

When using a mouse, the scroll wheel scales the splat. Scrolling up enlarges the splat and scrolling down shrinks it. Scaling is limited by default between `0.00000001` and `100000000000000000000` but can be configured via the `minScale` and `maxScale` component properties.
