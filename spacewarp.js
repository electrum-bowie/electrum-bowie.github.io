/* spacewarp.js
 * A-Frame system to enable WebXR Space Warp (AASW). See comments for details.
 */
AFRAME.registerSystem('spacewarp', {
  schema: { enabled: { type: 'boolean', default: true } },

  init: function () {
    if (!this.data.enabled || !navigator.xr) return;

    const sceneEl = this.sceneEl;
    const webxrSystem = sceneEl.systems.webxr;
    if (!webxrSystem) return;

    // Extend session configuration with layers and space-warp features.
    const config = Object.assign({}, webxrSystem.sessionConfiguration || {});
    config.requiredFeatures = config.requiredFeatures || ['local-floor'];
    if (!config.requiredFeatures.includes('layers')) config.requiredFeatures.push('layers');
    if (!config.requiredFeatures.includes('space-warp')) config.requiredFeatures.push('space-warp');
    if (webxrSystem.sessionConfiguration?.optionalFeatures) {
      config.optionalFeatures = webxrSystem.sessionConfiguration.optionalFeatures.slice();
    }
    webxrSystem.sessionConfiguration = config;

    // On session start: create projection layer and wrap animation loop.
    sceneEl.renderer.xr.addEventListener('sessionstart', (ev) => {
      const session = sceneEl.renderer.xr.getSession();
      const renderer = sceneEl.renderer;
      const gl = renderer.getContext();

      // Enable half‑float extension:contentReference[oaicite:9]{index=9}.
      gl.getExtension('EXT_color_buffer_half_float');

      // Create projection layer with textureType 'texture-array':contentReference[oaicite:10]{index=10}.
      const binding = new XRWebGLBinding(session, gl);
      const projectionLayer = binding.createProjectionLayer({
        textureType: 'texture-array',
        depthFormat: gl.DEPTH_COMPONENT24
      });
      session.updateRenderState({ layers: [projectionLayer] });

      // Save references for later.
      this.projectionLayer = projectionLayer;
      this.xrWebGLBinding = binding;
      this.prevMatrices = [];
      this.motionFramebuffer = gl.createFramebuffer();

      // Wrap renderer animation loop.  We call A‑Frame’s callback first
      // (colour pass), then run our motion‑vector pass.
      const originalSetAnimationLoop = renderer.setAnimationLoop.bind(renderer);
      renderer.setAnimationLoop = (callback) => {
        originalSetAnimationLoop((time, frame) => {
          callback(time, frame);
          this.renderSpaceWarpPasses(frame, renderer);
        });
      };
    });
  },

  /**
   * After the scene has rendered its colour buffer, perform a motion‑vector pass.
   */
  renderSpaceWarpPasses: function (frame, renderer) {
    if (!this.projectionLayer || !frame) return;

    const gl = renderer.getContext();
    const pose = frame.getViewerPose(this.sceneEl.renderer.xr.getReferenceSpace());
    if (!pose) return;

    // Build a list of views and their sub‑images.
    const views = [];
    for (const view of pose.views) {
      const subImage = this.xrWebGLBinding.getViewSubImage(this.projectionLayer, view);
      views.push({ view, subImage });
    }

    // For each view perform the motion‑vector pass.
    for (let i = 0; i < views.length; i++) {
      const { view, subImage } = views[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.motionFramebuffer);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, subImage.motionVectorTexture, 0, 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, subImage.depthStencilTexture, 0, 0);

      // Use motion‑vector texture resolution for viewport:contentReference[oaicite:11]{index=11}.
      const mvW = subImage.motionVectorTextureWidth;
      const mvH = subImage.motionVectorTextureHeight;
      gl.viewport(0, 0, mvW, mvH);
      gl.scissor(0, 0, mvW, mvH);
      gl.enable(gl.SCISSOR_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);

      // Previous matrices for velocity calculation (undefined on first frame).
      const prev = this.prevMatrices[i];
      const prevProj = prev ? prev.projectionMatrix : null;
      const prevView = prev ? prev.viewMatrix : null;

      // Render the scene again with motion‑vector materials.
      this.renderMotionVectors(renderer, this.sceneEl.object3D, this.sceneEl.camera, prevProj, prevView);

      // Save current matrices for next frame:contentReference[oaicite:12]{index=12}.
      this.prevMatrices[i] = {
        projectionMatrix: view.projectionMatrix.slice(),
        viewMatrix: view.transform.inverse.matrix.slice()
      };
    }
  },

  /**
   * Render every mesh in the scene using its `motionVectorMaterial` if defined,
   * otherwise output zero velocity.  You must supply suitable motion‑vector
   * materials for dynamic objects (e.g., gaussian splats).
   */
  renderMotionVectors: function (renderer, root, camera) {
    root.traverse((obj) => {
      if (obj.isMesh) {
        const originalMaterial = obj.material;
        let motionMaterial = originalMaterial.motionVectorMaterial;
        // Fallback zero‑velocity material (RGB=0).
        if (!motionMaterial) {
          motionMaterial = this.zeroVelocityMaterial || (this.zeroVelocityMaterial =
            new THREE.ShaderMaterial({
              vertexShader: `
                void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
              `,
              fragmentShader: `void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }`,
              depthTest: true,
              depthWrite: true
            }));
        }
        obj.material = motionMaterial;
        renderer.renderBufferDirect(camera, null, obj.geometry, obj.material, obj, null);
        obj.material = originalMaterial;
      }
    });
  }
});
