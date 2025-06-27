// Space Warp support for A-Frame scenes
// Integrates WebXR Space Warp using layers and motion vectors

import { mat4, vec3, quat } from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/esm/index.js';

AFRAME.registerSystem('space-warp', {
  init: function () {
    const sceneEl = this.sceneEl;
    const renderer = sceneEl.renderer;
    if (!renderer) return;

    const init = renderer.xr.getSessionInit ? (renderer.xr.getSessionInit() || {}) : {};
    init.requiredFeatures = init.requiredFeatures || [];
    init.optionalFeatures = init.optionalFeatures || [];
    if (!init.requiredFeatures.includes('layers')) init.requiredFeatures.push('layers');
    if (!init.requiredFeatures.includes('space-warp')) init.requiredFeatures.push('space-warp');
    renderer.xr.setSessionInit(init);

    renderer.xr.addEventListener('sessionstart', this.onSessionStart.bind(this));
    renderer.xr.addEventListener('sessionend', this.onSessionEnd.bind(this));

    this.prevMatrices = [];
    this.prevPose = null;
  },

  onSessionStart: function () {
    const renderer = this.sceneEl.renderer;
    const session = renderer.xr.getSession();
    const gl = renderer.getContext();

    gl.getExtension('EXT_color_buffer_half_float');
    this.mvExt = gl.getExtension('OCULUS_multiview') || gl.getExtension('OVR_multiview2');

    this.binding = new XRWebGLBinding(session, gl);
    this.layer = this.binding.createProjectionLayer({
      textureType: 'texture-array',
      depthFormat: gl.DEPTH_COMPONENT24
    });
    session.updateRenderState({ layers: [this.layer] });

    this.framebuffer = gl.createFramebuffer();
    this.motionFramebuffer = gl.createFramebuffer();

    this.origLoop = renderer.getAnimationLoop();
    renderer.setAnimationLoop((time, frame) => {
      this.onXRFrame(time, frame);
      if (this.origLoop) this.origLoop(time, frame);
    });

    this.refSpace = renderer.xr.getReferenceSpace();
  },

  onSessionEnd: function () {
    const renderer = this.sceneEl.renderer;

    renderer.setAnimationLoop(this.origLoop || null);

    this.prevPose = null;
    this.prevMatrices = [];
  },

  quaternionRotate: function (out, a, v) {
    quat.set(this.qQuat, v[0], v[1], v[2], 0);
    quat.multiply(this.aqQuat, a, this.qQuat);
    quat.conjugate(this.aConj, a);
    quat.multiply(this.aqaConj, this.aqQuat, this.aConj);
    out[0] = this.aqaConj[0];
    out[1] = this.aqaConj[1];
    out[2] = this.aqaConj[2];
  },

  multiplyPrevPose: function (currPose) {
    quat.set(this.currentOrientation, currPose.orientation.x, currPose.orientation.y, currPose.orientation.z, currPose.orientation.w);
    quat.multiply(this.tmpOrientation, this.prevOrientationInv, this.currentOrientation);
    vec3.set(this.tmpPosition, currPose.position.x, currPose.position.y, currPose.position.z);
    this.quaternionRotate(this.tmpPosition, this.prevOrientationInv, this.tmpPosition);
    const position = new DOMPointReadOnly(
      this.tmpPosition[0] + this.prevPositionInv[0],
      this.tmpPosition[1] + this.prevPositionInv[1],
      this.tmpPosition[2] + this.prevPositionInv[2]
    );
    const orientation = new DOMPointReadOnly(this.tmpOrientation[0], this.tmpOrientation[1], this.tmpOrientation[2], this.tmpOrientation[3]);
    return new XRRigidTransform(position, orientation);
  },

  inversePrevPose: function (prevPose) {
    quat.set(this.tmpOrientation, prevPose.orientation.x, prevPose.orientation.y, prevPose.orientation.z, prevPose.orientation.w);
    quat.conjugate(this.prevOrientationInv, this.tmpOrientation);
    vec3.set(this.tmpPosition, -prevPose.position.x, -prevPose.position.y, -prevPose.position.z);
    this.quaternionRotate(this.prevPositionInv, this.prevOrientationInv, this.tmpPosition);
  },

  onXRFrame: function (time, frame) {
    const renderer = this.sceneEl.renderer;
    if (!frame) return;

    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) return;

    const gl = renderer.getContext();

    if (this.prevPose) {
      this.inversePrevPose(this.prevPose.transform);
      this.layer.deltaPose = this.multiplyPrevPose(pose.transform);
    } else {
      this.layer.deltaPose = null;
    }
    this.prevPose = pose;

    const views = pose.views;
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const subImage = this.binding.getViewSubImage(this.layer, view);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.motionFramebuffer);
      if (i === 0 && this.mvExt) {
        this.mvExt.framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, subImage.motionVectorTexture, 0, 0, 2);
        this.mvExt.framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, subImage.depthStencilTexture, 0, 0, 2);
        gl.disable(gl.SCISSOR_TEST);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      }
      // Motion vector rendering should occur here
    }

    this.prevMatrices = views.map(v => ({
      projectionMatrix: mat4.clone(v.projectionMatrix),
      viewMatrix: mat4.clone(v.transform.inverse.matrix)
    }));
  },

  qQuat: quat.create(),
  aqQuat: quat.create(),
  aConj: quat.create(),
  aqaConj: quat.create(),
  tmpOrientation: quat.create(),
  tmpPosition: vec3.create(),
  currentOrientation: quat.create(),
  prevOrientationInv: quat.create(),
  prevPositionInv: vec3.create(),
  origLoop: null
});
